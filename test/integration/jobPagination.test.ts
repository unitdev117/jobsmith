import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import type { Database } from "../../src/db/pool.ts";
import { createLogger } from "../../src/observability/logger.ts";
import type { LocalProject } from "../../src/project/localConfig.ts";
import {
  ManualJobService,
  type WorkState,
} from "../../src/services/manualJobService.ts";

const url = process.env.TEST_DATABASE_URL;
const namespace = process.env.TEST_NAMESPACE;
const enabled = Boolean(
  url?.toLowerCase().includes("test") &&
  namespace &&
  /^[a-zA-Z0-9_-]+$/.test(namespace),
);

describe.skipIf(!enabled)("work item pagination", () => {
  const schema = `jobsmith_${namespace ?? "invalid"}_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = postgres(url ?? "postgresql://invalid", { max: 1 });
  const projectId = crypto.randomUUID();
  const hostId = crypto.randomUUID();
  let sql: Database;
  let jobs: ManualJobService;

  const project: LocalProject = {
    schemaVersion: 1,
    projectId,
    projectName: "Paging project",
    memberId: hostId,
    memberName: "Host",
    role: "HOST",
    machineId: crypto.randomUUID(),
    databaseUrl: url ?? "postgresql://invalid",
    valkeyUrl: "redis://127.0.0.1:6379",
  };

  const insertSeed = async (input: {
    state: WorkState;
    priority: number;
    createdAt: Date;
  }): Promise<string> => {
    const id = crypto.randomUUID();
    await sql`INSERT INTO jobsmith_work_items(id,project_id,title,description,priority,status,created_at)
      VALUES(${id},${projectId},${"Seed job"},${"Paging seed"},${input.priority},${input.state},${input.createdAt})`;
    return id;
  };

  // Driver parameters round-trip dates at millisecond precision, so
  // sub-millisecond seeds must be composed inside SQL.
  const insertMicroSeed = async (micros: number): Promise<string> => {
    const id = crypto.randomUUID();
    await sql`INSERT INTO jobsmith_work_items(id,project_id,title,description,priority,status,created_at)
      VALUES(${id},${projectId},${"Seed job"},${"Paging seed"},${3},'PENDING',
        (TIMESTAMPTZ '2026-03-01T00:00:00+00' + ${micros}::int * INTERVAL '1 microsecond'))`;
    return id;
  };

  beforeAll(async () => {
    await admin`CREATE SCHEMA ${admin(schema)}`;
    sql = postgres(url!, { max: 3, connection: { search_path: schema } });
    const directory = join(import.meta.dir, "../../src/db/migrations");
    for (const file of (await readdir(directory))
      .filter((name) => name.endsWith(".sql"))
      .sort())
      await sql.unsafe(await Bun.file(join(directory, file)).text());
    await sql`INSERT INTO jobsmith_projects(id,name) VALUES(${projectId},'Paging project')`;
    await sql`INSERT INTO jobsmith_members(id,project_id,name,role,machine_id)
      VALUES(${hostId},${projectId},'Host','HOST',${crypto.randomUUID()})`;
    jobs = new ManualJobService(
      sql,
      project,
      { publish: async (): Promise<void> => undefined },
      createLogger("pagination-integration", undefined, "silent"),
    );
    const states: WorkState[] = [
      ...Array<WorkState>(5).fill("BLOCKED"),
      ...Array<WorkState>(8).fill("IN_PROGRESS"),
      ...Array<WorkState>(6).fill("READY"),
      ...Array<WorkState>(6).fill("PENDING"),
    ];
    for (const [index, state] of states.entries())
      await insertSeed({
        state,
        priority: index % 10,
        createdAt: new Date(Date.UTC(2026, 0, 1) + index * 60_000),
      });
  }, 30_000);

  afterAll(async () => {
    if (sql) await sql.end();
    if (/^[a-zA-Z0-9_]+$/.test(schema))
      await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
    await admin.end();
  }, 30_000);

  const expectedOrder = async (): Promise<string[]> =>
    (
      await sql<{ id: string }[]>`
        SELECT id FROM jobsmith_work_items
        WHERE project_id=${projectId}
          AND status IN ('PENDING','READY','IN_PROGRESS','PAUSED','BLOCKED')
        ORDER BY CASE status WHEN 'BLOCKED' THEN 0 WHEN 'IN_PROGRESS' THEN 1 ELSE 2 END,
          priority DESC,created_at,id`
    ).map((row) => row.id);

  const walk = async (limit: number): Promise<string[]> => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 100; page++) {
      const result = await jobs.listPage({ limit, cursor });
      seen.push(...result.jobs.map((job) => job.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return seen;
  };

  test("walking pages of 5 covers every active job once in order", async () => {
    expect(await walk(5)).toEqual(await expectedOrder());
  });

  test("walking pages of 10 ends with a null cursor and no duplicates", async () => {
    const seen = await walk(10);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(await expectedOrder());
  });

  test("a higher-priority insert mid-walk does not shift later pages", async () => {
    const before = await expectedOrder();
    const firstPage = await jobs.listPage({ limit: 5 });
    expect(firstPage.jobs.map((job) => job.id)).toEqual(before.slice(0, 5));
    expect(firstPage.nextCursor).not.toBeNull();
    const insertedId = await insertSeed({
      state: "IN_PROGRESS",
      priority: 9,
      createdAt: new Date(Date.UTC(2025, 0, 1)),
    });
    const rest: string[] = [];
    let cursor: string | null = firstPage.nextCursor;
    for (let page = 0; page < 100 && cursor; page++) {
      const result = await jobs.listPage({ limit: 5, cursor });
      rest.push(...result.jobs.map((job) => job.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    const seen = [...firstPage.jobs.map((job) => job.id), ...rest];
    expect(new Set(seen).size).toBe(seen.length);
    // No duplicates, pre-existing relative order intact, newcomer placed once.
    expect(seen.filter((id) => id === insertedId)).toEqual([insertedId]);
    expect(seen.filter((id) => id !== insertedId)).toEqual(before);
  });

  test("clamps limits to 1..200 and treats an invalid cursor as page one", async () => {
    const huge = await jobs.listPage({ limit: 5000 });
    expect(huge.jobs.length).toBeGreaterThan(20);
    expect(huge.jobs).toEqual((await jobs.listPage()).jobs);
    expect((await jobs.listPage({ cursor: "garbage" })).jobs).toEqual(
      (await jobs.listPage()).jobs,
    );
  });

  test("microsecond timestamps do not duplicate across page boundaries", async () => {
    // clock_timestamp() style values: the boundary row's sub-millisecond
    // digits previously leaked it onto the next page via ISO truncation.
    // All four rows share one millisecond bucket, differing only in micros.
    const ids: string[] = [];
    for (const micros of [1, 2, 3, 4]) {
      ids.push(await insertMicroSeed(micros));
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 100; page++) {
      const result = await jobs.listPage({
        limit: 2,
        cursor,
        state: "PENDING",
      });
      seen.push(...result.jobs.map((job) => job.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    const boundaryGroup = seen.filter((id) => ids.includes(id));
    expect(boundaryGroup).toEqual(ids);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
