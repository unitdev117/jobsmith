import { unusedJobBoard } from "./jobBoardStub.ts";
import { describe, expect, test } from "bun:test";
import { createLogger } from "../../src/observability/logger.ts";
import type { LocalProject } from "../../src/project/localConfig.ts";
import { createApp } from "../../src/server/app.ts";
import { MetricsRegistry, normalizeRoute } from "../../src/server/metrics.ts";

const log = createLogger("metrics-test", undefined, "silent");

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

describe("MetricsRegistry", () => {
  test("counters render grouped samples under HELP and TYPE lines", () => {
    const registry = new MetricsRegistry();
    const counter = registry.counter("http_requests_total", [
      "method",
      "status",
    ]);
    counter.inc({ method: "GET", status: "200" });
    counter.inc({ method: "GET", status: "200" });
    counter.inc({ method: "POST", status: "201" });
    const output = registry.render();
    const lines = output.split("\n");
    expect(lines[0]).toBe("# HELP http_requests_total http_requests_total");
    expect(lines[1]).toBe("# TYPE http_requests_total counter");
    expect(output).toContain(
      'http_requests_total{method="GET",status="200"} 2',
    );
    expect(output).toContain(
      'http_requests_total{method="POST",status="201"} 1',
    );
  });

  test("increments accumulate monotonically and ignore negative amounts", () => {
    const registry = new MetricsRegistry();
    const counter = registry.counter("events_total");
    counter.inc();
    counter.inc(undefined, 4);
    counter.inc(undefined, -10);
    expect(registry.render()).toContain("events_total 5");
  });

  test("label values are escaped in exposition output", () => {
    const registry = new MetricsRegistry();
    const counter = registry.counter("weird_total", ["path"]);
    counter.inc({ path: 'a"b\\c\nd' });
    expect(registry.render()).toContain('weird_total{path="a\\"b\\\\c\\nd"} 1');
  });

  test("gauges set, get, and render as gauge type", () => {
    const registry = new MetricsRegistry();
    const gauge = registry.gauge("sse_clients_connected");
    expect(gauge.get()).toBe(0);
    gauge.set(3);
    gauge.set(2);
    expect(gauge.get()).toBe(2);
    const output = registry.render();
    expect(output).toContain("# TYPE sse_clients_connected gauge");
    expect(output).toContain("sse_clients_connected 2");
  });

  test("uptime is computed at render time from the injected clock", () => {
    let tick = 1_000_000;
    const registry = new MetricsRegistry({ now: () => tick });
    tick += 90_000;
    expect(registry.render()).toContain("process_uptime_seconds 90");
  });
});

describe("route normalization", () => {
  test("uuid path segments collapse to :id placeholders", () => {
    expect(
      normalizeRoute("/api/jobs/11111111-1111-4111-8111-111111111111/cancel"),
    ).toBe("/api/jobs/:id/cancel");
    expect(normalizeRoute("/api/jobs")).toBe("/api/jobs");
    expect(normalizeRoute("/api/jobs/not-a-uuid")).toBe("/api/jobs/not-a-uuid");
  });
});

function buildApp(options: { serveToken?: string; failIncr?: boolean } = {}) {
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
    ...(options.serveToken ? { serveToken: options.serveToken } : {}),
    ...(options.failIncr
      ? {
          rateCounter: {
            incr: async (): Promise<number> => {
              throw new Error("valkey down");
            },
            expire: async (): Promise<void> => undefined,
          },
        }
      : {}),
  });
}

describe("the /metrics endpoint", () => {
  test("exposes all five locked metrics as prometheus text", async () => {
    await buildApp().request("/api/project");
    const response = await buildApp().request("/metrics");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const body = await response.text();
    for (const name of [
      "http_requests_total",
      "ratelimit_blocked_total",
      "sse_events_relayed_total",
      "sse_clients_connected",
      "process_uptime_seconds",
    ])
      expect(body).toContain(name);
  });

  test("matched routes collapse to one series regardless of job id", async () => {
    const app = buildApp();
    // Unique ids per request must not create unique label series.
    for (let index = 0; index < 5; index++) {
      await app.request(`/api/jobs/${crypto.randomUUID()}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    }
    const output = await (await app.request("/metrics")).text();
    expect(output).toMatch(
      /http_requests_total\{method="PATCH",route="\/api\/jobs\/:id",status="\d{3}"} 5/,
    );
    expect(output).not.toMatch(/11111111-1111-4111-8111-111111111111/);
  });

  test("counters survive across requests within a process", async () => {
    const app = buildApp();
    await app.request("/healthz");
    await app.request("/healthz");
    // The render happens before its own request is counted, so exactly two.
    const output = await (await app.request("/metrics")).text();
    expect(output).toContain(
      'http_requests_total{method="GET",route="/healthz",status="200"} 2',
    );

    // A fresh registry starts empty.
    const secondApp = buildApp();
    const fresh = await (await secondApp.request("/metrics")).text();
    expect(fresh).not.toContain("http_requests_total{");
  });

  test("metrics is exempt from auth and the rate limiter", async () => {
    const app = buildApp({ serveToken: "sekrit" });
    const denied = await app.request("/api/project");
    expect(denied.status).toBe(401);
    const response = await app.request("/metrics");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratelimit-limit")).toBeNull();
  });
});
