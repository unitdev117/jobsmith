import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ManualJob,
  ManualJobService,
} from "../../src/services/manualJobService.ts";
import {
  deadlineLabel,
  jobSummary,
  pendingTable,
  priorityLabel,
  unescapeNewlines,
} from "../../src/cli/terminal.ts";
import {
  jobsForWorker,
  parseDueDate,
  parsePendingArgs,
  resolveUpdateJobs,
  runManager,
} from "../../src/cli/manualApp.ts";
import type { LocalProject } from "../../src/project/localConfig.ts";

const job: ManualJob = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Prepare release notes",
  description: "Summarize the changes for the next release.",
  priority: 7,
  state: "PENDING",
  progressPercent: 0,
  assignedMemberId: null,
  assignedWorkerName: null,
  tags: ["release", "docs"],
  dueAt: new Date("2026-08-20T00:00:00.000Z"),
  blockedReason: null,
  claimedUntil: null,
  createdAt: new Date("2026-08-11T00:00:00.000Z"),
  updatedAt: new Date("2026-08-11T00:00:00.000Z"),
};

const project: LocalProject = {
  schemaVersion: 1,
  projectId: "22222222-2222-4222-8222-222222222222",
  projectName: "Test project",
  memberId: "33333333-3333-4333-8333-333333333333",
  memberName: "Me",
  role: "MEMBER",
  machineId: "44444444-4444-4444-8444-444444444444",
  databaseUrl: "postgresql://user:pass@localhost/jobsmith",
  valkeyUrl: "redis://localhost:6379",
};

describe("manual CLI presentation", () => {
  test("maps persisted priorities to concise labels", () => {
    expect(priorityLabel(9)).toBe("CRITICAL");
    expect(priorityLabel(7)).toBe("HIGH");
    expect(priorityLabel(5)).toBe("NORMAL");
    expect(priorityLabel(2)).toBe("LOW");
  });

  test("parses optional due dates as DDMMYYYY", () => {
    expect(parseDueDate("")).toBeNull();
    expect(parseDueDate("13082026")?.toISOString()).toBe(
      "2026-08-13T00:00:00.000Z",
    );
    expect(() => parseDueDate("2026-08-13")).toThrow("DDMMYYYY");
    expect(() => parseDueDate("31022026")).toThrow("valid DDMMYYYY");
  });

  test("renders the pending command as a compact table", () => {
    const table = pendingTable([job]);
    expect(table).toContain("JOB");
    expect(table).toContain("Prepare release notes");
    expect(table).toContain("HIGH");
    expect(table).toContain("20-08-2026");
  });

  test("renders a worker-facing job summary", () => {
    const summary = jobSummary({
      ...job,
      state: "IN_PROGRESS",
      progressPercent: 40,
    });
    expect(summary).toContain("Progress: 40%");
    expect(summary).toContain("Deadline: 20-08-2026 GMT");
    expect(summary).not.toContain("T00:00:00.000Z");
  });

  test("formats deadlines as concise GMT dates", () => {
    expect(deadlineLabel(new Date("2026-08-13T00:00:00.000Z"))).toBe(
      "13-08-2026 GMT",
    );
    expect(deadlineLabel(null)).toBe("not set");
  });

  test("renders cache and offline synchronization status", () => {
    const now = new Date();
    expect(pendingTable([job], { syncedAt: now, fromCache: true })).toContain(
      "data synced",
    );
    expect(pendingTable([job], { syncedAt: now, offline: true })).toContain(
      "offline",
    );
  });

  test("parses pending paging flags", () => {
    expect(parsePendingArgs([])).toEqual({});
    expect(parsePendingArgs(["--limit", "10"])).toEqual({ limit: 10 });
    expect(parsePendingArgs(["--cursor", "abc", "--limit", "3"])).toEqual({
      limit: 3,
      cursor: "abc",
    });
    expect(() => parsePendingArgs(["--limit"])).toThrow("--limit");
    expect(() => parsePendingArgs(["--limit", "soon"])).toThrow("--limit");
    expect(() => parsePendingArgs(["--cursor"])).toThrow("--cursor");
  });

  test("resolves update jobs by id, exact title, prefix, and substring", () => {
    const jobs = [job, { ...job, id: "other", title: "Prepare deployment" }];
    expect(resolveUpdateJobs(jobs, job.id)).toEqual([job]);
    expect(resolveUpdateJobs(jobs, "prepare release notes")).toEqual([job]);
    expect(resolveUpdateJobs(jobs, "Prepare rel")).toEqual([job]);
    expect(resolveUpdateJobs(jobs, "deployment")).toEqual([jobs[1]!]);
    expect(resolveUpdateJobs(jobs, "prepare")).toHaveLength(2);
    expect(resolveUpdateJobs(jobs, "missing")).toEqual([]);
  });

  test("filters the worker list to unclaimed and own active jobs", () => {
    const mine = project.memberId;
    const other = "55555555-5555-4555-8555-555555555555";
    const jobs: ManualJob[] = [
      job,
      { ...job, id: "a", state: "READY" },
      {
        ...job,
        id: "b",
        state: "IN_PROGRESS",
        assignedMemberId: mine,
        assignedWorkerName: project.memberName,
      },
      {
        ...job,
        id: "c",
        state: "PAUSED",
        assignedMemberId: mine,
        assignedWorkerName: project.memberName,
      },
      // Same display name, different member id: must stay hidden now that
      // ownership matches on id.
      {
        ...job,
        id: "d",
        state: "BLOCKED",
        assignedMemberId: other,
        assignedWorkerName: project.memberName,
      },
      {
        ...job,
        id: "e",
        state: "IN_PROGRESS",
        assignedMemberId: other,
        assignedWorkerName: "Other",
      },
      { ...job, id: "f", state: "COMPLETED" },
      {
        ...job,
        id: "g",
        state: "PENDING",
        assignedMemberId: other,
        assignedWorkerName: "Other",
      },
    ];
    expect(jobsForWorker(jobs, project).map((item) => item.id)).toEqual([
      job.id,
      "a",
      "b",
      "c",
    ]);
  });

  test("offers other members' expired-claim jobs as available", () => {
    const mine = project.memberId;
    const other = "55555555-5555-4555-8555-555555555555";
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 600_000);
    expect(
      jobsForWorker(
        [
          {
            ...job,
            id: "expired",
            state: "IN_PROGRESS",
            assignedMemberId: other,
            claimedUntil: past,
          },
        ],
        project,
      ).map((item) => item.id),
    ).toEqual(["expired"]);
    expect(
      jobsForWorker(
        [
          {
            ...job,
            id: "held",
            state: "IN_PROGRESS",
            assignedMemberId: other,
            claimedUntil: future,
          },
          {
            ...job,
            id: "mine-expired",
            state: "IN_PROGRESS",
            assignedMemberId: mine,
            claimedUntil: past,
          },
        ],
        project,
      ).map((item) => item.id),
    ).toEqual(["mine-expired"]);
  });

  test("expands \\n sequences and keeps \\\\n literal in isolation", () => {
    expect(unescapeNewlines(String.raw`a\nb`)).toBe("a\nb");
    expect(unescapeNewlines(String.raw`a\\nb`)).toBe(String.raw`a\nb`);
    expect(unescapeNewlines("no escapes here")).toBe("no escapes here");
    expect(unescapeNewlines(String.raw`\\n then \n`)).toBe(
      `${String.raw`\n`} then \n`,
    );
  });
});

describe("manager description newline convention", () => {
  // terminal.ts attaches to the real stdin once per process; shadow only
  // the methods it uses so piped lines drive whole manager sessions.
  let capturedHandler: ((chunk: Buffer) => void) | null = null;
  const stdin = process.stdin as unknown as Record<string, unknown>;

  beforeAll(() => {
    stdin.on = (event: string, fn: (chunk: Buffer) => void) => {
      if (event === "data") capturedHandler = fn;
      return process.stdin;
    };
    stdin.resume = () => undefined;
    stdin.pause = () => undefined;
  });

  afterAll(() => {
    delete stdin.on;
    delete stdin.resume;
    delete stdin.pause;
  });

  async function runSession(lines: string[]): Promise<{
    created: ManualJob[];
    failure: Error | null;
  }> {
    const created: ManualJob[] = [];
    let failure: Error | null = null;
    const service = {
      create: async (input: {
        title: string;
        description: string;
        priority: number;
        tags: string[];
        dueAt: Date | null;
      }) => {
        const now = new Date();
        const createdJob: ManualJob = {
          id: crypto.randomUUID(),
          title: input.title,
          description: input.description,
          priority: input.priority,
          state: "PENDING",
          progressPercent: 0,
          assignedMemberId: null,
          assignedWorkerName: null,
          tags: input.tags,
          dueAt: input.dueAt,
          blockedReason: null,
          claimedUntil: null,
          createdAt: now,
          updatedAt: now,
        };
        created.push(createdJob);
        return createdJob;
      },
      listPending: async () => ({ jobs: [], truncated: false }),
    } as unknown as ManualJobService;
    const root = mkdtempSync(join(tmpdir(), "jobsmith-cli-test-"));
    try {
      // The first prompt attaches its handler before suspending, so one
      // buffered delivery serves the whole session.
      const session = runManager(service, project, root);
      capturedHandler?.(Buffer.from(lines.join(""), "utf8"));
      await session;
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    return { created, failure };
  }

  // Every session answers: title, description, priority, due date, tags,
  // confirm (empty -> yes).
  test("piped session expands \\n pairs but preserves escaped \\\\n", async () => {
    const typedDescription = String.raw`{\n# Title\n\nbody\\nliteral}`;
    const { created, failure } = await runSession([
      "Release notes\n",
      `${typedDescription}\n`,
      "3\n",
      "\n",
      "\n",
      "\n",
    ]);
    expect(failure).toBeNull();
    expect(created).toHaveLength(1);
    expect(created[0]!.description).toBe("{\n# Title\n\nbody\\nliteral}");
  });

  test("answers without backslash sequences stay byte-identical", async () => {
    const { created, failure } = await runSession([
      "Plain job\n",
      "just plain text\n",
      "3\n",
      "\n",
      "\n",
      "\n",
    ]);
    expect(failure).toBeNull();
    expect(created[0]!.description).toBe("just plain text");
  });

  test("length validation runs on the expanded value", async () => {
    const content = "a".repeat(3000);
    const accepted = await runSession([
      "Big but legal\n",
      `${content}${"\\n".repeat(999)}\n`,
      "3\n",
      "\n",
      "\n",
      "\n",
    ]);
    expect(accepted.failure).toBeNull();
    expect(accepted.created[0]!.description).toBe(
      `${content}${"\n".repeat(999)}`,
    );
    expect(accepted.created[0]!.description).toHaveLength(3999);

    // Must run last: leftover piped lines would poison a later session.
    const rejected = await runSession([
      "Too long after expansion\n",
      `${content}${"\\n".repeat(1001)}\n`,
    ]);
    expect(rejected.failure?.name).toBe("ZodError");
    expect(rejected.created).toHaveLength(0);
  });
});
