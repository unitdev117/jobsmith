import { createInterface } from "node:readline/promises";
import type { ManualJob } from "../services/manualJobService.ts";

const clean = (value: string): string => value.replaceAll(/\s+/g, " ").trim();

export async function ask(
  question: string,
  options: { required?: boolean; defaultValue?: string } = {},
): Promise<string> {
  while (true) {
    const suffix = options.defaultValue ? ` (${options.defaultValue})` : "";
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = clean(await prompt.question(`${question}${suffix}: `));
    prompt.close();
    const value = answer || options.defaultValue || "";
    if (value || !options.required) return value;
    process.stdout.write("This value is required.\n");
  }
}

export async function askSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    return ask(question, { required: true });

  while (true) {
    process.stdout.write(`${question} (input hidden): `);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let value = "";
    try {
      while (true) {
        const chunk = await new Promise<string>((resolve) =>
          process.stdin.once("data", (data: Buffer) =>
            resolve(data.toString()),
          ),
        );
        let complete = false;
        for (const character of chunk) {
          if (character === "\r" || character === "\n") {
            complete = true;
            break;
          }
          if (character === "\u0003") throw new Error("Input cancelled");
          if (character === "\u007f" || character === "\b")
            value = value.slice(0, -1);
          else if (character >= " ") value += character;
        }
        if (complete) break;
      }
    } finally {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    }
    const cleaned = value.trim();
    if (cleaned) return cleaned;
    process.stdout.write("This value is required.\n");
  }
}

export async function confirm(question: string): Promise<boolean> {
  const answer = (await ask(`${question} [Y/n]`, { defaultValue: "y" }))
    .toLowerCase()
    .trim();
  return answer === "y" || answer === "yes";
}

export async function selectMenu<T>(
  title: string,
  choices: readonly T[],
  label: (choice: T) => string,
): Promise<T | null> {
  if (!choices.length) return null;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write(`\n${title}\n`);
    choices.forEach((choice, index) =>
      process.stdout.write(`  ${index + 1}. ${label(choice)}\n`),
    );
    const selected = Number(
      await ask("Select a number, or 0 to cancel", { defaultValue: "0" }),
    );
    return selected >= 1 && selected <= choices.length
      ? choices[selected - 1]!
      : null;
  }

  let selected = 0;
  const render = (): void => {
    process.stdout.write("\u001b[2J\u001b[H");
    process.stdout.write(`${title}\n\n`);
    choices.forEach((choice, index) => {
      const cursor = index === selected ? "❯" : " ";
      process.stdout.write(`${cursor} ${label(choice)}\n`);
    });
    process.stdout.write("\n↑/↓ move  enter select  q cancel\n");
  };

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write("\u001b[?25l");
  try {
    render();
    while (true) {
      const key = await new Promise<string>((resolve) =>
        process.stdin.once("data", (data: Buffer) => resolve(data.toString())),
      );
      if (key === "\u001b[A" || key === "k")
        selected = (selected - 1 + choices.length) % choices.length;
      else if (key === "\u001b[B" || key === "j")
        selected = (selected + 1) % choices.length;
      else if (key === "\r") return choices[selected]!;
      else if (key === "q" || key === "\u0003" || key === "\u001b") return null;
      render();
    }
  } finally {
    process.stdout.write("\u001b[?25h\u001b[2J\u001b[H");
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

export const priorityLabel = (priority: number): string => {
  if (priority >= 9) return "CRITICAL";
  if (priority >= 7) return "HIGH";
  if (priority >= 4) return "NORMAL";
  return "LOW";
};

const clipped = (value: string, width: number): string =>
  value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`;

export function pendingTable(jobs: readonly ManualJob[]): string {
  if (!jobs.length) return "No pending jobs.";
  const rows = jobs.map((job) => [
    job.id.slice(0, 8),
    clipped(job.title, 24),
    priorityLabel(job.priority),
    job.state,
    job.dueAt ? job.dueAt.toISOString().slice(0, 10) : "—",
    clipped(job.description, 44),
  ]);
  const headers = ["ID", "JOB", "PRIORITY", "STATE", "DUE", "DESCRIPTION"];
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => row[column]!.length)),
  );
  const line = (row: string[]): string =>
    row.map((value, column) => value.padEnd(widths[column]!)).join("  ");
  return [
    line(headers),
    widths.map((width) => "─".repeat(width)).join("  "),
    ...rows.map(line),
  ].join("\n");
}

export function jobSummary(job: ManualJob): string {
  return [
    `${job.title}  [${priorityLabel(job.priority)}]`,
    `Status: ${job.state}   Progress: ${job.progressPercent}%`,
    `Worker: ${job.assignedWorkerName ?? "unassigned"}`,
    `Due: ${job.dueAt?.toISOString() ?? "not set"}`,
    `Tags: ${job.tags.join(", ") || "none"}`,
    "",
    job.description,
  ].join("\n");
}
