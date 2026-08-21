import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CACHE_TTL_MS,
  patchSnapshot,
  readJobs,
} from "../../src/project/jobCache.ts";
import type { ManualJob } from "../../src/services/manualJobService.ts";

const roots: string[] = [];
const job: ManualJob = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Cache work",
  description: "Test cache behavior",
  priority: 5,
  state: "PENDING",
  progressPercent: 0,
  assignedWorkerName: null,
  tags: [],
  dueAt: null,
  blockedReason: null,
  createdAt: new Date("2026-08-12T00:00:00.000Z"),
  updatedAt: new Date("2026-08-12T00:00:00.000Z"),
};

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "jobsmith-cache-"));
  roots.push(value);
  return value;
}

afterEach(async () =>
  Promise.all(
    roots.splice(0).map((value) => rm(value, { recursive: true, force: true })),
  ),
);

describe("job cache", () => {
  test("serves a fresh cache without fetching", async () => {
    const directory = await root();
    let calls = 0;
    await readJobs(
      directory,
      async () => {
        calls++;
        return [job];
      },
      () => 1_000,
    );
    const result = await readJobs(
      directory,
      async () => {
        calls++;
        return [];
      },
      () => 1_000 + CACHE_TTL_MS,
    );
    expect(result.jobs).toHaveLength(1);
    expect(result.fromCache).toBe(true);
    expect(calls).toBe(1);
  });

  test("refreshes expired, corrupt, wrong-shaped, and missing caches", async () => {
    const directory = await root();
    let calls = 0;
    const fetch = async () => {
      calls++;
      return [job];
    };
    await readJobs(directory, fetch, () => 1_000);
    await readJobs(directory, fetch, () => 1_000 + CACHE_TTL_MS + 1);
    const file = join(directory, ".jobsmith", "cache", "jobs.json");
    await writeFile(file, "not json");
    await readJobs(directory, fetch);
    await writeFile(file, JSON.stringify({ jobs: [] }));
    await readJobs(directory, fetch);
    expect(calls).toBe(4);
  });

  test("patches add, update, and remove without fetching", async () => {
    const directory = await root();
    let calls = 0;
    const fetch = async () => {
      calls++;
      return [job];
    };
    await readJobs(directory, fetch);
    await patchSnapshot(
      directory,
      (jobs) => [{ ...job, id: "second" }, ...jobs],
      fetch,
    );
    await patchSnapshot(
      directory,
      (jobs) => jobs.map((item) => ({ ...item, progressPercent: 50 })),
      fetch,
    );
    await patchSnapshot(
      directory,
      (jobs) => jobs.filter((item) => item.id !== "second"),
      fetch,
    );
    const result = await readJobs(directory, fetch);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]?.progressPercent).toBe(50);
    expect(calls).toBe(1);
  });

  test("patchSnapshot fetches when the cache is missing", async () => {
    const directory = await root();
    let calls = 0;
    await patchSnapshot(
      directory,
      (jobs) => jobs,
      async () => {
        calls++;
        return [job];
      },
    );
    expect(calls).toBe(1);
    expect((await readJobs(directory, async () => [])).jobs).toEqual([job]);
  });

  test("leaves the prior snapshot intact when mutation fails", async () => {
    const directory = await root();
    await readJobs(directory, async () => [job]);
    expect(
      patchSnapshot(
        directory,
        () => {
          throw new Error("mutation failed");
        },
        async () => [],
      ),
    ).rejects.toThrow("mutation failed");
    expect((await readJobs(directory, async () => [])).jobs).toEqual([job]);
  });

  test("uses secure permissions and leaves no temporary file", async () => {
    const directory = await root();
    await readJobs(directory, async () => [job]);
    const cache = join(directory, ".jobsmith", "cache");
    expect((await stat(cache)).mode & 0o777).toBe(0o700);
    expect((await stat(join(cache, "jobs.json"))).mode & 0o777).toBe(0o600);
    expect((await readdir(cache)).some((name) => name.endsWith(".tmp"))).toBe(
      false,
    );
  });

  test("falls back to stale cache while offline", async () => {
    const directory = await root();
    await readJobs(
      directory,
      async () => [job],
      () => 1_000,
    );
    const result = await readJobs(
      directory,
      async () => {
        throw new Error("offline");
      },
      () => 100_000,
    );
    expect(result.offline).toBe(true);
    expect(result.jobs).toHaveLength(1);
  });

  test("rethrows the fetch error when there is no cache to fall back to", async () => {
    const directory = await root();
    expect(
      readJobs(directory, async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
  });
});
