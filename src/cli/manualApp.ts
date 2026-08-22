import { z } from "zod";
import type { LocalProject } from "../project/localConfig.ts";
import { patchSnapshot, readJobs } from "../project/jobCache.ts";
import { logger } from "../observability/logger.ts";
import type {
  ManualJob,
  ManualJobService,
} from "../services/manualJobService.ts";
import { ACTIVE_STATES } from "../services/manualJobService.ts";
import {
  ask,
  confirm,
  deadlineLabel,
  jobSummary,
  multiSelectMenu,
  pendingTable,
  priorityLabel,
  selectMenu,
} from "./terminal.ts";

const priorities = [
  { value: 9, label: "Critical — blocks other work" },
  { value: 7, label: "High — should be handled soon" },
  { value: 5, label: "Normal — standard work" },
  { value: 2, label: "Low — handle when capacity allows" },
] as const;

async function updateCache(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    logger.warn(
      {
        event: "job_cache.patch_failed",
        errorType: error instanceof Error ? error.name : "UnknownError",
      },
      "Committed change could not be cached",
    );
  }
}

export function parseDueDate(value: string): Date | null {
  if (!value) return null;
  if (!/^\d{8}$/.test(value)) throw new Error("Use DDMMYYYY");
  const day = Number(value.slice(0, 2));
  const month = Number(value.slice(2, 4));
  const year = Number(value.slice(4, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCDate() !== day ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCFullYear() !== year
  )
    throw new Error("Use a valid DDMMYYYY date");
  return date;
}

export async function runManager(
  service: ManualJobService,
  project: LocalProject,
  root: string,
): Promise<void> {
  process.stdout.write(
    `\nJOBSMITH / ${project.projectName} / MANAGER / NEW JOB\n\n`,
  );
  const title = z
    .string()
    .min(1)
    .max(120)
    .parse(await ask("Job name", { required: true }));
  const description = z
    .string()
    .min(1)
    .max(4000)
    .parse(await ask("Description", { required: true }));
  const priority = await selectMenu(
    "Select job priority",
    priorities,
    (choice) => choice.label,
  );
  if (!priority) {
    process.stdout.write("Job creation cancelled.\n");
    return;
  }
  let dueAt: Date | null = null;
  while (true) {
    try {
      dueAt = parseDueDate(await ask("Due date (optional, DDMMYYYY)"));
      break;
    } catch (error) {
      process.stdout.write(
        `${error instanceof Error ? error.message : "Invalid date"}.\n`,
      );
    }
  }
  const tags = (await ask("Tags (optional, comma separated)"))
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 20);
  process.stdout.write(
    `\nName: ${title}\nPriority: ${priorityLabel(priority.value)}\nDeadline: ${deadlineLabel(dueAt)}\nTags: ${tags.join(", ") || "none"}\nDescription: ${description}\n\n`,
  );
  if (!(await confirm("Create this job?"))) {
    process.stdout.write("Job creation cancelled.\n");
    return;
  }
  const job = await service.create({
    title,
    description,
    priority: priority.value,
    tags,
    dueAt,
  });
  await updateCache(() =>
    patchSnapshot(
      root,
      (jobs) => [job, ...jobs],
      () => service.listPending(),
    ),
  );
  logger.info(
    { event: "cache.manager_patched", jobId: job.id },
    "Created job cached",
  );
  process.stdout.write(`\nCreated ${job.id}\n${jobSummary(job)}\n`);
}

export async function runPending(
  service: ManualJobService,
  root: string,
): Promise<void> {
  const result = await readJobs(root, () => service.listPending());
  process.stdout.write(
    `${pendingTable(result.jobs, {
      syncedAt: result.fetchedAt,
      fromCache: result.fromCache,
      offline: result.offline,
      truncated: result.truncated,
    })}\n`,
  );
}

const activeStates = new Set<string>(ACTIVE_STATES);

export function jobsForWorker(
  jobs: ManualJob[],
  project: LocalProject,
): ManualJob[] {
  return jobs.filter(
    (job) =>
      ((job.state === "PENDING" || job.state === "READY") &&
        job.assignedMemberId === null) ||
      (activeStates.has(job.state) &&
        job.assignedMemberId === project.memberId),
  );
}

export function resolveUpdateJobs(
  jobs: ManualJob[],
  query?: string,
): ManualJob[] {
  if (!query) return jobs;
  const needle = query.toLowerCase();
  const byId = jobs.filter((job) => job.id === query);
  if (byId.length) return byId;
  const exact = jobs.filter((job) => job.title.toLowerCase() === needle);
  if (exact.length) return exact;
  const prefix = jobs.filter((job) =>
    job.title.toLowerCase().startsWith(needle),
  );
  if (prefix.length) return prefix;
  return jobs.filter((job) => job.title.toLowerCase().includes(needle));
}

const patchJob = (
  jobs: ManualJob[],
  id: string,
  change: Partial<ManualJob>,
): ManualJob[] =>
  jobs.map((job) => (job.id === id ? { ...job, ...change } : job));

export async function runJobUpdateMenu(
  service: ManualJobService,
  job: ManualJob,
  root: string,
): Promise<void> {
  while (true) {
    const action = await selectMenu(
      `${jobSummary(job)}\n\nWhat do you want to update?`,
      [
        "Add progress note",
        "Set progress percentage",
        "Pause work",
        "Mark blocked",
        "Mark completed",
        "Mark failed",
        "Release back to pending",
        "Cancel job",
        "Save and exit",
      ] as const,
      (choice) => choice,
    );
    if (!action || action === "Save and exit") {
      await service.saveSession(job.id);
      process.stdout.write(
        "Work session saved. Run `jobsmith update` to resume.\n",
      );
      return;
    }
    if (action === "Add progress note") {
      const note = z
        .string()
        .min(1)
        .max(4000)
        .parse(await ask("Progress note", { required: true }));
      await service.addNote(job.id, note);
      process.stdout.write("Progress note saved.\n");
      continue;
    }
    if (action === "Set progress percentage") {
      const progress = z.coerce
        .number()
        .int()
        .min(0)
        .max(100)
        .parse(
          await ask("Progress (0-100)", {
            required: true,
            defaultValue: String(job.progressPercent),
          }),
        );
      await service.setProgress(job.id, progress);
      job.progressPercent = progress;
      await updateCache(() =>
        patchSnapshot(
          root,
          (jobs) => patchJob(jobs, job.id, { progressPercent: progress }),
          () => service.listPending(),
        ),
      );
      process.stdout.write(`Progress updated to ${progress}%.\n`);
      continue;
    }
    let outcome: "PAUSED" | "BLOCKED" | "COMPLETED" | "FAILED" | "PENDING";
    let message: string | undefined;
    if (action === "Pause work") {
      outcome = "PAUSED";
      message = (await ask("Pause note (optional)")) || undefined;
    } else if (action === "Mark blocked") {
      outcome = "BLOCKED";
      message = z
        .string()
        .min(1)
        .max(4000)
        .parse(await ask("What is blocking the work?", { required: true }));
    } else if (action === "Mark completed") {
      if (!(await confirm("Mark this job completed?"))) continue;
      outcome = "COMPLETED";
    } else if (action === "Mark failed") {
      outcome = "FAILED";
      message = z
        .string()
        .min(1)
        .max(4000)
        .parse(await ask("Failure reason", { required: true }));
    } else if (action === "Cancel job") {
      if (!(await confirm("Cancel this job permanently?"))) continue;
      await service.cancel(job.id);
      await updateCache(() =>
        patchSnapshot(
          root,
          (jobs) => jobs.filter((candidate) => candidate.id !== job.id),
          () => service.listPending(),
        ),
      );
      logger.info(
        {
          event: "cache.job_transition_patched",
          jobId: job.id,
          outcome: "CANCELLED",
        },
        "Job transition cached",
      );
      process.stdout.write("Job cancelled.\n");
      return;
    } else {
      if (!(await confirm("Release this job for another worker?"))) continue;
      outcome = "PENDING";
    }
    await service.transition(job.id, outcome, message);
    await updateCache(() =>
      patchSnapshot(
        root,
        (jobs) =>
          outcome === "COMPLETED" || outcome === "FAILED"
            ? jobs.filter((candidate) => candidate.id !== job.id)
            : patchJob(jobs, job.id, {
                state: outcome,
                assignedWorkerName:
                  outcome === "PENDING" ? null : job.assignedWorkerName,
                blockedReason:
                  outcome === "BLOCKED" ? (message ?? "Blocked") : null,
              }),
        () => service.listPending(),
      ),
    );
    logger.info(
      { event: "cache.job_transition_patched", jobId: job.id, outcome },
      "Job transition cached",
    );
    process.stdout.write(
      outcome === "COMPLETED"
        ? "Job completed.\n"
        : outcome === "FAILED"
          ? "Job marked failed.\n"
          : outcome === "PENDING"
            ? "Job released.\n"
            : outcome === "BLOCKED"
              ? "Job marked blocked. Run `jobsmith update` to resume it.\n"
              : "Job paused. Run `jobsmith update` to resume.\n",
    );
    return;
  }
}

export async function runWorker(
  service: ManualJobService,
  project: LocalProject,
  root: string,
): Promise<void> {
  process.stdout.write(
    `\nJOBSMITH / ${project.projectName} / WORKER / ${project.memberName}\n\n`,
  );
  const result = await readJobs(root, () => service.listPending());
  const available = jobsForWorker(result.jobs, project);
  if (!available.length) {
    process.stdout.write("No jobs are currently available.\n");
    return;
  }
  const selected = await multiSelectMenu(
    "Choose one or more jobs",
    available,
    (job) =>
      `${job.assignedMemberId === project.memberId ? job.state : priorityLabel(job.priority)}  ${job.title}  ${job.progressPercent}%`,
  );
  if (!selected.length) {
    process.stdout.write("No job selected.\n");
    return;
  }
  const titles = new Map(selected.map((job) => [job.id, job.title]));
  const { claimed, failures } = await service.claimMany(
    selected.map((job) => job.id),
  );
  for (const failure of failures) {
    logger.warn(
      { event: "worker.claim_failed", jobId: failure.id },
      "Job claim failed",
    );
    process.stderr.write(
      `${titles.get(failure.id) ?? failure.id}: ${failure.reason}\n`,
    );
  }
  if (claimed.length)
    await updateCache(() => {
      const claimedIds = new Set(claimed.map((job) => job.id));
      return patchSnapshot(
        root,
        (jobs) => [
          ...claimed.slice().reverse(),
          ...jobs.filter((job) => !claimedIds.has(job.id)),
        ],
        () => service.listPending(),
      );
    });
  for (const job of claimed)
    process.stdout.write(`Claimed ${job.id}.\n${jobSummary(job)}\n\n`);
  if (!claimed.length) return;
  process.stdout.write(
    claimed.length === 1
      ? "Run 'jobsmith update' when done.\n"
      : "Run 'jobsmith update \"<Job Name>\"' to update one, or 'jobsmith update' when only one is active.\n",
  );
}

export async function runUpdate(
  service: ManualJobService,
  project: LocalProject,
  root: string,
  query?: string,
): Promise<void> {
  const result = await readJobs(root, () => service.listPending());
  const owned = result.jobs.filter(
    (job) =>
      activeStates.has(job.state) && job.assignedMemberId === project.memberId,
  );
  const matches = resolveUpdateJobs(owned, query);
  if (!matches.length) {
    if (query) {
      const cancelled = await offerCancelUnclaimed(
        service,
        root,
        result.jobs.filter(
          (job) => job.state === "PENDING" && job.assignedMemberId === null,
        ),
        query,
      );
      if (cancelled) return;
    }
    throw new Error(
      "No claimed job found. Run `jobsmith worker` to claim work first",
    );
  }
  const job =
    matches.length === 1
      ? matches[0]!
      : await selectMenu(
          "Choose a job to update",
          matches,
          (candidate) => `${candidate.state}  ${candidate.title}`,
        );
  if (!job) {
    process.stdout.write("No job selected.\n");
    return;
  }
  logger.info(
    { event: "update.job_resolved", jobId: job.id },
    "Job selected for update",
  );
  if (job.state !== "IN_PROGRESS") {
    const resumed = await service.claim(job.id);
    Object.assign(job, resumed);
    await updateCache(() =>
      patchSnapshot(
        root,
        (jobs) => [resumed, ...jobs.filter((item) => item.id !== resumed.id)],
        () => service.listPending(),
      ),
    );
  }
  await runJobUpdateMenu(service, job, root);
}

async function offerCancelUnclaimed(
  service: ManualJobService,
  root: string,
  pending: ManualJob[],
  query: string,
): Promise<boolean> {
  const candidates = resolveUpdateJobs(pending, query);
  if (!candidates.length) return false;
  const target =
    candidates.length === 1
      ? candidates[0]!
      : await selectMenu(
          "No claimed job matches. Cancel an unclaimed job instead?",
          candidates,
          (candidate) =>
            `${priorityLabel(candidate.priority)}  ${candidate.title}`,
        );
  if (!target) return false;
  if (!(await confirm(`Cancel unclaimed job "${target.title}"?`))) {
    process.stdout.write("Cancellation aborted.\n");
    return true;
  }
  await service.cancel(target.id);
  await updateCache(() =>
    patchSnapshot(
      root,
      (jobs) => jobs.filter((candidate) => candidate.id !== target.id),
      () => service.listPending(),
    ),
  );
  logger.info(
    {
      event: "cache.job_transition_patched",
      jobId: target.id,
      outcome: "CANCELLED",
    },
    "Job transition cached",
  );
  process.stdout.write(`Cancelled ${target.id}.\n`);
  return true;
}
