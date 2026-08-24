import { describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { createLogger } from "../../src/observability/logger.ts";
import { createApp } from "../../src/server/app.ts";
import type { LocalProject } from "../../src/project/localConfig.ts";
import { ServiceError } from "../../src/services/errors.ts";
import { JobStore } from "../../src/server/jobStore.ts";
import { unusedJobBoard } from "./jobBoardStub.ts";
import type {
  JobPage,
  ManualJob,
  WorkState,
} from "../../src/services/manualJobService.ts";

const log = createLogger("server-jobs-test", undefined, "silent");

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

const job: ManualJob = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Write the report",
  description: "Summarize quarterly results",
  priority: 5,
  state: "PENDING",
  progressPercent: 0,
  assignedMemberId: null,
  assignedWorkerName: null,
  tags: ["docs"],
  dueAt: null,
  blockedReason: null,
  claimedUntil: null,
  createdAt: new Date("2026-08-13T10:00:00.000Z"),
  updatedAt: new Date("2026-08-13T11:00:00.000Z"),
};

type AppDeps = Parameters<typeof createApp>[0];
type JobsDeps = AppDeps["jobs"];
type InvitesDeps = AppDeps["invites"];

interface RecordedCalls {
  listPageCalls: Record<string, unknown>[];
  countAllCalls: (WorkState | undefined)[];
  createCalls: Record<string, unknown>[];
  updateCalls: [string, Record<string, unknown>][];
  cancelCalls: string[];
  claimCalls: string[];
  transitionCalls: [string, string, string | undefined][];
  progressCalls: [string, number][];
  noteCalls: [string, string][];
}

function fakeJobs(
  overrides: {
    listPage?: () => Promise<JobPage>;
    countAll?: () => Promise<number>;
    update?: () => Promise<ManualJob>;
    cancel?: () => Promise<ManualJob>;
    claim?: () => Promise<ManualJob>;
  } = {},
): JobsDeps & RecordedCalls {
  const calls: RecordedCalls = {
    listPageCalls: [],
    countAllCalls: [],
    createCalls: [],
    updateCalls: [],
    cancelCalls: [],
    claimCalls: [],
    transitionCalls: [],
    progressCalls: [],
    noteCalls: [],
  };
  return {
    ...calls,
    listPage: async (options = {}) => {
      calls.listPageCalls.push({ ...options });
      return overrides.listPage
        ? await overrides.listPage()
        : { jobs: [job], nextCursor: null };
    },
    countAll: async (state) => {
      calls.countAllCalls.push(state);
      return overrides.countAll ? await overrides.countAll() : 7;
    },
    create: async (input) => {
      calls.createCalls.push({ ...input });
      return job;
    },
    update: async (id, patch) => {
      calls.updateCalls.push([id, patch]);
      return overrides.update ? await overrides.update() : job;
    },
    cancel: async (id) => {
      calls.cancelCalls.push(id);
      return overrides.cancel ? await overrides.cancel() : job;
    },
    claim: async (id) => {
      calls.claimCalls.push(id);
      return overrides.claim ? await overrides.claim() : job;
    },
    transition: async (id, outcome, message) => {
      calls.transitionCalls.push([id, outcome, message]);
    },
    setProgress: async (id, progress) => {
      calls.progressCalls.push([id, progress]);
    },
    addNote: async (id, note) => {
      calls.noteCalls.push([id, note]);
    },
  };
}

const fakeInvites = (behavior: "ok" | "forbidden" = "ok"): InvitesDeps => ({
  createInvite: async () => {
    if (behavior === "forbidden")
      throw new ServiceError(
        403,
        "Only the project host can create connection strings",
      );
    return {
      value: "jsm1_invite-payload",
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
    };
  },
});

function buildApp(overrides: Partial<AppDeps> = {}): Hono {
  return createApp({
    project,
    jobs: fakeJobs(),
    invites: fakeInvites(),
    members: {
      listMembers: async (): Promise<
        { memberId: string; name: string; role: "HOST"; joinedAt: Date }[]
      > => [],
    },
    presence: async (): Promise<null> => null,
    events: {
      start: async (): Promise<void> => undefined,
      onChange: (): (() => void) => () => undefined,
      close: async (): Promise<void> => undefined,
    },
    log,
    ...overrides,
  });
}

describe("local API routes", () => {
  test("healthz answers without auth or services", async () => {
    const response = await buildApp().request("/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("project endpoint exposes identity from the local project", async () => {
    const response = await buildApp().request("/api/project");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      projectId: project.projectId,
      projectName: "Test project",
      me: {
        memberId: project.memberId,
        memberName: "Me",
        role: "HOST",
      },
    });
  });

  test("jobs list forwards paging query params and serializes dates", async () => {
    const jobs = fakeJobs();
    const response = await buildApp({ jobs }).request(
      "/api/jobs?limit=7&cursor=abc&state=BLOCKED",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      jobs: { updatedAt: string }[];
      nextCursor: string | null;
    };
    expect(body.jobs[0]?.updatedAt).toBe("2026-08-13T11:00:00.000Z");
    expect(body.nextCursor).toBeNull();
    expect(jobs.listPageCalls).toEqual([
      { limit: 7, cursor: "abc", state: "BLOCKED" },
    ]);
  });

  test("count=true answers with the project-wide total only", async () => {
    const jobs = fakeJobs({ countAll: async () => 42 });
    const response = await buildApp({ jobs }).request("/api/jobs?count=true");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ total: 42 });
    expect(jobs.countAllCalls).toEqual([undefined]);
    expect(jobs.listPageCalls).toEqual([]);
  });

  test("count=true forwards the requested state for exact per-state totals", async () => {
    const jobs = fakeJobs();
    const filtered = await buildApp({ jobs }).request(
      "/api/jobs?state=PENDING&count=true",
    );
    expect(filtered.status).toBe(200);
    expect(await filtered.json()).toEqual({ total: 7 });
    expect(jobs.countAllCalls).toEqual(["PENDING"]);

    const unfiltered = await buildApp({ jobs }).request("/api/jobs?count=true");
    expect(unfiltered.status).toBe(200);
    expect(await unfiltered.json()).toEqual({ total: 7 });
    expect(jobs.countAllCalls).toEqual(["PENDING", undefined]);
  });

  test("jobs list rejects unknown states and out-of-range limits", async () => {
    const app = buildApp();
    for (const query of ["?state=SLEEPING", "?limit=0", "?limit=201"]) {
      const response = await app.request(`/api/jobs${query}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        error: string;
        details: string[];
      };
      expect(body.error).toBe("validation_failed");
      expect(body.details.length).toBeGreaterThan(0);
    }
  });

  test("job creation applies defaults and deduplicates tags", async () => {
    const jobs = fakeJobs();
    const response = await buildApp({ jobs }).request("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Ship it",
        description: "Do the work",
        tags: ["a", "b", "a"],
      }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(JSON.parse(JSON.stringify(job)));
    expect(jobs.createCalls).toEqual([
      {
        title: "Ship it",
        description: "Do the work",
        priority: 5,
        tags: ["a", "b"],
        dueAt: null,
      },
    ]);
  });

  test("job creation reports validation failures with field paths", async () => {
    const response = await buildApp().request("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "", priority: 12 }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      details: string[];
    };
    expect(body.error).toBe("validation_failed");
    expect(body.details.some((detail) => detail.startsWith("title"))).toBe(
      true,
    );
    expect(body.details.some((detail) => detail.startsWith("priority"))).toBe(
      true,
    );
  });

  test("patch forwards only provided fields and maps service errors", async () => {
    const jobs = fakeJobs();
    const ok = await buildApp({ jobs }).request("/api/jobs/abc", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ priority: 3 }),
    });
    expect(ok.status).toBe(200);
    expect(jobs.updateCalls).toEqual([["abc", { priority: 3 }]]);

    const conflict = await buildApp({
      jobs: fakeJobs({
        update: async () => {
          throw new ServiceError(
            409,
            "Only unclaimed pending jobs or your own claimed jobs can be edited",
          );
        },
      }),
    }).request("/api/jobs/abc", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ priority: 3 }),
    });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: string }).error).toContain(
      "can be edited",
    );

    const missing = await buildApp({
      jobs: fakeJobs({
        update: async () => {
          throw new ServiceError(404, "Work item not found");
        },
      }),
    }).request("/api/jobs/nope", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(missing.status).toBe(404);
  });

  test("cancel delegates to the service and surfaces rule violations", async () => {
    const jobs = fakeJobs();
    const ok = await buildApp({ jobs }).request("/api/jobs/abc/cancel", {
      method: "POST",
    });
    expect(ok.status).toBe(200);
    expect(jobs.cancelCalls).toEqual(["abc"]);

    const conflict = await buildApp({
      jobs: fakeJobs({
        cancel: async () => {
          throw new ServiceError(
            409,
            "Only unclaimed pending jobs or your own claimed jobs can be cancelled",
          );
        },
      }),
    }).request("/api/jobs/abc/cancel", { method: "POST" });
    expect(conflict.status).toBe(409);
  });

  test("invite creation is host-only and returns the connection payload", async () => {
    const ok = await buildApp().request("/api/invites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ttlMinutes: 30 }),
    });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toEqual({
      connectionString: "jsm1_invite-payload",
      expiresAt: "2026-09-01T00:00:00.000Z",
    });

    const forbidden = await buildApp({
      invites: fakeInvites("forbidden"),
    }).request("/api/invites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(forbidden.status).toBe(403);
  });

  test("unknown routes answer with a bare not_found", async () => {
    const response = await buildApp().request("/api/nope");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  test("unhandled failures become opaque internal errors", async () => {
    const response = await buildApp({
      jobs: fakeJobs({
        listPage: async () => {
          throw new Error("database exploded");
        },
      }),
    }).request("/api/jobs");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
  });
});

describe("serve token auth", () => {
  test("requests without a valid bearer token are rejected", async () => {
    const app = buildApp({ serveToken: "sekrit" });
    const missing = await app.request("/api/project");
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "unauthorized" });

    const wrong = await app.request("/api/project", {
      headers: { authorization: "Bearer nope" },
    });
    expect(wrong.status).toBe(401);

    const health = await app.request("/healthz");
    expect(health.status).toBe(200);

    const good = await app.request("/api/project", {
      headers: { authorization: "Bearer sekrit" },
    });
    expect(good.status).toBe(200);
  });

  test("without a configured token the API trusts localhost", async () => {
    const response = await buildApp().request("/api/project");
    expect(response.status).toBe(200);
  });
});

describe("description markdown over HTTP", () => {
  // Production serves reads through JobStore, so the harness wraps the fake
  // board the same way; mutations flow store -> board -> reload.
  const rawWrapped = "{# Hi\n\n[bad](javascript:x)}";
  let current: ManualJob;

  const buildStoreApp = async (): Promise<Hono> => {
    current = { ...job, description: rawWrapped };
    const board = unusedJobBoard({
      countAll: async () => 1,
      listPage: async () => ({ jobs: [current], nextCursor: null }),
      create: async () => current,
      update: async (_id, patch) => {
        current = { ...current, ...(patch as Partial<ManualJob>) };
        return current;
      },
    });
    const store = new JobStore({
      jobs: board,
      bus: {
        start: async (): Promise<void> => undefined,
        onChange: (): (() => void) => () => undefined,
        close: async (): Promise<void> => undefined,
      },
      log,
    });
    await store.start();
    return buildApp({ jobs: store });
  };

  test("create responses stay service-shaped without the html field", async () => {
    const app = await buildStoreApp();
    const created = await app.request("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Md job", description: rawWrapped }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      description: string;
      descriptionHtml?: string;
    };
    expect(body.descriptionHtml).toBeUndefined();
    expect(body.description).toBe(rawWrapped);
  });

  test("listings carry raw bytes plus sanitized html for wrapped rows", async () => {
    const app = await buildStoreApp();
    await app.request("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Md job", description: rawWrapped }),
    });
    const listed = await app.request("/api/jobs");
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      jobs: { description: string; descriptionHtml?: string }[];
    };
    expect(body.jobs[0]!.description).toBe(rawWrapped);
    expect(body.jobs[0]!.descriptionHtml).toContain("<h1>");
    expect(body.jobs[0]!.descriptionHtml).not.toContain("javascript:");
  });

  test("patching wrapped back to plain flips the field off", async () => {
    const app = await buildStoreApp();
    await app.request("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Md job", description: rawWrapped }),
    });
    const patched = await app.request(`/api/jobs/${job.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "plain words again" }),
    });
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()) as {
      description: string;
      descriptionHtml?: string;
    };
    expect(patchedBody.descriptionHtml).toBeUndefined();

    const listed = await app.request("/api/jobs");
    const body = (await listed.json()) as {
      jobs: { description: string; descriptionHtml?: string }[];
    };
    expect("descriptionHtml" in body.jobs[0]!).toBe(false);
    expect(body.jobs[0]!.description).toBe("plain words again");
  });
});
