import { unusedJobBoard } from "./jobBoardStub.ts";
import { describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { createLogger } from "../../src/observability/logger.ts";
import type { LocalProject } from "../../src/project/localConfig.ts";
import { createApp } from "../../src/server/app.ts";

const log = createLogger("dashboard-assets-test", undefined, "silent");

const project: LocalProject = {
  schemaVersion: 1,
  projectId: "22222222-2222-4222-8222-222222222222",
  projectName: "Test project",
  memberId: "33333333-3333-4333-8333-333333333333",
  memberName: "Me",
  role: "HOST",
  machineId: "44444444-4444-4444-8444-444444444444",
  databaseUrl: "postgresql://user:pass@localhost/jobsmith",
  valkeyUrl: "redis://localhost:6379",
};

function buildApp(): Hono {
  return createApp({
    project,
    jobs: unusedJobBoard(),
    invites: {
      createInvite: async () => {
        throw new Error("not used");
      },
    },
    members: { listMembers: async () => [] },
    presence: async () => null,
    events: {
      start: async (): Promise<void> => undefined,
      onChange: () => () => undefined,
      close: async (): Promise<void> => undefined,
    },
    log,
  });
}

describe("dashboard static assets", () => {
  test("the root serves the dashboard shell with its mount points", async () => {
    const response = await buildApp().request("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    for (const id of [
      "project-name",
      "member-list",
      "jobs-body",
      "job-dialog",
      "filter-chips",
    ])
      expect(html).toContain(`id="${id}"`);
  });

  test("javascript modules are served as scripts", async () => {
    const app = buildApp();
    for (const name of ["api", "sse", "ui", "main"]) {
      const response = await app.request(`/js/${name}.js`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("javascript");
    }
  });

  test("stylesheets are served as css", async () => {
    const response = await buildApp().request("/styles.css");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/css");
  });

  test("missing assets fall through to the API not-found body", async () => {
    const response = await buildApp().request("/js/nope.js");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });
});
