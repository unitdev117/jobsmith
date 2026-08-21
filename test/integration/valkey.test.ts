import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Redis from "ioredis";
import { eventsChannel, presenceKey } from "../../src/coordination/valkey.ts";
import {
  createValkeyClient,
  runDaemon,
  type DaemonRuntime,
} from "../../src/daemon/index.ts";
import { createLogger } from "../../src/observability/logger.ts";
import type { ManualJob } from "../../src/services/manualJobService.ts";

const url = process.env.TEST_VALKEY_URL;
const enabled = Boolean(
  url && (url.startsWith("redis://") || url.startsWith("rediss://")),
);

const job = (id: string): ManualJob => ({
  id,
  title: "Realtime work",
  description: "Cache rewrite driven by a Valkey event",
  priority: 5,
  state: "PENDING",
  progressPercent: 0,
  assignedWorkerName: null,
  tags: [],
  dueAt: null,
  blockedReason: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(50);
  }
  throw new Error("Condition not met before timeout");
}

describe.skipIf(!enabled)("Valkey realtime layer", () => {
  const projectId = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  const channel = eventsChannel(projectId);
  const log = createLogger("valkey-integration", undefined, "warn");
  let directory: string;
  let publisher: Redis;
  let client: ReturnType<typeof createValkeyClient>;
  let shutdown: ((signal: string) => void | Promise<void>) | undefined;
  let stopHeartbeat: (() => void) | undefined;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "jobsmith-valkey-"));
    publisher = new Redis(url!);
  });

  afterAll(async () => {
    if (shutdown) await shutdown("SIGTERM");
    stopHeartbeat?.();
    publisher.disconnect();
    await rm(directory, { recursive: true, force: true });
  });

  test("subscribes, refreshes once per event, and heartbeats presence", async () => {
    let fetchCount = 0;
    client = createValkeyClient(url!, log);
    const runtime: DaemonRuntime = {
      root: directory,
      log,
      fetchJobs: async () => {
        fetchCount++;
        return [job(`job-${fetchCount}`)];
      },
      client,
      channel,
      presenceKey: presenceKey(projectId, memberId),
      presenceValue: JSON.stringify({
        name: "Integration",
        machineId: "machine",
      }),
      // Short TTL so expiry is observable; long interval so the daemon does
      // not refresh presence during the test.
      presenceTtlSeconds: 1,
      heartbeatIntervalMs: 60_000,
      schedule: (callback, intervalMs) => {
        const id = setInterval(callback, intervalMs);
        stopHeartbeat = () => clearInterval(id);
        return stopHeartbeat;
      },
      onSignal: (handler) => {
        shutdown = handler;
      },
    };
    await runDaemon(runtime);

    // Startup fetched once and wrote the cache.
    expect(fetchCount).toBe(1);

    // Presence key exists immediately with a bounded TTL.
    const key = presenceKey(projectId, memberId);
    expect(await publisher.get(key)).toContain("Integration");
    await waitFor(async () => (await publisher.get(key)) === null);

    // A publish from a second service triggers exactly one cache rewrite.
    const before = fetchCount;
    await publisher.publish(
      channel,
      JSON.stringify({ type: "work.created", workItemId: "job-2" }),
    );
    await waitFor(() => fetchCount === before + 1);
    const cache = JSON.parse(
      await readFile(
        join(directory, ".jobsmith", "cache", "jobs.json"),
        "utf8",
      ),
    );
    expect(cache.jobs).toHaveLength(1);
    expect(cache.jobs[0]?.id).toBe(`job-${fetchCount}`);
    expect(Date.now() - new Date(cache.fetchedAt).getTime()).toBeLessThan(
      5_000,
    );

    // One more event → exactly one more fetch.
    const second = fetchCount;
    await publisher.publish(
      channel,
      JSON.stringify({ type: "work.updated", workItemId: "job-3" }),
    );
    await waitFor(() => fetchCount === second + 1);
    expect(fetchCount).toBe(second + 1);
  });
});
