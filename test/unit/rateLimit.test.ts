import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createLogger } from "../../src/observability/logger.ts";
import type { LocalProject } from "../../src/project/localConfig.ts";
import { createApp } from "../../src/server/app.ts";
import type { RateLimitCounter } from "../../src/server/middleware/rateLimit.ts";
import { rateLimiter } from "../../src/server/middleware/rateLimit.ts";
import { resolveRateLimit } from "../../src/server/settings.ts";
import { unusedJobBoard } from "./jobBoardStub.ts";

const log = createLogger("rate-limit-test", undefined, "silent");

interface MemoryCounter extends RateLimitCounter {
  keys: string[];
  counts: Map<string, number>;
  expires: [string, number][];
}

function memoryCounter(): MemoryCounter {
  const counts = new Map<string, number>();
  const expires: [string, number][] = [];
  return {
    keys: [],
    counts,
    expires,
    async incr(key) {
      this.keys.push(key);
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
    async expire(key, seconds) {
      expires.push([key, seconds]);
    },
  };
}

// Epoch-aligned base (multiple of 60s) so windows begin exactly here.
const BASE_MS = 1_700_000_040_000;

function limitedApp(
  counter: MemoryCounter,
  options: { limit?: number; failIncr?: boolean } = {},
): Hono {
  const app = new Hono();
  app.use(
    "/api/*",
    rateLimiter({
      counter: options.failIncr
        ? {
            incr: async () => {
              throw new Error("valkey down");
            },
            expire: async () => undefined,
          }
        : counter,
      projectId: "proj-1",
      limit: options.limit ?? 3,
      log,
      now: () => BASE_MS,
    }),
  );
  app.get("/api/ping", (c) => c.json({ ok: true }));
  return app;
}

describe("fixed-window rate limiter", () => {
  test("requests under the limit pass with correct headers", async () => {
    const counter = memoryCounter();
    const app = limitedApp(counter);
    const first = await app.request("/api/ping");
    expect(first.status).toBe(200);
    expect(first.headers.get("x-ratelimit-limit")).toBe("3");
    expect(first.headers.get("x-ratelimit-remaining")).toBe("2");

    const second = await app.request("/api/ping");
    expect(second.headers.get("x-ratelimit-remaining")).toBe("1");
  });

  test("the window key is project, window index, and client ip", async () => {
    const counter = memoryCounter();
    const app = limitedApp(counter);
    await app.request("/api/ping");
    const windowIndex = Math.floor(BASE_MS / 60_000);
    expect(counter.keys[0]).toBe(`jobsmith:proj-1:rl:${windowIndex}:local`);
  });

  test("expiry is set exactly once on the first increment", async () => {
    const counter = memoryCounter();
    const app = limitedApp(counter);
    await app.request("/api/ping");
    await app.request("/api/ping");
    expect(counter.expires).toHaveLength(1);
    expect(counter.expires[0]?.[1]).toBe(60);
  });

  test("over-limit requests are blocked with Retry-After until the next window", async () => {
    const counter = memoryCounter();
    let tick = BASE_MS;
    const app = new Hono();
    app.use(
      "/api/*",
      rateLimiter({
        counter,
        projectId: "proj-1",
        limit: 2,
        log,
        now: () => tick,
      }),
    );
    app.get("/api/ping", (c) => c.json({ ok: true }));

    expect((await app.request("/api/ping")).status).toBe(200);
    expect((await app.request("/api/ping")).status).toBe(200);

    const blocked = await app.request("/api/ping");
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: "rate_limited" });
    expect(blocked.headers.get("retry-after")).toBe("60");
    // Remaining floors at zero instead of going negative.
    expect(blocked.headers.get("x-ratelimit-remaining")).toBe("0");

    tick += 60_000;
    const nextWindow = await app.request("/api/ping");
    expect(nextWindow.status).toBe(200);
    expect(nextWindow.headers.get("x-ratelimit-remaining")).toBe("1");
  });

  test("Retry-After reports seconds remaining in the current window", async () => {
    const counter = memoryCounter();
    let tick = BASE_MS + 17_000;
    const app = new Hono();
    app.use(
      "/api/*",
      rateLimiter({
        counter,
        projectId: "proj-1",
        limit: 0,
        log,
        now: () => tick,
      }),
    );
    app.get("/api/ping", (c) => c.json({ ok: true }));
    const response = await app.request("/api/ping");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("43");
  });

  test("a broken backend fails open without rate limit headers", async () => {
    const app = limitedApp(memoryCounter(), { failIncr: true });
    const response = await app.request("/api/ping");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratelimit-limit")).toBeNull();
  });
});

describe("serve rate limit wiring", () => {
  test("exempt paths skip the counter while API routes are counted", async () => {
    const counter = memoryCounter();
    const log = createLogger("rate-limit-app-test", undefined, "silent");
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
    const app = createApp({
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
      rateCounter: counter,
      rateLimit: 5,
    });

    const health = await app.request("/healthz");
    expect(health.status).toBe(200);
    expect(health.headers.get("x-ratelimit-limit")).toBeNull();

    const dashboard = await app.request("/");
    expect(dashboard.status).toBe(200);
    expect(counter.keys).toHaveLength(0);

    const events = await app.request("/api/events");
    await events.body?.getReader().cancel();
    expect(counter.keys).toHaveLength(0);

    const jobs = await app.request("/api/jobs");
    expect(jobs.status).toBe(200);
    expect(jobs.headers.get("x-ratelimit-limit")).toBe("5");
    expect(counter.keys).toHaveLength(1);
  });

  test("JOBSMITH_RATE_LIMIT parses or rejects env values", () => {
    expect(resolveRateLimit({})).toBe(120);
    expect(resolveRateLimit({ JOBSMITH_RATE_LIMIT: "30" })).toBe(30);
    expect(() => resolveRateLimit({ JOBSMITH_RATE_LIMIT: "0" })).toThrow(
      /positive integer/,
    );
    expect(() => resolveRateLimit({ JOBSMITH_RATE_LIMIT: "abc" })).toThrow(
      /positive integer/,
    );
  });
});
