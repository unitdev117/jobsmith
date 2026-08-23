import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import type { Database } from "../../src/db/pool.ts";
import { createLogger } from "../../src/observability/logger.ts";
import { readJobs } from "../../src/project/jobCache.ts";
import type { LocalProject } from "../../src/project/localConfig.ts";
import { ManualJobService } from "../../src/services/manualJobService.ts";
import {
  decodeInvite,
  ProjectService,
} from "../../src/services/projectService.ts";

const url = process.env.TEST_DATABASE_URL;
const namespace = process.env.TEST_NAMESPACE;
const enabled = Boolean(
  url?.toLowerCase().includes("test") &&
  namespace &&
  /^[a-zA-Z0-9_-]+$/.test(namespace),
);

describe.skipIf(!enabled)("isolated PostgreSQL collaboration engine", () => {
  const schema = `jobsmith_${namespace ?? "invalid"}_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = postgres(url ?? "postgresql://invalid", { max: 1 });
  const projectId = crypto.randomUUID();
  const hostId = crypto.randomUUID();
  const workerId = crypto.randomUUID();
  const workerTwoId = crypto.randomUUID();
  let sql: Database;

  const project = (
    memberId: string,
    memberName: string,
    role: LocalProject["role"],
  ): LocalProject => ({
    schemaVersion: 1,
    projectId,
    projectName: "Integration project",
    memberId,
    memberName,
    role,
    machineId: crypto.randomUUID(),
    databaseUrl: url!,
    valkeyUrl: "redis://127.0.0.1:6379",
  });
  const notifier = { publish: async (): Promise<void> => undefined };

  beforeAll(async () => {
    await admin`CREATE SCHEMA ${admin(schema)}`;
    sql = postgres(url!, { max: 3, connection: { search_path: schema } });
    const directory = join(import.meta.dir, "../../src/db/migrations");
    for (const file of (await readdir(directory))
      .filter((name) => name.endsWith(".sql"))
      .sort())
      await sql.unsafe(await Bun.file(join(directory, file)).text());
    await sql`INSERT INTO jobsmith_projects(id,name) VALUES(${projectId},'Integration project')`;
    await sql`INSERT INTO jobsmith_members(id,project_id,name,role,machine_id) VALUES
      (${hostId},${projectId},'Host','HOST',${crypto.randomUUID()}),
      (${workerId},${projectId},'Worker','MEMBER',${crypto.randomUUID()}),
      (${workerTwoId},${projectId},'Worker Two','MEMBER',${crypto.randomUUID()})`;
  }, 30_000);

  afterAll(async () => {
    if (sql) await sql.end();
    if (/^[a-zA-Z0-9_]+$/.test(schema))
      await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
    await admin.end();
  }, 30_000);

  test("migration creates project-scoped work constraints", async () => {
    expect(
      (await sql`SELECT to_regclass('jobsmith_work_items')::text AS name`)[0]
        ?.name,
    ).toBe("jobsmith_work_items");
    // Bun's .rejects matcher never settles on postgres.js thenables, so
    // rejections are captured and asserted directly.
    const rejection =
      await sql`INSERT INTO jobsmith_work_items(id,project_id,title,description,priority,status)
      VALUES(${crypto.randomUUID()},${projectId},'Bad','priority',10,'PENDING')`.catch(
        (error: unknown) => error,
      );
    expect(rejection).toBeInstanceOf(Error);
  }, 60_000);

  test("a member owns work and every update remains auditable", async () => {
    const log = createLogger("manual-job-integration");
    const host = new ManualJobService(
      sql,
      project(hostId, "Host", "HOST"),
      notifier,
      log,
    );
    const worker = new ManualJobService(
      sql,
      project(workerId, "Worker", "MEMBER"),
      notifier,
      log,
    );
    const created = await host.create({
      title: "Prepare release notes",
      description: "Summarize the changes for the release",
      priority: 7,
      tags: ["release"],
      dueAt: null,
    });
    expect((await host.listPending()).jobs.map((job) => job.id)).toContain(
      created.id,
    );
    expect((await worker.claim(created.id)).assignedWorkerName).toBe("Worker");
    await worker.addNote(created.id, "Draft completed");
    await worker.setProgress(created.id, 60);
    await worker.saveSession(created.id);
    const owned = (await worker.listPending()).jobs;
    expect(owned.find((job) => job.id === created.id)?.progressPercent).toBe(
      60,
    );
    expect(owned.find((job) => job.id === created.id)?.assignedMemberId).toBe(
      workerId,
    );
    await worker.transition(created.id, "COMPLETED");

    expect(
      (
        await sql`SELECT status,progress_percent FROM jobsmith_work_items WHERE id=${created.id}`
      )[0],
    ).toMatchObject({
      status: "COMPLETED",
      progress_percent: 100,
    });
    expect(
      await sql`SELECT id FROM jobsmith_work_events WHERE work_item_id=${created.id}`,
    ).toHaveLength(6);
  }, 60_000);

  test("a cached job still has only one claim winner", async () => {
    const log = createLogger("claim-cache-integration");
    const host = new ManualJobService(
      sql,
      project(hostId, "Host", "HOST"),
      notifier,
      log,
    );
    const first = new ManualJobService(
      sql,
      project(workerId, "Worker", "MEMBER"),
      notifier,
      log,
    );
    const second = new ManualJobService(
      sql,
      project(workerTwoId, "Worker Two", "MEMBER"),
      notifier,
      log,
    );
    const created = await host.create({
      title: "Race-safe cache claim",
      description: "Prove cache does not participate in claims",
      priority: 5,
      tags: [],
      dueAt: null,
    });
    const roots = [
      await mkdtemp(join(tmpdir(), "jobsmith-machine-a-")),
      await mkdtemp(join(tmpdir(), "jobsmith-machine-b-")),
    ];
    try {
      await Promise.all(
        roots.map((root) => readJobs(root, () => host.listPending())),
      );
      const results = await Promise.allSettled([
        first.claim(created.id),
        second.claim(created.id),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const loser = results.find((result) => result.status === "rejected");
      expect(loser?.status === "rejected" ? loser.reason.message : "").toBe(
        "Job is no longer available",
      );
    } finally {
      await Promise.all(
        roots.map((root) => rm(root, { recursive: true, force: true })),
      );
    }
  }, 60_000);

  test("claiming a batch succeeds or fails per job inside one transaction", async () => {
    const log = createLogger("batch-claim-integration");
    const host = new ManualJobService(
      sql,
      project(hostId, "Host", "HOST"),
      notifier,
      log,
    );
    const first = new ManualJobService(
      sql,
      project(workerId, "Worker", "MEMBER"),
      notifier,
      log,
    );
    const second = new ManualJobService(
      sql,
      project(workerTwoId, "Worker Two", "MEMBER"),
      notifier,
      log,
    );
    const shared = await host.create({
      title: "Contended batch job",
      description: "Taken by the first worker before the batch",
      priority: 5,
      tags: [],
      dueAt: null,
    });
    const free = await host.create({
      title: "Free batch job",
      description: "Available for the batch",
      priority: 5,
      tags: [],
      dueAt: null,
    });
    await second.claim(shared.id);
    const { claimed, failures } = await first.claimMany([shared.id, free.id]);
    expect(claimed.map((job) => job.id)).toEqual([free.id]);
    expect(failures).toEqual([
      { id: shared.id, reason: "Job is no longer available" },
    ]);
  }, 60_000);

  test("cancellation covers unclaimed pending work and own claimed work only", async () => {
    const log = createLogger("cancel-integration");
    const host = new ManualJobService(
      sql,
      project(hostId, "Host", "HOST"),
      notifier,
      log,
    );
    const worker = new ManualJobService(
      sql,
      project(workerId, "Worker", "MEMBER"),
      notifier,
      log,
    );
    const unclaimed = await host.create({
      title: "Cancel me while pending",
      description: "Anyone may cancel an unclaimed job",
      priority: 3,
      tags: [],
      dueAt: null,
    });
    const cancelled = await worker.cancel(unclaimed.id);
    expect(cancelled.state).toBe("CANCELLED");

    const claimed = await host.create({
      title: "Cancel me after claiming",
      description: "Only the owner may cancel claimed work",
      priority: 3,
      tags: [],
      dueAt: null,
    });
    await worker.claim(claimed.id);
    await worker.transition(claimed.id, "PAUSED");
    const refusal = await new ManualJobService(
      sql,
      project(workerTwoId, "Worker Two", "MEMBER"),
      notifier,
      log,
    )
      .cancel(claimed.id)
      .catch((error: unknown) => error);
    expect((refusal as Error).message).toContain("can be cancelled");
    await worker.cancel(claimed.id);
    const [row] = await sql`SELECT status FROM jobsmith_work_items
      WHERE id=${claimed.id}`;
    expect(row?.status).toBe("CANCELLED");
    const events = await sql`SELECT event_type,to_status,metadata
      FROM jobsmith_work_events WHERE work_item_id=${claimed.id}
      ORDER BY id`;
    expect(events.at(-1)).toMatchObject({
      to_status: "CANCELLED",
      metadata: { cancelled: true },
    });
  }, 60_000);

  test("connection strings can be redeemed only once", async () => {
    const host = project(hostId, "Host", "HOST");
    const projects = new ProjectService(
      sql,
      createLogger("invite-integration"),
    );
    const encoded = await projects.createInvite(host, 5);
    const invite = decodeInvite(encoded.value);
    const joined = await projects.join({
      invite,
      memberName: "Agent",
      role: "AGENT",
    });
    expect(joined.projectId).toBe(projectId);
    expect(joined.role).toBe("AGENT");
    const replay = await projects
      .join({ invite, memberName: "Replay", role: "MEMBER" })
      .catch((error: unknown) => error);
    expect((replay as Error).message).toContain(
      "invalid, expired, or already used",
    );
  }, 60_000);

  test("expired claim leases release work to other workers", async () => {
    const log = createLogger("lease-integration");
    const host = new ManualJobService(
      sql,
      project(hostId, "Host", "HOST"),
      notifier,
      log,
    );
    const first = new ManualJobService(
      sql,
      project(workerId, "Worker", "MEMBER"),
      notifier,
      log,
      1,
    );
    const second = new ManualJobService(
      sql,
      project(workerTwoId, "Worker Two", "MEMBER"),
      notifier,
      log,
      1,
    );
    const created = await host.create({
      title: "Lease takeover target",
      description: "Abandoned claims must return to the pool",
      priority: 4,
      tags: [],
      dueAt: null,
    });
    await first.claim(created.id);

    // Live lease: nobody else can take it.
    const refused = await second
      .claim(created.id)
      .catch((error: unknown) => error);
    expect((refused as Error).message).toContain("no longer available");

    // Owner touches keep the lease alive; expiry only after silence.
    const before = (
      await sql`SELECT claimed_until FROM jobsmith_work_items WHERE id=${created.id}`
    )[0]!.claimed_until as Date;
    await first.addNote(created.id, "still working");
    const refreshed = (
      await sql`SELECT claimed_until FROM jobsmith_work_items WHERE id=${created.id}`
    )[0]!.claimed_until as Date;
    expect(refreshed.getTime()).toBeGreaterThan(before.getTime());

    await sql`
      UPDATE jobsmith_work_items SET claimed_until=clock_timestamp()-INTERVAL '1 minute'
      WHERE id=${created.id}`;
    const takenOver = await second.claim(created.id);
    expect(takenOver.assignedMemberId).toBe(workerTwoId);
    const [row] = await sql`SELECT assigned_member_id FROM jobsmith_work_items
      WHERE id=${created.id}`;
    expect(row?.assigned_member_id).toBe(workerTwoId);
  }, 60_000);
});
