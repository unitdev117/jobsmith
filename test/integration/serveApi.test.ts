import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Hono } from "hono";
import postgres from "postgres";
import type { Database } from "../../src/db/pool.ts";
import { readPresence } from "../../src/coordination/presence.ts";
import { createLogger } from "../../src/observability/logger.ts";
import type { LocalProject } from "../../src/project/localConfig.ts";
import { createApp } from "../../src/server/app.ts";
import type { EventEnvelope } from "../../src/server/events.ts";
import { ManualJobService } from "../../src/services/manualJobService.ts";
import { ProjectService } from "../../src/services/projectService.ts";

const url = process.env.TEST_DATABASE_URL;
const namespace = process.env.TEST_NAMESPACE;
const enabled = Boolean(
  url?.toLowerCase().includes("test") &&
  namespace &&
  /^[a-zA-Z0-9_-]+$/.test(namespace),
);

describe.skipIf(!enabled)("local HTTP API against PostgreSQL", () => {
  const schema = `jobsmith_${namespace ?? "invalid"}_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = postgres(url ?? "postgresql://invalid", { max: 1 });
  const projectId = crypto.randomUUID();
  const hostId = crypto.randomUUID();
  let sql: Database;
  let app: Hono;
  // Captured change listeners so tests can simulate delivered SSE frames.
  const changeHandlers = new Set<(envelope: EventEnvelope) => void>();

  const project: LocalProject = {
    schemaVersion: 1,
    projectId,
    projectName: "Serve project",
    memberId: hostId,
    memberName: "Host",
    role: "HOST",
    machineId: crypto.randomUUID(),
    databaseUrl: url ?? "postgresql://invalid",
    valkeyUrl: "redis://127.0.0.1:6379",
  };

  beforeAll(async () => {
    await admin`CREATE SCHEMA ${admin(schema)}`;
    sql = postgres(url!, { max: 3, connection: { search_path: schema } });
    const directory = join(import.meta.dir, "../../src/db/migrations");
    for (const file of (await readdir(directory))
      .filter((name) => name.endsWith(".sql"))
      .sort())
      await sql.unsafe(await Bun.file(join(directory, file)).text());
    await sql`INSERT INTO jobsmith_projects(id,name) VALUES(${projectId},'Serve project')`;
    await sql`INSERT INTO jobsmith_members(id,project_id,name,role,machine_id)
      VALUES(${hostId},${projectId},'Host','HOST',${crypto.randomUUID()})`;
    const log = createLogger("serve-api-integration", undefined, "silent");
    app = createApp({
      project,
      jobs: new ManualJobService(
        sql,
        project,
        { publish: async (): Promise<void> => undefined },
        log,
      ),
      invites: new ProjectService(sql, log),
      members: new ProjectService(sql, log),
      presence: (projectId) => readPresence(project.valkeyUrl, projectId, log),
      events: {
        start: async (): Promise<void> => undefined,
        onChange: (handler) => {
          changeHandlers.add(handler);
          return () => changeHandlers.delete(handler);
        },
        close: async (): Promise<void> => undefined,
      },
      log,
    });
  }, 30_000);

  afterAll(async () => {
    if (sql) await sql.end();
    if (/^[a-zA-Z0-9_]+$/.test(schema))
      await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
    await admin.end();
  }, 30_000);

  test("create, list paged, update, and cancel work end to end", async () => {
    const created = await app.request("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Integration job",
        description: "Created through the API",
        priority: 8,
        tags: ["api", "integration"],
      }),
    });
    expect(created.status).toBe(201);
    const job = (await created.json()) as {
      id: string;
      state: string;
      priority: number;
      tags: string[];
    };
    expect(job.state).toBe("PENDING");
    expect(job.priority).toBe(8);

    for (let index = 0; index < 7; index++) {
      await app.request("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: `Filler ${index}`,
          description: "Padding for pagination",
        }),
      });
    }

    const firstPage = await app.request("/api/jobs?limit=5");
    expect(firstPage.status).toBe(200);
    const page = (await firstPage.json()) as {
      jobs: { id: string }[];
      nextCursor: string | null;
    };
    expect(page.jobs).toHaveLength(5);
    expect(page.nextCursor).not.toBeNull();
    expect(page.jobs.some((entry) => entry.id === job.id)).toBe(true);

    const secondPage = await app.request(
      `/api/jobs?limit=5&cursor=${encodeURIComponent(page.nextCursor!)}`,
    );
    const rest = (await secondPage.json()) as {
      jobs: { id: string }[];
      nextCursor: string | null;
    };
    const seen = [...page.jobs, ...rest.jobs].map((entry) => entry.id);
    expect(new Set(seen).size).toBe(seen.length);

    const updated = await app.request(`/api/jobs/${job.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed by API", priority: 2 }),
    });
    expect(updated.status).toBe(200);
    const edited = (await updated.json()) as {
      title: string;
      priority: number;
      tags: string[];
    };
    expect(edited.title).toBe("Renamed by API");
    expect(edited.priority).toBe(2);
    expect(edited.tags).toEqual(["api", "integration"]);

    const events =
      await sql`SELECT event_type,metadata FROM jobsmith_work_events
      WHERE work_item_id=${job.id} AND event_type='WORK_UPDATED'`;
    expect(events[0]?.metadata).toEqual({
      changed: ["title", "priority"],
    });

    const cancelled = await app.request(`/api/jobs/${job.id}/cancel`, {
      method: "POST",
    });
    expect(cancelled.status).toBe(200);
    expect(((await cancelled.json()) as { state: string }).state).toBe(
      "CANCELLED",
    );

    const again = await app.request(`/api/jobs/${job.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Too late" }),
    });
    expect(again.status).toBe(409);
  }, 60_000);

  test("the host can mint connection strings through the API", async () => {
    const response = await app.request("/api/invites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      connectionString: string;
      expiresAt: string;
    };
    expect(body.connectionString.startsWith("jsm1_")).toBe(true);
  });

  test("members endpoint surfaces database roles and degrades without presence", async () => {
    await sql`INSERT INTO jobsmith_members(id,project_id,name,role,machine_id)
      VALUES(${crypto.randomUUID()},${projectId},'Agent','AGENT',${crypto.randomUUID()})`;
    const response = await app.request("/api/members");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      memberId: string;
      name: string;
      role: string;
      online: boolean;
    }[];
    const roles = body.map((entry) => [entry.name, entry.role]);
    expect(roles).toContainEqual(["Host", "HOST"]);
    expect(roles).toContainEqual(["Agent", "AGENT"]);
    // No daemon is running for this project, so nobody holds a presence key.
    expect(body.every((entry) => !entry.online)).toBe(true);
  });

  test("a created job reaches an attached SSE client and its refetch", async () => {
    // Attach like a browser would; the stream stays open until cancelled.
    const stream = await app.request("/api/events");
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const readFrame = async (): Promise<string> => {
      while (!buffered.includes("\n\n")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffered += decoder.decode(chunk.value, { stream: true });
      }
      const separator = buffered.indexOf("\n\n");
      const frame = buffered.slice(0, separator);
      buffered = buffered.slice(separator + 2);
      return frame;
    };

    const ready = await readFrame();
    expect(ready).toContain("event: ready");
    expect(changeHandlers.size).toBe(1);

    const created = await app.request("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Dashboard smoke",
        description: "Visible after the event-driven refetch",
      }),
    });
    expect(created.status).toBe(201);
    const job = (await created.json()) as { id: string };

    // No daemon publishes here, so deliver the envelope like Valkey would.
    for (const handler of changeHandlers)
      handler({
        type: "work.created",
        workItemId: job.id,
        occurredAt: new Date().toISOString(),
      });
    const change = await readFrame();
    expect(change).toContain("event: change");
    const dataLine = change
      .split("\n")
      .find((line) => line.startsWith("data: "));
    expect(JSON.parse(dataLine!.slice(6)).workItemId).toBe(job.id);

    // What the dashboard's debounced refetch performs after the frame lands.
    const listed = await app.request("/api/jobs");
    const body = (await listed.json()) as { jobs: { id: string }[] };
    expect(body.jobs.some((entry) => entry.id === job.id)).toBe(true);

    await reader.cancel();
  });
});
