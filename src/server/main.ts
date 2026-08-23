import type { Logger } from "pino";
import { loadDatabaseConfig } from "../config/index.ts";
import { readPresence } from "../coordination/presence.ts";
import { eventsChannel, ProjectNotifier } from "../coordination/valkey.ts";
import { closeDatabase, createDatabase } from "../db/pool.ts";
import { findLocalProject } from "../project/localConfig.ts";
import { createLogger } from "../observability/logger.ts";
import { ManualJobService } from "../services/manualJobService.ts";
import { ProjectService } from "../services/projectService.ts";
import { createApp } from "./app.ts";
import { ProjectEventBus } from "./events.ts";
import { JobStore } from "./jobStore.ts";
import { resolvePort, resolveRateLimit } from "./settings.ts";

export async function startServerProcess(log: Logger): Promise<void> {
  // The child process runs with the project folder as its working directory.
  const { config: project } = await findLocalProject();
  const port = resolvePort(process.argv.slice(2));
  const databaseConfig = loadDatabaseConfig({
    ...process.env,
    DATABASE_URL: project.databaseUrl,
    DATABASE_MIGRATION_URL: undefined,
  });
  const sql = createDatabase(databaseConfig, log);
  const notifier = new ProjectNotifier(
    project.valkeyUrl,
    project.projectId,
    log,
  );
  const jobs = new ManualJobService(sql, project, notifier, log);
  const projects = new ProjectService(sql, log);
  const bus = new ProjectEventBus({
    valkeyUrl: project.valkeyUrl,
    channel: eventsChannel(project.projectId),
    log,
  });
  // Dashboard reads are served from this store; it reloads on project
  // events so request traffic never waits on a cold database round trip.
  // The server binds immediately; until the first load succeeds the API
  // reports 503 and the store keeps retrying in the background.
  const store = new JobStore({ jobs, bus, log });
  void store.start();
  // Subscribe at boot, not on first client: CLI-side changes must reach the
  // store even when no dashboard tab is open.
  void bus
    .start()
    .catch((error: unknown) =>
      log.warn(
        { event: "sse.bus_unavailable", err: error },
        "Event stream unavailable",
      ),
    );
  const app = createApp({
    project,
    jobs: store,
    invites: projects,
    members: projects,
    presence: (projectId) => readPresence(project.valkeyUrl, projectId, log),
    events: bus,
    log,
    serveToken: process.env.JOBSMITH_SERVE_TOKEN,
    rateCounter: notifier,
    rateLimit: resolveRateLimit(),
  });
  // Idle timeout must outlast the SSE heartbeat interval or streams drop.
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 120,
    fetch: app.fetch,
  });
  process.stdout.write(
    `Jobsmith API ready at http://127.0.0.1:${server.port}\n`,
  );
  log.info(
    { event: "server.started", port: server.port },
    "Jobsmith API started",
  );

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    void server.stop(true);
    await store.close();
    await bus.close();
    await notifier.close();
    await closeDatabase(sql, log);
    log.info({ event: "server.stopped" }, "Jobsmith API stopped");
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

if (import.meta.main) {
  await startServerProcess(createLogger("jobsmith-server")).catch(
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `Jobsmith server failed: ${message || "unknown error"}\n`,
      );
      process.exitCode = 1;
    },
  );
}
