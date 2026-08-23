import type { Logger } from "pino";
import { join } from "node:path";
import {
  formatUptime,
  isProcessAlive,
  readPidRecord,
  removePidRecord,
  spawnDetached,
  writePidRecord,
  type LifecycleDeps,
} from "./lifecycle.ts";
import { resolvePort } from "../server/settings.ts";

const SERVER_SCRIPT = join(import.meta.dir, "../server/main.ts");
const PID_FILE = "server.pid";
const LOG_FILE = "server.log";

type ServerLifecycleDeps = LifecycleDeps;

// The child re-resolves the port itself; --port is forwarded through the
// environment because detached processes do not inherit argv.
function spawnOptions(root: string, argv: string[]) {
  const env = { ...process.env };
  const flag = argv.indexOf("--port");
  if (flag >= 0 && argv[flag + 1]) env.JOBSMITH_PORT = argv[flag + 1];
  return {
    cwd: root,
    logPath: join(root, ".jobsmith", LOG_FILE),
    env,
  };
}

export async function startServer(
  root: string,
  argv: string[],
  log: Logger,
  deps: ServerLifecycleDeps = {},
): Promise<void> {
  const isAlive = deps.isAlive ?? isProcessAlive;
  const spawn = deps.spawn ?? spawnDetached;
  const now = deps.now ?? Date.now;
  const existing = await readPidRecord(root, PID_FILE);
  if (existing && isAlive(existing.pid))
    throw new Error(`Server is already running (pid ${existing.pid})`);
  const port = resolvePort(argv);
  const pid = spawn(SERVER_SCRIPT, spawnOptions(root, argv));
  await writePidRecord(root, PID_FILE, {
    pid,
    startedAt: new Date(now()).toISOString(),
  });
  log.info(
    { event: "server.process_started", pid, port },
    "Jobsmith server started",
  );
  process.stdout.write(
    `Server started (pid ${pid}). Dashboard: http://127.0.0.1:${port}\n`,
  );
}

export async function stopServer(
  root: string,
  log: Logger,
  deps: ServerLifecycleDeps = {},
): Promise<void> {
  const isAlive = deps.isAlive ?? isProcessAlive;
  const terminate = deps.terminate ?? ((pid) => process.kill(pid, "SIGTERM"));
  const record = await readPidRecord(root, PID_FILE);
  if (!record || !isAlive(record.pid)) {
    await removePidRecord(root, PID_FILE);
    process.stdout.write("Server is not running.\n");
    return;
  }
  terminate(record.pid);
  await removePidRecord(root, PID_FILE);
  log.info(
    { event: "server.process_stopped", pid: record.pid },
    "Jobsmith server stopped",
  );
  process.stdout.write(`Server stopped (pid ${record.pid}).\n`);
}

export async function statusServer(
  root: string,
  log: Logger,
  deps: ServerLifecycleDeps = {},
): Promise<void> {
  const isAlive = deps.isAlive ?? isProcessAlive;
  const now = deps.now ?? Date.now;
  void log;
  const record = await readPidRecord(root, PID_FILE);
  if (!record || !isAlive(record.pid)) {
    await removePidRecord(root, PID_FILE);
    process.stdout.write("Server is not running.\n");
    return;
  }
  const started = new Date(record.startedAt).getTime();
  const uptimeSeconds = Number.isNaN(started)
    ? 0
    : Math.floor((now() - started) / 1000);
  process.stdout.write(
    `Server is running (pid ${record.pid}, up ${formatUptime(uptimeSeconds)}).\n`,
  );
}

export async function runServerCommand(
  root: string,
  subcommand: string | undefined,
  argv: string[],
  log: Logger,
): Promise<void> {
  if (subcommand === "start") await startServer(root, argv, log);
  else if (subcommand === "stop") await stopServer(root, log);
  else if (subcommand === "status" || !subcommand)
    await statusServer(root, log);
  else
    throw new Error(
      `Unknown server command: ${subcommand}. Use start, stop, or status.`,
    );
}
