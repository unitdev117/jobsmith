import type { ManualJob } from "../services/manualJobService.ts";

const clean = (value: string): string => value.replaceAll(/\s+/g, " ").trim();

// Line input is handled directly instead of node:readline because Bun drops
// buffered pipe input after the first answered question, which starved every
// scripted or pasted multi-prompt session.
const inputState = {
  buffer: "",
  waiters: [] as ((line: string) => void)[],
  attached: false,
  rawActive: false,
};

function handleChunk(chunk: Buffer): void {
  if (inputState.rawActive) return;
  inputState.buffer += chunk.toString();
  while (inputState.waiters.length) {
    const newline = inputState.buffer.indexOf("\n");
    if (newline < 0) break;
    const line = inputState.buffer.slice(0, newline).replace(/\r$/, "");
    inputState.buffer = inputState.buffer.slice(newline + 1);
    inputState.waiters.shift()!(line);
  }
  if (!inputState.waiters.length) process.stdin.pause();
}
function takeBufferedLine(): string | null {
  const newline = inputState.buffer.indexOf("\n");
  if (newline < 0) return null;
  const line = inputState.buffer.slice(0, newline).replace(/\r$/, "");
  inputState.buffer = inputState.buffer.slice(newline + 1);
  return line;
}

function readLine(promptText?: string): Promise<string> {
  if (promptText) process.stdout.write(promptText);
  if (!inputState.attached) {
    inputState.attached = true;
    process.stdin.on("data", handleChunk);
    process.stdin.on("end", () => {
      while (inputState.waiters.length) inputState.waiters.shift()!!("");
      inputState.buffer = "";
    });
  }
  // Buffered line from an earlier chunk: serve it without touching the
  // stream at all.
  const buffered = takeBufferedLine();
  if (buffered !== null) return Promise.resolve(buffered);
  // Register before resuming: a synchronous delivery must find a waiter.
  return new Promise((resolve) => {
    inputState.waiters.push(resolve);
    process.stdin.resume();
  });
}

export async function ask(
  question: string,
  options: { required?: boolean; defaultValue?: string } = {},
): Promise<string> {
  while (true) {
    const suffix = options.defaultValue ? ` (${options.defaultValue})` : "";
    const answer = clean(await readLine(`${question}${suffix}: `));
    const value = answer || options.defaultValue || "";
    if (value || !options.required) return value;
    process.stdout.write("This value is required.\n");
  }
}

// Terminal lines cannot contain Enter, so authors spell newlines as \n;
// \\n escapes back to a literal backslash-n.
export function unescapeNewlines(value: string): string {
  // Single left-to-right scan via sentinel so \n inside an already-consumed
  // escape is not re-expanded.
  const SENTINEL = "\u0000";
  return value
    .replaceAll("\\\\n", SENTINEL)
    .replaceAll("\\n", "\n")
    .replaceAll(SENTINEL, "\\n");
}

export async function askSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    return ask(question, { required: true });

  while (true) {
    process.stdout.write(`${question} (input hidden): `);
    inputState.rawActive = true;
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
      inputState.rawActive = false;
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

  inputState.rawActive = true;
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
    inputState.rawActive = false;
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

export async function multiSelectMenu<T>(
  title: string,
  choices: readonly T[],
  label: (choice: T) => string,
): Promise<T[]> {
  if (!choices.length) return [];
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write(`\n${title}\n`);
    choices.forEach((choice, index) =>
      process.stdout.write(`  ${index + 1}. ${label(choice)}\n`),
    );
    const answer = await ask(
      "Select numbers separated by commas, or 0 to cancel",
      {
        defaultValue: "0",
      },
    );
    const indices = [
      ...new Set(
        answer
          .split(",")
          .map((value) => Number(value.trim()) - 1)
          .filter(
            (value) =>
              Number.isInteger(value) && value >= 0 && value < choices.length,
          ),
      ),
    ];
    return indices.map((index) => choices[index]!);
  }

  let cursor = 0;
  const selected = new Set<number>();
  const render = (): void => {
    process.stdout.write("\u001b[2J\u001b[H");
    process.stdout.write(`${title}\n\n`);
    choices.forEach((choice, index) => {
      const pointer = index === cursor ? "❯" : " ";
      const mark = selected.has(index) ? "◉" : "○";
      process.stdout.write(`${pointer} ${mark} ${label(choice)}\n`);
    });
    process.stdout.write("\n↑/↓ move  space toggle  enter proceed  q cancel\n");
  };
  inputState.rawActive = true;
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
        cursor = (cursor - 1 + choices.length) % choices.length;
      else if (key === "\u001b[B" || key === "j")
        cursor = (cursor + 1) % choices.length;
      else if (key === " ")
        selected.has(cursor) ? selected.delete(cursor) : selected.add(cursor);
      else if (key === "\r")
        return [...selected].map((index) => choices[index]!);
      else if (key === "q" || key === "\u0003" || key === "\u001b") return [];
      render();
    }
  } finally {
    process.stdout.write("\u001b[?25h\u001b[2J\u001b[H");
    inputState.rawActive = false;
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

export const deadlineLabel = (date: Date | null): string =>
  date
    ? `${String(date.getUTCDate()).padStart(2, "0")}-${String(
        date.getUTCMonth() + 1,
      ).padStart(2, "0")}-${date.getUTCFullYear()} GMT`
    : "not set";

const tableDeadlineLabel = (date: Date | null): string =>
  date ? deadlineLabel(date).replace(" GMT", "") : "—";

const clipped = (value: string, width: number): string =>
  value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`;

function ageLabel(syncedAt: Date): string {
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - syncedAt.getTime()) / 1000),
  );
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
}

export function pendingTable(
  jobs: readonly ManualJob[],
  options: {
    syncedAt?: Date;
    fromCache?: boolean;
    offline?: boolean;
    truncated?: boolean;
  } = {},
): string {
  const status = options.syncedAt
    ? options.offline
      ? `(offline — synced ${ageLabel(options.syncedAt)} ago)`
      : options.fromCache
        ? `— data synced ${ageLabel(options.syncedAt)} ago —`
        : null
    : null;
  if (!jobs.length)
    return ["No pending jobs.", status].filter(Boolean).join("\n");
  const rows = jobs.map((job) => [
    job.id.slice(0, 8),
    clipped(job.title, 24),
    priorityLabel(job.priority),
    job.state,
    tableDeadlineLabel(job.dueAt),
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
    ...(options.truncated
      ? [`(showing first ${jobs.length} active jobs)`]
      : []),
    status,
  ]
    .filter((value): value is string => value !== null)
    .join("\n");
}

export function nextPageHint(cursor: string): string {
  const dim = process.stdout.isTTY ? "\u001b[2m" : "";
  const reset = dim ? "\u001b[0m" : "";
  return `${dim}Next page: jobsmith pending --cursor ${cursor}${reset}`;
}

export function jobSummary(job: ManualJob): string {
  return [
    `${job.title}  [${priorityLabel(job.priority)}]`,
    `Status: ${job.state}   Progress: ${job.progressPercent}%`,
    `Worker: ${job.assignedWorkerName ?? "unassigned"}`,
    `Deadline: ${deadlineLabel(job.dueAt)}`,
    `Tags: ${job.tags.join(", ") || "none"}`,
    "",
    job.description,
  ].join("\n");
}
