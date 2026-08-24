import { describe, expect, test } from "bun:test";
import type { Logger } from "pino";
import { createLogger } from "../../src/observability/logger.ts";
import type { EventBusLike } from "../../src/server/events.ts";
import type { JobStoreDeps } from "../../src/server/jobStore.ts";
import { JobStore } from "../../src/server/jobStore.ts";
import type {
  JobPage,
  ManualJob,
  WorkState,
} from "../../src/services/manualJobService.ts";

const log = createLogger("job-store-test", undefined, "silent");

let jobSeq = 0;

const makeJob = (): ManualJob => {
  jobSeq += 1;
  return {
    id: `11111111-1111-4111-8111-${String(jobSeq).padStart(12, "0")}`,
    title: "Write the report",
    description: "Summarize results",
    priority: 5,
    state: "PENDING",
    progressPercent: 0,
    assignedMemberId: null,
    assignedWorkerName: null,
    tags: [],
    dueAt: null,
    blockedReason: null,
    claimedUntil: null,
    createdAt: new Date("2026-08-13T10:00:00.000Z"),
    updatedAt: new Date("2026-08-13T10:00:00.000Z"),
  };
};

type ChangeHandler = Parameters<EventBusLike["onChange"]>[0];

interface FakeBus extends EventBusLike {
  handlers: ChangeHandler[];
}

function fakeBus(timeline?: string[]): FakeBus {
  const handlers: ChangeHandler[] = [];
  return {
    handlers,
    start: async (): Promise<void> => undefined,
    onChange: (fn) => {
      handlers.push(fn);
      timeline?.push("subscribed");
      return () => undefined;
    },
    close: async (): Promise<void> => undefined,
  };
}

interface JobStats {
  listPageCalls: number;
  countStates: (WorkState | undefined)[];
}

type FakeJobs = JobStoreDeps["jobs"] & { stats: JobStats };

function fakeJobs(loadPage: () => Promise<JobPage>): FakeJobs {
  const stats: JobStats = { listPageCalls: 0, countStates: [] };
  const fake: FakeJobs = {
    stats,
    listPage: async () => {
      stats.listPageCalls += 1;
      return await loadPage();
    },
    countAll: async (state) => {
      stats.countStates.push(state);
      return 7;
    },
    create: async () => {
      throw new Error("not used");
    },
    update: async () => {
      throw new Error("not used");
    },
    cancel: async () => {
      throw new Error("not used");
    },
    claim: async () => {
      throw new Error("not used");
    },
    transition: async () => {
      throw new Error("not used");
    },
    setProgress: async () => {
      throw new Error("not used");
    },
    addNote: async () => {
      throw new Error("not used");
    },
  };
  return fake;
}

const recordingSleep =
  (delays: number[]) =>
  async (ms: number): Promise<void> => {
    delays.push(ms);
  };

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 1));
  expect(predicate()).toBe(true);
}

describe("JobStore cold-start retry", () => {
  test("start retries failures with doubling backoff and subscribes only after success", async () => {
    const timeline: string[] = [];
    const delays: number[] = [];
    let calls = 0;
    const row = makeJob();
    const jobs = fakeJobs(async () => {
      calls += 1;
      if (calls <= 2) {
        timeline.push("load_failed");
        throw new Error("database waking");
      }
      timeline.push("load_ok");
      return { jobs: [row], nextCursor: null };
    });
    const bus = fakeBus(timeline);
    const store = new JobStore({
      jobs,
      bus,
      log,
      sleep: recordingSleep(delays),
    });

    await store.start();

    expect(delays).toEqual([1000, 2000]);
    expect(jobs.stats.listPageCalls).toBe(3);
    expect(timeline).toEqual([
      "load_failed",
      "load_failed",
      "load_ok",
      "subscribed",
    ]);

    const page = await store.listPage({});
    expect(page.jobs).toHaveLength(1);
    expect(page.jobs[0]?.id).toBe(row.id);
    expect(page.nextCursor).toBeNull();
  });

  test("reads refuse with 503 until the first successful load", async () => {
    const jobs = fakeJobs(async () => ({
      jobs: [makeJob()],
      nextCursor: null,
    }));
    const store = new JobStore({ jobs, bus: fakeBus(), log });
    const refusal = await store.listPage({}).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ name: "ServiceError", status: 503 });
    await store.start();
    const page = await store.listPage({});
    expect(page.jobs).toHaveLength(1);
    await store.close();
  });

  test("a failed event-driven reload schedules exactly one background retry", async () => {
    let failing = false;
    let calls = 0;
    const jobs = fakeJobs(async () => {
      calls += 1;
      if (failing) throw new Error("still down");
      return { jobs: [makeJob()], nextCursor: null };
    });
    const bus = fakeBus();
    const store = new JobStore({
      jobs,
      bus,
      log,
      debounceMs: 5,
      retryDelayMs: 25,
      maxRetryDelayMs: 50,
      sleep: async () => undefined,
    });
    await store.start();
    expect(calls).toBe(1);

    failing = true;
    bus.handlers[0]?.({
      type: "work.updated",
      occurredAt: new Date().toISOString(),
    });
    await waitFor(() => calls === 2, 500);
    expect(calls).toBe(2);

    failing = false;
    await waitFor(() => calls === 3, 500);
    expect(calls).toBe(3);

    // The retry recovered, so no further attempts may be scheduled.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls).toBe(3);
  });

  test("success resets backoff so the next failure restarts at the base delay", async () => {
    let coldFailures = 1;
    let failing = false;
    const callTimes: number[] = [];
    const delays: number[] = [];
    const base = 40;
    const jobs = fakeJobs(async () => {
      callTimes.push(Date.now());
      if (coldFailures > 0) {
        coldFailures -= 1;
        throw new Error("cold database");
      }
      if (failing) throw new Error("down again");
      return { jobs: [makeJob()], nextCursor: null };
    });
    const bus = fakeBus();
    const store = new JobStore({
      jobs,
      bus,
      log,
      debounceMs: 5,
      retryDelayMs: base,
      maxRetryDelayMs: 10000,
      sleep: recordingSleep(delays),
    });

    await store.start();
    expect(delays).toEqual([base]);

    failing = true;
    const triggeredAt = Date.now();
    bus.handlers[0]?.({
      type: "work.state_changed",
      occurredAt: new Date().toISOString(),
    });
    await waitFor(() => callTimes.length === 3, 500);
    failing = false;
    const waitedMs = callTimes[2]! - triggeredAt;

    // Without a reset this would double to 80ms; recovery must restart at base.
    expect(waitedMs).toBeLessThan(base * 1.5);
    await waitFor(() => callTimes.length === 4, 500);
    await store.close();
  });
});

describe("JobStore description rendering", () => {
  test("listPage attaches sanitized html only to wrapped rows, bytes intact", async () => {
    const rawWrapped = "{# Hi\n\n- [x] a\n\n[bad](javascript:x)";
    const wrapped = { ...makeJob(), description: `${rawWrapped}}` };
    const plain = { ...makeJob(), description: "plain text" };
    const store = new JobStore({
      jobs: fakeJobs(async () => ({
        jobs: [wrapped, plain],
        nextCursor: null,
      })),
      bus: fakeBus(),
      log,
    });
    await store.start();

    const page = await store.listPage({});
    expect(page.jobs[0]!.description).toBe(`${rawWrapped}}`);
    expect(page.jobs[0]!.descriptionHtml).toContain("<h1>");
    expect(page.jobs[0]!.descriptionHtml).not.toContain("javascript:");
    // Plain rows must not carry the key at all.
    expect("descriptionHtml" in page.jobs[1]!).toBe(false);
    expect(page.jobs[1]!.description).toBe("plain text");
    await store.close();
  });

  test("a failing renderer drops the field and logs a warning without throwing", async () => {
    const warns: unknown[] = [];
    const capturingLog = {
      info: () => undefined,
      debug: () => undefined,
      warn: (object: unknown) => {
        warns.push(object);
      },
    } as unknown as Logger;
    // Wrapped source required: unwrapped rows short-circuit before rendering.
    const row = { ...makeJob(), description: "{# Hi}" };
    const store = new JobStore({
      jobs: fakeJobs(async () => ({ jobs: [row], nextCursor: null })),
      bus: fakeBus(),
      log: capturingLog,
      renderDescription: () => {
        throw new Error("renderer exploded");
      },
    });
    await store.start();

    const page = await store.listPage({});
    expect("descriptionHtml" in page.jobs[0]!).toBe(false);
    expect(warns[0]).toMatchObject({
      event: "server.description_render_failed",
      jobId: row.id,
      errorType: "Error",
    });
    await store.close();
  });
});

describe("JobStore stale revalidation", () => {
  test("external writes surface once the snapshot goes stale", async () => {
    let clock = 1_000_000;
    let rows: ManualJob[] = [];
    const jobs = fakeJobs(async () => ({
      jobs: rows.map((row) => ({ ...row })),
      nextCursor: null,
    }));
    const store = new JobStore({
      jobs,
      bus: fakeBus(),
      log,
      revalidateAfterMs: 5_000,
      now: () => clock,
    });
    await store.start();
    expect((await store.listPage({})).jobs).toHaveLength(0);

    // A CLI process wrote straight to the database; no event fired.
    rows = [makeJob()];
    clock += 6_000;
    const page = await store.listPage({});
    expect(page.jobs).toHaveLength(1);
    expect(jobs.stats.listPageCalls).toBe(2);
    await store.close();
  });

  test("fresh snapshots are served without touching the database", async () => {
    let clock = 1_000_000;
    const jobs = fakeJobs(async () => ({
      jobs: [makeJob()],
      nextCursor: null,
    }));
    const store = new JobStore({
      jobs,
      bus: fakeBus(),
      log,
      revalidateAfterMs: 5_000,
      now: () => clock,
    });
    await store.start();
    clock += 1_000;
    await store.listPage({});
    clock += 1_000;
    await store.listPage({});
    expect(jobs.stats.listPageCalls).toBe(1);
    await store.close();
  });

  test("failed revalidation keeps serving the last good snapshot", async () => {
    let clock = 1_000_000;
    let failing = false;
    const good = makeJob();
    const jobs = fakeJobs(async () => {
      if (failing) throw new Error("database gone");
      return { jobs: [{ ...good }], nextCursor: null };
    });
    const store = new JobStore({
      jobs,
      bus: fakeBus(),
      log,
      revalidateAfterMs: 5_000,
      now: () => clock,
    });
    await store.start();

    failing = true;
    clock += 6_000;
    const page = await store.listPage({});
    expect(page.jobs.map((job) => job.id)).toEqual([good.id]);
    await store.close();
  });

  test("overlapping stale readers share one revalidation", async () => {
    let clock = 1_000_000;
    let rows: ManualJob[] = [];
    const jobs = fakeJobs(async () => ({
      jobs: rows.map((row) => ({ ...row })),
      nextCursor: null,
    }));
    const store = new JobStore({
      jobs,
      bus: fakeBus(),
      log,
      revalidateAfterMs: 5_000,
      now: () => clock,
    });
    await store.start();

    rows = [makeJob(), makeJob()];
    clock += 6_000;
    const [a, b] = await Promise.all([store.listPage({}), store.listPage({})]);
    expect(a.jobs.length + b.jobs.length).toBeGreaterThanOrEqual(2);
    expect(jobs.stats.listPageCalls).toBe(2);
    await store.close();
  });
});
