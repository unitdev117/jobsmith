import Redis from "ioredis";
import type { Logger } from "pino";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { chmodSync, closeSync, openSync } from "node:fs";
import { join } from "node:path";
import {
  parsePresence,
  presencePattern,
  type PresencePayload,
} from "../coordination/valkey.ts";
import type { LocalProject } from "../project/localConfig.ts";

const DAEMON_SCRIPT = join(import.meta.dir, "../daemon/index.ts");
const PID_FILE = "daemon.pid";
const LOG_FILE = "daemon.log";

interface PidRecord {
  pid: number;
  startedAt: string;
}

export interface DaemonLifecycleDeps {
  isAlive?: (pid: number) => boolean;
  spawn?: (script: string, options: { cwd: string; logPath: string }) => number;
  terminate?: (pid: number) => void;
  now?: () => number;
}

export interface PresenceEntry extends PresencePayload {
  memberId: string;
}

export function pidFilePath(root: string): string {
  return join(root, ".jobsmith", PID_FILE);
}

export async function readPidRecord(root: string): Promise<PidRecord | null> {
  try {
    const record = JSON.parse(
      await readFile(pidFilePath(root), "utf8"),
    ) as PidRecord;
    if (!Number.isInteger(record.pid) || record.pid <= 0) return null;
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writePidRecord(
  root: string,
  record: PidRecord,
): Promise<void> {
  const directory = join(root, ".jobsmith");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = pidFilePath(root);
  await writeFile(path, JSON.stringify(record), { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function removePidRecord(root: string): Promise<void> {
  await rm(pidFilePath(root), { force: true });
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function formatUptime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const remainder = safe % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${remainder}s`;
  if (minutes > 0) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
}

function defaultSpawn(
  script: string,
  { cwd, logPath }: { cwd: string; logPath: string },
): number {
  const logFd = openSync(logPath, "a", 0o600);
  chmodSync(logPath, 0o600);
  try {
    const child = Bun.spawn([process.execPath, script], {
      cwd,
      env: { ...process.env },
      detached: true,
      stdin: "ignore",
      stdout: logFd,
      stderr: logFd,
    });
    child.unref();
    return child.pid;
  } finally {
    closeSync(logFd);
  }
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
  const client = new Redis(project.valkeyUrl, {
    connectionName: "jobsmith-status",
    connectTimeout: 1_500,
    retryStrategy: () => null,
    maxRetriesPerRequest: 1,
  });
  client.on("error", () => undefined);
  try {
    const pattern = presencePattern(project.projectId);
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [next, found] = await client.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        100,
      );
      cursor = next;
      keys.push(...found);
    } while (cursor !== "0");
    if (!keys.length) return [];
    const values = await client.mget(...keys);
    return keys
      .map((key, index) => {
        const payload = parsePresence(values[index] ?? null);
        if (!payload) return null;
        return {
          ...payload,
          memberId: key.slice(key.lastIndexOf(":") + 1),
        };
      })
      .filter((entry): entry is PresenceEntry => entry !== null);
  } catch (error) {
    log.warn(
      { event: "status.presence_unavailable", err: error },
      "Online worker listing unavailable",
    );
    return null;
  } finally {
    client.disconnect();
  }
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
