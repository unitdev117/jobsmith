import { describe, expect, test } from "bun:test";
import type { ManualJob } from "../../src/services/manualJobService.ts";
import {
  deadlineLabel,
  jobSummary,
  pendingTable,
  priorityLabel,
} from "../../src/cli/terminal.ts";
import {
  jobsForWorker,
  parseDueDate,
  resolveUpdateJobs,
} from "../../src/cli/manualApp.ts";
import type { LocalProject } from "../../src/project/localConfig.ts";

const job: ManualJob = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Prepare release notes",
  description: "Summarize the changes for the next release.",
  priority: 7,
  state: "PENDING",
  progressPercent: 0,
  assignedWorkerName: null,
  tags: ["release", "docs"],
  dueAt: new Date("2026-08-20T00:00:00.000Z"),
  blockedReason: null,
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
    const jobs: ManualJob[] = [
      job,
      { ...job, id: "a", state: "READY" },
      { ...job, id: "b", state: "IN_PROGRESS", assignedWorkerName: "Me" },
      { ...job, id: "c", state: "PAUSED", assignedWorkerName: "Me" },
      { ...job, id: "d", state: "BLOCKED", assignedWorkerName: "Other" },
      { ...job, id: "e", state: "IN_PROGRESS", assignedWorkerName: "Other" },
      { ...job, id: "f", state: "COMPLETED" },
      { ...job, id: "g", state: "PENDING", assignedWorkerName: "Other" },
    ];
    expect(jobsForWorker(jobs, project).map((item) => item.id)).toEqual([
      job.id,
      "a",
      "b",
      "c",
    ]);
  });
});
