import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { serveStatic } from "hono/bun";
import { streamSSE } from "hono/streaming";
import { join } from "node:path";
import type { Logger } from "pino";
import type { PresenceEntry } from "../coordination/presence.ts";
import type { LocalProject } from "../project/localConfig.ts";
import type { ProjectService } from "../services/projectService.ts";
import { handleError } from "./errors.ts";
import type { EventBusLike } from "./events.ts";
import type { JobBoard } from "./jobStore.ts";
import { bearerAuth } from "./middleware/auth.ts";
import { rateLimiter, type RateLimitCounter } from "./middleware/rateLimit.ts";
import { MetricsRegistry, normalizeRoute, type Counter } from "./metrics.ts";
import { memberRoutes } from "./routes/members.ts";
import { jobRoutes } from "./routes/jobs.ts";
import { projectRoutes } from "./routes/projects.ts";
import { DEFAULT_RATE_LIMIT } from "./settings.ts";

export interface AppDeps {
  project: LocalProject;
  jobs: JobBoard;
  invites: Pick<ProjectService, "createInvite">;
  members: Pick<ProjectService, "listMembers">;
  presence: (projectId: string) => Promise<PresenceEntry[] | null>;
  events: EventBusLike;
  log: Logger;
  serveToken?: string | undefined;
  rateCounter?: Pick<RateLimitCounter, "incr" | "expire">;
  rateLimit?: number | undefined;
}

// Times each request, emits the structured http.* events (debug on
// receipt, info with status/durationMs on completion) and counts hits.
const requestLogger =
  (log: Logger, httpRequests: Counter): MiddlewareHandler =>
  async (c, next) => {
    const requestId = crypto.randomUUID();
    const started = performance.now();
    const { method } = c.req;
    const path = c.req.path;
    c.header("X-Request-Id", requestId);
    log.debug(
      { event: "http.request_received", requestId, method, path },
      "Request received",
    );
    await next();
    const status = c.res.status;
    // Matched pattern keeps cardinality bounded when ids vary per request.
    httpRequests.inc({
      method,
      route: normalizeRoute(c.req.routePath),
      status: String(status),
    });
    log.info(
      {
        event: "http.request",
        requestId,
        method,
        path,
        status,
        durationMs: Math.round(performance.now() - started),
      },
      "Request handled",
    );
  };

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const metrics = new MetricsRegistry();
  const httpRequests = metrics.counter("http_requests_total", [
    "method",
    "route",
    "status",
  ]);
  const blockedTotal = metrics.counter("ratelimit_blocked_total");
  const relayedTotal = metrics.counter("sse_events_relayed_total");
  const sseClients = metrics.gauge("sse_clients_connected");
  // Zero-valued series stay present in /metrics before the first client.
  sseClients.set(0);

  app.use(requestLogger(deps.log, httpRequests));
  app.use("/api/*", bearerAuth(deps.serveToken, deps.log));
  if (deps.rateCounter) {
    const limiter = rateLimiter({
      counter: deps.rateCounter,
      projectId: deps.project.projectId,
      limit: deps.rateLimit ?? DEFAULT_RATE_LIMIT,
      log: deps.log,
      onBlock: () => blockedTotal.inc(),
    });
    // SSE streams are long-lived; counting them would starve dashboards.
    app.use("/api/*", (c, next) =>
      c.req.path === "/api/events" ? next() : limiter(c, next),
    );
  }

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/metrics", (c) =>
    c.text(metrics.render(), 200, {
      "content-type": "text/plain; charset=utf-8",
    }),
  );
  app.route("/api", projectRoutes(deps));
  app.route("/api", jobRoutes(deps));
  app.route(
    "/api",
    memberRoutes({
      project: deps.project,
      members: deps.members,
      presence: deps.presence,
      log: deps.log,
    }),
  );

  // SSE bridge: pub/sub envelopes fan out verbatim; clients refetch views.
  let clients = 0;
  app.get("/api/events", async (c) => {
    try {
      await deps.events.start();
    } catch (error) {
      // EventSource retries non-200s on its own; a plain 503 keeps the
      // dashboard's reconnect state truthful when Valkey is down.
      deps.log.warn(
        { event: "sse.bus_unavailable", err: error },
        "Event stream unavailable",
      );
      return c.json({ error: "events_unavailable" }, 503);
    }
    clients += 1;
    sseClients.set(clients);
    deps.log.info(
      { event: "sse.client_connected", clients },
      "SSE client connected",
    );
    return streamSSE(c, async (stream) => {
      let closed = false;
      let unsubscribe: () => void = () => undefined;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        unsubscribe();
        clients -= 1;
        sseClients.set(clients);
        deps.log.info(
          { event: "sse.client_disconnected", clients },
          "SSE client disconnected",
        );
      };
      const send = async (frame: {
        event?: string;
        data: string;
      }): Promise<void> => {
        try {
          await (frame.event
            ? stream.writeSSE({
                event: frame.event,
                data: frame.data,
              })
            : stream.write(frame.data));
        } catch {
          cleanup();
        }
      };
      await send({
        event: "ready",
        data: JSON.stringify({ projectId: deps.project.projectId }),
      });
      if (closed) return;
      unsubscribe = deps.events.onChange((envelope) => {
        void send({ event: "change", data: JSON.stringify(envelope) }).then(
          () => {
            if (!closed) relayedTotal.inc();
          },
        );
      });
      heartbeat = setInterval(() => {
        void send({ data: ": heartbeat\n\n" });
      }, 20_000);
      c.req.raw.signal.addEventListener("abort", cleanup, { once: true });
      stream.onAbort(cleanup);
      await new Promise<never>(() => {});
    });
  });

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((error, c) => handleError(c, deps.log, error));

  // Dashboard assets live next to the compiled server; static falls through
  // to the not_found handler when nothing matches.
  const webRoot = join(import.meta.dir, "../web");
  app.get("/", serveStatic({ path: join(webRoot, "index.html") }));
  app.use("*", serveStatic({ root: webRoot }));
  return app;
}
