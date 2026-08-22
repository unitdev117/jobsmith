import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  HEARTBEAT_INTERVAL_MS,
  PRESENCE_TTL_SECONDS,
  runDaemon,
  type DaemonRuntime,
  type ValkeyClient,
} from "../../src/daemon/index.ts";
import {
  formatUptime,
  isProcessAlive,
  pidFilePath,
  readPidRecord,
  removePidRecord,
  renderStatus,
  startDaemon,
  statusDaemon,
  stopDaemon,
  writePidRecord,
  type PresenceEntry,
} from "../../src/cli/daemonApp.ts";
import { createLogger } from "../../src/observability/logger.ts";
import type { ManualJob } from "../../src/services/manualJobService.ts";

const log = createLogger("daemon-test", undefined, "silent");

const job: ManualJob = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Daemon work",
  description: "Exercise the daemon cache",
  priority: 5,
  state: "PENDING",
  progressPercent: 0,
  assignedMemberId: null,
  assignedWorkerName: null,
  tags: [],
  dueAt: null,
  blockedReason: null,
  createdAt: new Date("2026-08-12T00:00:00.000Z"),
  updatedAt: new Date("2026-08-12T00:00:00.000Z"),
};

const roots: string[] = [];
async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "jobsmith-daemon-"));
  roots.push(value);
  return value;
}
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((value) => rm(value, { recursive: true, force: true })),
  ),
);

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

function fakeClient(): {
  state: {
    subscribed: string[];
    presence: { key: string; value: string; ttl: number }[];
    closed: boolean;
    messageHandler: ((channel: string, message: string) => void) | null;
  };
  client: ValkeyClient;
} {
  const state = {
    subscribed: [] as string[],
    presence: [] as { key: string; value: string; ttl: number }[],
    closed: false,
    messageHandler: null as ((channel: string, message: string) => void) | null,
  };
  const client: ValkeyClient = {
    subscribe: async (channel) => {
      state.subscribed.push(channel);
    },
    setPresence: async (key, value, ttl) => {
      state.presence.push({ key, value, ttl });
    },
    onMessage: (handler) => {
      state.messageHandler = handler;
    },
    close: async () => {
      state.closed = true;
    },
  };
  return { state, client };
}

interface Harness {
  runtime: DaemonRuntime;
  fetchCalls: number;
  timers: Array<() => void>;
  stopCalls: number;
  signalHandler: ((signal: string) => void | Promise<void>) | null;
  client: ReturnType<typeof fakeClient>;
}

async function buildHarness(
  directory: string,
  overrides: Partial<DaemonRuntime> = {},
): Promise<Harness> {
  const client = fakeClient();
  const harness: Harness = {
    fetchCalls: 0,
    timers: [],
    stopCalls: 0,
    signalHandler: null,
    client,
    runtime: {
      root: directory,
      log,
      fetchJobs: async () => {
        harness.fetchCalls++;
        return { jobs: [job], truncated: false };
      },
      client: client.client,
      channel: "jobsmith:p:events",
      presenceKey: "jobsmith:p:presence:m",
      presenceValue: JSON.stringify({ name: "Me", machineId: "machine-1" }),
      presenceTtlSeconds: PRESENCE_TTL_SECONDS,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      refreshDebounceMs: 0,
      schedule: (callback) => {
        harness.timers.push(callback);
        return () => {
          harness.stopCalls++;
        };
      },
      onSignal: (handler) => {
        harness.signalHandler = handler;
      },
      ...overrides,
    },
  };
  return harness;
}

describe("daemon body", () => {
  test("performs one initial fetch and writes the cache on startup", async () => {
    const directory = await root();
    const harness = await buildHarness(directory);
    await runDaemon(harness.runtime);
    expect(harness.fetchCalls).toBe(1);
    const cache = JSON.parse(
      await readFile(
        join(directory, ".jobsmith", "cache", "jobs.json"),
        "utf8",
      ),
    );
    expect(cache.jobs).toHaveLength(1);
    expect(cache.jobs[0]?.id).toBe(job.id);
    expect(harness.client.state.subscribed).toEqual(["jobsmith:p:events"]);
  });

  test("heartbeats presence immediately and on each interval tick", async () => {
    const directory = await root();
    const harness = await buildHarness(directory);
    await runDaemon(harness.runtime);
    await flush();
    expect(harness.client.state.presence).toEqual([
      {
        key: "jobsmith:p:presence:m",
        value: harness.runtime.presenceValue,
        ttl: 60,
      },
    ]);
    expect(harness.timers).toHaveLength(1);
    harness.timers[0]!();
    await flush();
    harness.timers[0]!();
    await flush();
    expect(harness.client.state.presence).toHaveLength(3);
    expect(harness.client.state.presence[1]?.ttl).toBe(PRESENCE_TTL_SECONDS);
  });

  test("coalesces a burst of events into a single refresh", async () => {
    const directory = await root();
    const harness = await buildHarness(directory);
    await runDaemon(harness.runtime);
    expect(harness.fetchCalls).toBe(1);
    harness.client.state.messageHandler!("jobsmith:p:events", "{}");
    harness.client.state.messageHandler!("jobsmith:p:events", "{}");
    harness.client.state.messageHandler!("jobsmith:p:events", "{}");
    await flush();
    expect(harness.fetchCalls).toBe(2);
    await harness.signalHandler!("SIGTERM");
    harness.client.state.messageHandler!("jobsmith:p:events", "{}");
    await flush();
    expect(harness.fetchCalls).toBe(2);
  });

  test("subscribes before the initial fetch so startup events are kept", async () => {
    const directory = await root();
    const order: string[] = [];
    const inner = fakeClient();
    const client: ValkeyClient = {
      ...inner.client,
      subscribe: async (channel) => {
        order.push("subscribe");
        await inner.client.subscribe(channel);
      },
    };
    const harness = await buildHarness(directory, {
      client,
      fetchJobs: async () => {
        order.push("fetch");
        return { jobs: [job], truncated: false };
      },
    });
    await runDaemon(harness.runtime);
    expect(order).toEqual(["subscribe", "fetch"]);
  });

  test("closes the connection and stops the heartbeat on shutdown", async () => {
    const directory = await root();
    const harness = await buildHarness(directory);
    await runDaemon(harness.runtime);
    await harness.signalHandler!("SIGTERM");
    expect(harness.stopCalls).toBe(1);
    expect(harness.client.state.closed).toBe(true);
  });
});

describe("daemon lifecycle", () => {
  test("start writes a secure pid file and reports the pid", async () => {
    const directory = await root();
    await startDaemon(directory, log, {
      isAlive: () => false,
      spawn: () => 4242,
      now: () => Date.UTC(2026, 7, 12, 12, 0, 0),
    });
    const record = await readPidRecord(directory);
    expect(record).toEqual({
      pid: 4242,
      startedAt: new Date(Date.UTC(2026, 7, 12, 12, 0, 0)).toISOString(),
    });
  });

  test("refuses to start when a live pid is already recorded", async () => {
    const directory = await root();
    await writePidRecord(directory, {
      pid: 4242,
      startedAt: new Date().toISOString(),
    });
    let spawned = 0;
    expect(
      startDaemon(directory, log, {
        isAlive: (pid) => pid === 4242,
        spawn: () => {
          spawned++;
          return 9999;
        },
      }),
    ).rejects.toThrow("already running");
    expect(spawned).toBe(0);
  });

  test("recovers from a stale pid file and allows start", async () => {
    const directory = await root();
    await writePidRecord(directory, {
      pid: 4242,
      startedAt: new Date().toISOString(),
    });
    await startDaemon(directory, log, {
      isAlive: () => false,
      spawn: () => 5151,
    });
    expect((await readPidRecord(directory))?.pid).toBe(5151);
  });

  test("stop terminates the process and removes the pid file", async () => {
    const directory = await root();
    await writePidRecord(directory, {
      pid: 4242,
      startedAt: new Date().toISOString(),
    });
    let terminated = 0;
    await stopDaemon(directory, log, {
      isAlive: () => true,
      terminate: () => {
        terminated++;
      },
    });
    expect(terminated).toBe(1);
    expect(await readPidRecord(directory)).toBeNull();
  });

  test("stop treats a dead or missing pid as already stopped", async () => {
    const directory = await root();
    await stopDaemon(directory, log, { isAlive: () => false });
    expect(await readPidRecord(directory)).toBeNull();
  });

  test("status reports uptime for a live pid and removes a stale one", async () => {
    const directory = await root();
    await writePidRecord(directory, {
      pid: 4242,
      startedAt: new Date(Date.UTC(2026, 7, 12, 12, 0, 0)).toISOString(),
    });
    await statusDaemon(directory, log, {
      isAlive: () => true,
      now: () => Date.UTC(2026, 7, 12, 12, 0, 65),
    });
    await statusDaemon(directory, log, { isAlive: () => false });
    expect(await readPidRecord(directory)).toBeNull();
  });

  test("detects the current process as alive and rejects bogus pids", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(99_999_999)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });

  test("formats uptime across seconds, minutes, and hours", () => {
    expect(formatUptime(5)).toBe("5s");
    expect(formatUptime(65)).toBe("1m 5s");
    expect(formatUptime(3_665)).toBe("1h 1m 5s");
    expect(formatUptime(-10)).toBe("0s");
  });
});

describe("jobsmith status", () => {
  const entry = (name: string, machineId: string): PresenceEntry => ({
    name,
    machineId,
    memberId: "m",
  });

  test("lists online workers", () => {
    const output = renderStatus([
      entry("Alice", "44444444-4444-4444-8444-444444444444"),
    ]);
    expect(output).toContain("Online workers:");
    expect(output).toContain("Alice");
    expect(output).toContain("44444444");
  });

  test("degrades gracefully when Valkey is unreachable", () => {
    expect(renderStatus(null)).toBe("online workers: unavailable\n");
  });

  test("reports an empty listing", () => {
    expect(renderStatus([])).toBe("No workers are online.\n");
  });
});

describe("pid file", () => {
  test("keeps the pid file private and readable", async () => {
    const directory = await root();
    await writePidRecord(directory, {
      pid: 4242,
      startedAt: new Date().toISOString(),
    });
    const path = pidFilePath(directory);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await removePidRecord(directory);
    expect(readFile(path, "utf8")).rejects.toThrow();
  });
});
