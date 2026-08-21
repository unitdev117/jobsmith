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
import type { ManualJob } from "../services/manualJobService.ts";

export const CACHE_TTL_MS = 90_000;

const jobSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  priority: z.number(),
  state: z.enum(["PENDING", "READY", "IN_PROGRESS", "PAUSED", "BLOCKED"]),
  progressPercent: z.number(),
  assignedWorkerName: z.string().nullable(),
  tags: z.array(z.string()),
  dueAt: z.coerce.date().nullable(),
  blockedReason: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

const snapshotSchema = z.object({
  schemaVersion: z.literal(1),
  fetchedAt: z.coerce.date(),
  jobs: z.array(jobSchema),
});

interface Snapshot {
  fetchedAt: Date;
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
  const body = JSON.stringify({ schemaVersion: 1, ...snapshot }, null, 2);
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
  fetchFromDb: () => Promise<ManualJob[]>,
  now: () => number = Date.now,
): Promise<ReadResult> {
  const jobs = await fetchFromDb();
  const fetchedAt = new Date(now());
  await store(root, { jobs, fetchedAt });
  return { jobs, fetchedAt, fromCache: false, offline: false };
}

export async function readJobs(
  root: string,
  fetchFromDb: () => Promise<ManualJob[]>,
  now: () => number = Date.now,
): Promise<ReadResult> {
  const cached = await load(root);
  if (cached && now() - cached.fetchedAt.getTime() <= CACHE_TTL_MS) {
    logger.debug({ event: "job_cache.hit" }, "Jobs served from cache");
    return { ...cached, fromCache: true, offline: false };
  }
  let jobs: ManualJob[];
  try {
    jobs = await fetchFromDb();
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
  const fetchedAt = new Date(now());
  try {
    await store(root, { jobs, fetchedAt });
  } catch (error) {
    logger.warn(
      { event: "job_cache.store_failed", ...errorFields(error) },
      "Job cache write failed; serving fresh data",
    );
  }
  return { jobs, fetchedAt, fromCache: false, offline: false };
}

export async function patchSnapshot(
  root: string,
  mutate: (jobs: ManualJob[]) => ManualJob[],
  fetchFromDb: () => Promise<ManualJob[]>,
  now: () => number = Date.now,
): Promise<void> {
  const cached = await load(root);
  if (!cached) {
    await refreshJobs(root, fetchFromDb, now);
    return;
  }
  const jobs = mutate(cached.jobs);
  await store(root, { jobs, fetchedAt: cached.fetchedAt });
  logger.debug({ event: "job_cache.patched" }, "Job cache patched");
}
