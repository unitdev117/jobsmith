import { describe, expect, test } from "bun:test";
import type { ManualJob } from "../../src/services/manualJobService.ts";
import {
  jobSummary,
  pendingTable,
  priorityLabel,
} from "../../src/cli/terminal.ts";

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

describe("manual CLI presentation", () => {
  test("maps persisted priorities to concise labels", () => {
    expect(priorityLabel(9)).toBe("CRITICAL");
    expect(priorityLabel(7)).toBe("HIGH");
    expect(priorityLabel(5)).toBe("NORMAL");
    expect(priorityLabel(2)).toBe("LOW");
  });

  test("renders the pending command as a compact table", () => {
    const table = pendingTable([job]);
    expect(table).toContain("JOB");
    expect(table).toContain("Prepare release notes");
    expect(table).toContain("HIGH");
    expect(table).toContain("2026-08-20");
  });

  test("renders a worker-facing job summary", () => {
    expect(
      jobSummary({ ...job, state: "IN_PROGRESS", progressPercent: 40 }),
    ).toContain("Progress: 40%");
  });
});
