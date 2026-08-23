import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { chmodSync, closeSync, openSync } from "node:fs";
import { join } from "node:path";

export interface PidRecord {
  pid: number;
  startedAt: string;
}

export interface LifecycleDeps {
  isAlive?: (pid: number) => boolean;
  spawn?: (script: string, options: { cwd: string; logPath: string }) => number;
  terminate?: (pid: number) => void;
  now?: () => number;
}

export function pidPath(root: string, fileName: string): string {
  return join(root, ".jobsmith", fileName);
}

export async function readPidRecord(
  root: string,
  fileName: string,
): Promise<PidRecord | null> {
  try {
    const record = JSON.parse(
      await readFile(pidPath(root, fileName), "utf8"),
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
  fileName: string,
  record: PidRecord,
): Promise<void> {
  const directory = join(root, ".jobsmith");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = pidPath(root, fileName);
  await writeFile(path, JSON.stringify(record), { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function removePidRecord(
  root: string,
  fileName: string,
): Promise<void> {
  await rm(pidPath(root, fileName), { force: true });
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

export function spawnDetached(
  script: string,
  {
    cwd,
    logPath,
    env = process.env,
  }: { cwd: string; logPath: string; env?: Record<string, string | undefined> },
): number {
  const logFd = openSync(logPath, "a", 0o600);
  chmodSync(logPath, 0o600);
  try {
    const child = Bun.spawn([process.execPath, script], {
      cwd,
      env: { ...env },
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
