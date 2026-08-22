import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { errorFields, logger } from "../observability/logger.ts";
import type { ManualJob, PendingFetch } from "../services/manualJobService.ts";

export const CACHE_TTL_MS = 90_000;

const jobSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  priority: z.number(),
  state: z.enum(["PENDING", "READY", "IN_PROGRESS", "PAUSED", "BLOCKED"]),
  progressPercent: z.number(),
  assignedMemberId: z.string().uuid().nullable(),
  assignedWorkerName: z.string().nullable(),
  tags: z.array(z.string()),
  dueAt: z.coerce.date().nullable(),
  blockedReason: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

const snapshotSchema = z.object({
  schemaVersion: z.literal(2),
  fetchedAt: z.coerce.date(),
  truncated: z.boolean(),
  jobs: z.array(jobSchema),
});

interface Snapshot {
  fetchedAt: Date;
  truncated: boolean;
  jobs: ManualJob[];
}

function connectionErrorFields(error: unknown): {
  errorType: string;
  errorCode?: string;
} {
  const value = error as Error & { code?: string };
  const fields: { errorType: string; errorCode?: string } = {
    errorType: value?.name || "UnknownError",
  };
  if (value?.code) fields.errorCode = value.code;
  return fields;
}

export interface ReadResult extends Snapshot {
  fromCache: boolean;
  offline: boolean;
}

const paths = (root: string) => {
  const directory = join(root, ".jobsmith", "cache");
  return {
    directory,
    file: join(directory, "jobs.json"),
  };
};

async function load(root: string): Promise<Snapshot | null> {
  try {
    const parsed = snapshotSchema.safeParse(
      JSON.parse(await readFile(paths(root).file, "utf8")),
    );
    if (!parsed.success) {
      logger.warn({ event: "job_cache.invalid" }, "Job cache is invalid");
      return null;
    }
    return parsed.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      logger.warn(
        { event: "job_cache.read_failed", ...errorFields(error) },
        "Job cache could not be read",
      );
    return null;
  }
}

async function store(root: string, snapshot: Snapshot): Promise<void> {
  const target = paths(root);
  await mkdir(target.directory, { recursive: true, mode: 0o700 });
  await chmod(target.directory, 0o700);
  const body = JSON.stringify({ schemaVersion: 2, ...snapshot }, null, 2);
  const temporary = join(
    target.directory,
    `jobs.json.${crypto.randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, body, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, target.file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    logger.error(
      { event: "job_cache.write_failed", ...errorFields(error) },
      "Job cache could not be written",
    );
    throw error;
  }
  logger.debug(
    { event: "job_cache.written", jobCount: snapshot.jobs.length },
    "Job cache written",
  );
}

export async function refreshJobs(
  root: string,
  fetchFromDb: () => Promise<PendingFetch>,
  now: () => number = Date.now,
): Promise<ReadResult> {
  const fetched = await fetchFromDb();
  const fetchedAt = new Date(now());
  const snapshot: Snapshot = {
    jobs: fetched.jobs,
    truncated: fetched.truncated,
    fetchedAt,
  };
  await store(root, snapshot);
  return { ...snapshot, fromCache: false, offline: false };
}

export async function readJobs(
  root: string,
  fetchFromDb: () => Promise<PendingFetch>,
  now: () => number = Date.now,
): Promise<ReadResult> {
  const cached = await load(root);
  if (cached && now() - cached.fetchedAt.getTime() <= CACHE_TTL_MS) {
    logger.debug({ event: "job_cache.hit" }, "Jobs served from cache");
    return { ...cached, fromCache: true, offline: false };
  }
  let snapshot: Snapshot;
  try {
    const fetched = await fetchFromDb();
    snapshot = {
      jobs: fetched.jobs,
      truncated: fetched.truncated,
      fetchedAt: new Date(now()),
    };
  } catch (error) {
    if (!cached) throw error;
    logger.warn(
      { event: "job_cache.offline_fallback", ...connectionErrorFields(error) },
      "Serving stale job cache",
    );
    logger.debug(
      { event: "job_cache.offline_details", ...errorFields(error) },
      "Database refresh failed",
    );
    return { ...cached, fromCache: true, offline: true };
  }
  try {
    await store(root, snapshot);
  } catch (error) {
    logger.warn(
      { event: "job_cache.store_failed", ...errorFields(error) },
      "Job cache write failed; serving fresh data",
    );
  }
  return { ...snapshot, fromCache: false, offline: false };
}

export async function patchSnapshot(
  root: string,
  mutate: (jobs: ManualJob[]) => ManualJob[],
  fetchFromDb: () => Promise<PendingFetch>,
  now: () => number = Date.now,
): Promise<void> {
  const cached = await load(root);
  if (!cached) {
    await refreshJobs(root, fetchFromDb, now);
    return;
  }
  const jobs = mutate(cached.jobs);
  await store(root, {
    jobs,
    truncated: cached.truncated,
    fetchedAt: cached.fetchedAt,
  });
  logger.debug({ event: "job_cache.patched" }, "Job cache patched");
}
