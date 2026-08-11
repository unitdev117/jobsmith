import { z } from "zod";
import type { LocalProject } from "../project/localConfig.ts";
import type { ManualJobService } from "../services/manualJobService.ts";
import {
  ask,
  confirm,
  jobSummary,
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

function parseDueDate(value: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new Error("Use YYYY-MM-DD or an ISO date/time");
  return date;
}

export async function runManager(
  service: ManualJobService,
  project: LocalProject,
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
      dueAt = parseDueDate(await ask("Due date (optional, YYYY-MM-DD)"));
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
    `\nName: ${title}\nPriority: ${priorityLabel(priority.value)}\nDue: ${dueAt?.toISOString() ?? "not set"}\nTags: ${tags.join(", ") || "none"}\nDescription: ${description}\n\n`,
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
  process.stdout.write(`\nCreated ${job.id}\n${jobSummary(job)}\n`);
}

export async function runPending(service: ManualJobService): Promise<void> {
  process.stdout.write(`${pendingTable(await service.listPending())}\n`);
}

export async function runWorker(
  service: ManualJobService,
  project: LocalProject,
): Promise<void> {
  process.stdout.write(
    `\nJOBSMITH / ${project.projectName} / WORKER / ${project.memberName}\n\n`,
  );
  const available = await service.listForWorker();
  if (!available.length) {
    process.stdout.write("No jobs are currently available.\n");
    return;
  }
  const selected = await selectMenu(
    "Choose a job",
    available,
    (job) =>
      `${job.assignedWorkerName === project.memberName ? job.state : priorityLabel(job.priority)}  ${job.title}  ${job.progressPercent}%`,
  );
  if (!selected) {
    process.stdout.write("No job selected.\n");
    return;
  }
  const job = await service.claim(selected.id);
  process.stdout.write(`Claimed ${job.id}.\n`);

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
        "Save and exit",
      ] as const,
      (choice) => choice,
    );
    if (!action || action === "Save and exit") {
      await service.saveSession(job.id);
      process.stdout.write(
        "Work session saved. Run `jobsmith worker` to resume.\n",
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
    } else if (action === "Set progress percentage") {
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
      process.stdout.write(`Progress updated to ${progress}%.\n`);
    } else if (action === "Pause work") {
      const note = await ask("Pause note (optional)");
      await service.transition(job.id, "PAUSED", note || undefined);
      process.stdout.write("Job paused. Run `jobsmith worker` to resume.\n");
      return;
    } else if (action === "Mark blocked") {
      const reason = z
        .string()
        .min(1)
        .max(4000)
        .parse(await ask("What is blocking the work?", { required: true }));
      await service.transition(job.id, "BLOCKED", reason);
      process.stdout.write(
        "Job marked blocked. Run `jobsmith worker` to resume it.\n",
      );
      return;
    } else if (action === "Mark completed") {
      if (!(await confirm("Mark this job completed?"))) continue;
      await service.transition(job.id, "COMPLETED");
      process.stdout.write("Job completed.\n");
      return;
    } else if (action === "Mark failed") {
      const reason = z
        .string()
        .min(1)
        .max(4000)
        .parse(await ask("Failure reason", { required: true }));
      await service.transition(job.id, "FAILED", reason);
      process.stdout.write("Job marked failed.\n");
      return;
    } else if (action === "Release back to pending") {
      if (!(await confirm("Release this job for another worker?"))) continue;
      await service.transition(job.id, "PENDING");
      process.stdout.write("Job released.\n");
      return;
    }
  }
}
