import type { Logger } from "pino";
import { join } from "node:path";
import { readPresence, type PresenceEntry } from "../coordination/presence.ts";
import type { LocalProject } from "../project/localConfig.ts";
import {
  formatUptime,
  isProcessAlive,
  readPidRecord as readPidFile,
  removePidRecord as removePidFile,
  spawnDetached,
  writePidRecord as writePidFile,
  type LifecycleDeps,
} from "./lifecycle.ts";

const DAEMON_SCRIPT = join(import.meta.dir, "../daemon/index.ts");
const PID_FILE = "daemon.pid";
const LOG_FILE = "daemon.log";

export { formatUptime, isProcessAlive };
export type { PresenceEntry };
type DaemonLifecycleDeps = LifecycleDeps;
type PidRecord = { pid: number; startedAt: string };

export function pidFilePath(root: string): string {
  return join(root, ".jobsmith", PID_FILE);
}

export async function readPidRecord(root: string) {
  return readPidFile(root, PID_FILE);
}

export async function writePidRecord(root: string, record: PidRecord) {
  await writePidFile(root, PID_FILE, record);
}

export async function removePidRecord(root: string) {
  await removePidFile(root, PID_FILE);
}

function defaultSpawn(
  script: string,
  options: { cwd: string; logPath: string },
): number {
  return spawnDetached(script, options);
}

export async function startDaemon(
  root: string,
  log: Logger,
  deps: DaemonLifecycleDeps = {},
): Promise<void> {
  const isAlive = deps.isAlive ?? isProcessAlive;
  const spawn = deps.spawn ?? defaultSpawn;
  const now = deps.now ?? Date.now;
  const existing = await readPidRecord(root);
  if (existing && isAlive(existing.pid))
    throw new Error(`Daemon is already running (pid ${existing.pid})`);
  const pid = spawn(DAEMON_SCRIPT, {
    cwd: root,
    logPath: join(root, ".jobsmith", LOG_FILE),
  });
  await writePidRecord(root, { pid, startedAt: new Date(now()).toISOString() });
  log.info({ event: "daemon.started", pid }, "Daemon started");
  process.stdout.write(`Daemon started (pid ${pid}).\n`);
}

export async function stopDaemon(
  root: string,
  log: Logger,
  deps: DaemonLifecycleDeps = {},
): Promise<void> {
  const isAlive = deps.isAlive ?? isProcessAlive;
  const terminate = deps.terminate ?? ((pid) => process.kill(pid, "SIGTERM"));
  const record = await readPidRecord(root);
  if (!record || !isAlive(record.pid)) {
    await removePidRecord(root);
    process.stdout.write("Daemon is not running.\n");
    return;
  }
  terminate(record.pid);
  await removePidRecord(root);
  log.info({ event: "daemon.stopped", pid: record.pid }, "Daemon stopped");
  process.stdout.write(`Daemon stopped (pid ${record.pid}).\n`);
}

export async function statusDaemon(
  root: string,
  log: Logger,
  deps: DaemonLifecycleDeps = {},
): Promise<void> {
  const isAlive = deps.isAlive ?? isProcessAlive;
  const now = deps.now ?? Date.now;
  const record = await readPidRecord(root);
  if (!record || !isAlive(record.pid)) {
    await removePidRecord(root);
    process.stdout.write("Daemon is not running.\n");
    return;
  }
  const started = new Date(record.startedAt).getTime();
  const uptimeSeconds = Number.isNaN(started)
    ? 0
    : Math.floor((now() - started) / 1000);
  process.stdout.write(
    `Daemon is running (pid ${record.pid}, up ${formatUptime(uptimeSeconds)}).\n`,
  );
}

export async function runDaemonCommand(
  root: string,
  subcommand: string | undefined,
  log: Logger,
): Promise<void> {
  if (subcommand === "start") await startDaemon(root, log);
  else if (subcommand === "stop") await stopDaemon(root, log);
  else if (subcommand === "status" || !subcommand)
    await statusDaemon(root, log);
  else
    throw new Error(
      `Unknown daemon command: ${subcommand}. Use start, stop, or status.`,
    );
}

export async function listPresence(
  project: LocalProject,
  log: Logger,
): Promise<PresenceEntry[] | null> {
  return readPresence(project.valkeyUrl, project.projectId, log);
}

export function renderStatus(workers: PresenceEntry[] | null): string {
  if (workers === null) return "online workers: unavailable\n";
  if (!workers.length) return "No workers are online.\n";
  const lines = ["Online workers:"];
  for (const worker of workers)
    lines.push(`  ${worker.name}  (${worker.machineId.slice(0, 8)})`);
  return `${lines.join("\n")}\n`;
}

export async function runStatus(
  project: LocalProject,
  log: Logger,
  list: (
    project: LocalProject,
    log: Logger,
  ) => Promise<PresenceEntry[] | null> = listPresence,
): Promise<void> {
  process.stdout.write(renderStatus(await list(project, log)));
}
