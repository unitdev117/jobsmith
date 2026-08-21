import "dotenv/config";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import { decodeInvite } from "../src/services/projectService.ts";

const entrypoint = join(import.meta.dir, "../src/index.ts");
interface Answer {
  prompt: string;
  answer: string;
}

async function command(
  cwd: string,
  args: string[],
  answers: Answer[] = [],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const childEnvironment: Record<string, string | undefined> = {
    ...process.env,
    LOG_LEVEL: "error",
  };
  delete childEnvironment.DATABASE_URL;
  delete childEnvironment.DATABASE_MIGRATION_URL;
  delete childEnvironment.VALKEY_URL;
  const child = Bun.spawn(["bun", "run", entrypoint, ...args], {
    cwd,
    env: childEnvironment,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let stdout = "";
  let stderr = "";
  const read = async (
    stream: ReadableStream<Uint8Array>,
    append: (chunk: string) => void,
  ): Promise<void> => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      append(decoder.decode(chunk.value, { stream: true }));
    }
  };
  const stdoutReader = read(child.stdout, (chunk) => (stdout += chunk));
  const stderrReader = read(child.stderr, (chunk) => (stderr += chunk));
  let cursor = 0;
  try {
    for (const step of answers) {
      const deadline = Date.now() + 15_000;
      while (stdout.indexOf(step.prompt, cursor) < 0) {
        if (Date.now() > deadline)
          throw new Error(
            `Timed out waiting for prompt ${step.prompt}: ${stdout} ${stderr}`,
          );
        await Bun.sleep(20);
      }
      cursor = stdout.indexOf(step.prompt, cursor) + step.prompt.length;
      await child.stdin.write(`${step.answer}\n`);
      await child.stdin.flush();
    }
    await child.stdin.end();
    const exitCode = await child.exited;
    await Promise.all([stdoutReader, stderrReader]);
    return { stdout, stderr, exitCode };
  } catch (error) {
    child.kill();
    await child.exited;
    throw error;
  }
}

const requireSuccess = (
  result: Awaited<ReturnType<typeof command>>,
  name: string,
): void => {
  if (result.exitCode !== 0)
    throw new Error(
      `${name} failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
};

const clearCache = async (directory: string): Promise<void> => {
  // Reads must observe other devices' writes; drop the local cache so the
  // snapshot is refetched from PostgreSQL instead of served within the TTL.
  await rm(join(directory, ".jobsmith", "cache"), {
    recursive: true,
    force: true,
  });
};

const readPending = async (
  directory: string,
): Promise<Awaited<ReturnType<typeof command>>> => {
  await clearCache(directory);
  return command(directory, ["pending"]);
};

async function withDatabaseRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < 6) await Bun.sleep(attempt * 300);
    }
  }
  throw lastError;
}

const hostDirectory = join(import.meta.dir, "../jobsmith_test");
await mkdir(hostDirectory, { recursive: true });
if (await Bun.file(join(hostDirectory, ".jobsmith", "config.json")).exists())
  throw new Error(
    "jobsmith_test is already initialized; refusing to overwrite it",
  );
const root = await mkdtemp(join(hostDirectory, ".e2e-"));
const joinDirectory = join(root, "join");
const replayDirectory = join(root, "replay");
const expiryDirectory = join(root, "expiry");
await mkdir(joinDirectory);
await mkdir(replayDirectory);
await mkdir(expiryDirectory);

let projectId: string | undefined;
let reinitializedProjectId: string | undefined;
const sql = postgres(process.env.DATABASE_URL!, {
  max: 1,
  connect_timeout: 10,
});
try {
  const help = await command(hostDirectory, ["help"]);
  requireSuccess(help, "help command");
  for (const expected of [
    "jobsmith init",
    "jobsmith connect",
    "jobsmith manager",
    "jobsmith worker",
    "jobsmith update",
    "jobsmith pending",
  ])
    if (!help.stdout.includes(expected))
      throw new Error(`Help omitted ${expected}`);

  const initialized = await command(
    hostDirectory,
    ["init"],
    [
      { prompt: "Select a number", answer: "1" },
      { prompt: "Project name", answer: "Live smoke project" },
      { prompt: "Your name", answer: "Host" },
    ],
  );
  requireSuccess(initialized, "host initialization");
  const invitation = initialized.stdout.match(/jsm1_[A-Za-z0-9_-]+/)?.[0];
  if (!invitation)
    throw new Error("Host initialization did not produce a connection string");

  const joined = await command(
    joinDirectory,
    ["init"],
    [
      { prompt: "Select a number", answer: "2" },
      { prompt: "Connection string", answer: invitation },
      { prompt: "Your name", answer: "Smoke agent" },
      { prompt: "Select a number", answer: "2" },
    ],
  );
  requireSuccess(joined, "member join");

  const replayedInvite = await command(
    replayDirectory,
    ["init"],
    [
      { prompt: "Select a number", answer: "2" },
      { prompt: "Connection string", answer: invitation },
      { prompt: "Your name", answer: "Replay" },
      { prompt: "Select a number", answer: "1" },
    ],
  );
  if (
    replayedInvite.exitCode === 0 ||
    !replayedInvite.stderr.includes("invalid, expired, or already used")
  )
    throw new Error("One-use connection string accepted a replay");

  const hostConfig = await Bun.file(
    join(hostDirectory, ".jobsmith", "config.json"),
  ).json();
  projectId = hostConfig.projectId as string;

  const hostConnect = await command(hostDirectory, ["connect"]);
  requireSuccess(hostConnect, "host connect command");
  const expiringInvitation =
    hostConnect.stdout.match(/jsm1_[A-Za-z0-9_-]+/)?.[0];
  if (!expiringInvitation)
    throw new Error("Host connect command did not produce a connection string");
  const expiringInviteId = decodeInvite(expiringInvitation).inviteId;
  await withDatabaseRetry(
    async () =>
      await sql`UPDATE jobsmith_invites SET expires_at=clock_timestamp()-interval '1 second'
        WHERE id=${expiringInviteId}`,
  );
  const expiredJoin = await command(
    expiryDirectory,
    ["init"],
    [
      { prompt: "Select a number", answer: "2" },
      { prompt: "Connection string", answer: expiringInvitation },
      { prompt: "Your name", answer: "Expired member" },
      { prompt: "Select a number", answer: "1" },
    ],
  );
  if (
    expiredJoin.exitCode === 0 ||
    !expiredJoin.stderr.includes("invalid, expired, or already used")
  )
    throw new Error("Expired connection string was accepted");

  const created = await command(
    hostDirectory,
    ["manager"],
    [
      { prompt: "Job name", answer: "Verify collaboration" },
      { prompt: "Description", answer: "Exercise terminal state updates" },
      { prompt: "Select a number", answer: "3" },
      { prompt: "Due date", answer: "" },
      { prompt: "Tags", answer: "smoke,cli" },
      { prompt: "Create this job?", answer: "y" },
    ],
  );
  requireSuccess(created, "manager command");

  const pending = await readPending(joinDirectory);
  requireSuccess(pending, "pending command");
  if (
    !pending.stdout.includes("Verify collaboration") ||
    !pending.stdout.includes("PENDING")
  )
    throw new Error("Joined member did not see the pending job");

  const claimed = await command(
    joinDirectory,
    ["worker"],
    [{ prompt: "Select numbers separated by commas", answer: "1" }],
  );
  requireSuccess(claimed, "worker claim");
  if (!claimed.stdout.includes("Run 'jobsmith update' when done."))
    throw new Error("Worker command did not hand the terminal back");

  const saved = await command(
    joinDirectory,
    ["update"],
    [
      { prompt: "Select a number", answer: "1" },
      { prompt: "Progress note", answer: "First implementation note" },
      { prompt: "Select a number", answer: "2" },
      { prompt: "Progress (0-100)", answer: "40" },
      { prompt: "Select a number", answer: "8" },
    ],
  );
  requireSuccess(saved, "update note, progress, and save");
  if (!saved.stdout.includes("Work session saved"))
    throw new Error("Worker session was not saved");

  const inProgress = await readPending(hostDirectory);
  requireSuccess(inProgress, "pending in-progress view");
  if (!inProgress.stdout.includes("IN_PROGRESS"))
    throw new Error("Pending command omitted the in-progress state");

  requireSuccess(
    await command(
      joinDirectory,
      ["worker"],
      [{ prompt: "Select numbers separated by commas", answer: "1" }],
    ),
    "worker claim before pause",
  );
  const paused = await command(
    joinDirectory,
    ["update"],
    [
      { prompt: "Select a number", answer: "3" },
      { prompt: "Pause note", answer: "smoke pause" },
    ],
  );
  requireSuccess(paused, "update pause");
  const pausedView = await readPending(hostDirectory);
  if (!pausedView.stdout.includes("PAUSED"))
    throw new Error("Pending command omitted the paused state");

  requireSuccess(
    await command(
      joinDirectory,
      ["worker"],
      [{ prompt: "Select numbers separated by commas", answer: "1" }],
    ),
    "worker claim before block",
  );
  const blocked = await command(
    joinDirectory,
    ["update"],
    [
      { prompt: "Select a number", answer: "4" },
      { prompt: "What is blocking", answer: "dependency unavailable" },
    ],
  );
  requireSuccess(blocked, "update block");
  const blockedView = await readPending(hostDirectory);
  if (!blockedView.stdout.includes("BLOCKED"))
    throw new Error("Pending command omitted the blocked state");

  requireSuccess(
    await command(
      joinDirectory,
      ["worker"],
      [{ prompt: "Select numbers separated by commas", answer: "1" }],
    ),
    "worker claim before release",
  );
  const released = await command(
    joinDirectory,
    ["update"],
    [
      { prompt: "Select a number", answer: "7" },
      { prompt: "Release this job", answer: "y" },
    ],
  );
  requireSuccess(released, "update release");
  const releasedView = await readPending(hostDirectory);
  if (!releasedView.stdout.includes("PENDING"))
    throw new Error("Released work did not return to pending");

  requireSuccess(
    await command(
      joinDirectory,
      ["worker"],
      [{ prompt: "Select numbers separated by commas", answer: "1" }],
    ),
    "worker claim before completion",
  );
  const completed = await command(
    joinDirectory,
    ["update"],
    [
      { prompt: "Select a number", answer: "5" },
      { prompt: "Mark this job completed?", answer: "y" },
    ],
  );
  requireSuccess(completed, "update completion");

  const failedJob = await command(
    hostDirectory,
    ["manager"],
    [
      { prompt: "Job name", answer: "Verify failure" },
      { prompt: "Description", answer: "Exercise the failed terminal state" },
      { prompt: "Select a number", answer: "2" },
      { prompt: "Due date", answer: "" },
      { prompt: "Tags", answer: "smoke,failure" },
      { prompt: "Create this job?", answer: "y" },
    ],
  );
  requireSuccess(failedJob, "second manager command");
  // The worker's cache predates the host's new job, so drop it before claiming.
  await clearCache(joinDirectory);
  requireSuccess(
    await command(
      joinDirectory,
      ["worker"],
      [{ prompt: "Select numbers separated by commas", answer: "1" }],
    ),
    "worker claim before failure",
  );
  const failed = await command(
    joinDirectory,
    ["update"],
    [
      { prompt: "Select a number", answer: "6" },
      { prompt: "Failure reason", answer: "Expected smoke-test failure" },
    ],
  );
  requireSuccess(failed, "update failure");

  const emptyPending = await readPending(hostDirectory);
  requireSuccess(emptyPending, "empty pending command");
  if (!emptyPending.stdout.includes("No pending jobs"))
    throw new Error("Terminal still showed terminal-state work as pending");

  if (!projectId) throw new Error("Smoke project identity was not loaded");
  const activeProjectId = projectId;
  const rows = await withDatabaseRetry(
    async () =>
      await sql<{ title: string; status: string; progress_percent: number }[]>`
      SELECT title,status,progress_percent FROM jobsmith_work_items
      WHERE project_id=${activeProjectId} ORDER BY title`,
  );
  const completedRow = rows.find((row) => row.title === "Verify collaboration");
  const failedRow = rows.find((row) => row.title === "Verify failure");
  if (
    completedRow?.status !== "COMPLETED" ||
    completedRow.progress_percent !== 100
  )
    throw new Error("Terminal workflow did not persist completion");
  if (failedRow?.status !== "FAILED")
    throw new Error("Terminal workflow did not persist failure");

  const events = await withDatabaseRetry(
    async () =>
      await sql<
        { event_type: string; to_status: string | null; note: string | null }[]
      >`
        SELECT event_type,to_status,note FROM jobsmith_work_events
        WHERE project_id=${activeProjectId}`,
  );
  for (const eventType of [
    "PROGRESS_NOTE",
    "PROGRESS_UPDATED",
    "WORK_SESSION_SAVED",
  ])
    if (!events.some((event) => event.event_type === eventType))
      throw new Error(`Audit trail omitted ${eventType}`);
  for (const state of ["PAUSED", "BLOCKED", "PENDING", "COMPLETED", "FAILED"])
    if (!events.some((event) => event.to_status === state))
      throw new Error(`Audit trail omitted ${state}`);

  const reinitialize = await command(joinDirectory, ["init"]);
  if (
    reinitialize.exitCode === 0 ||
    !reinitialize.stderr.includes("already initialized")
  )
    throw new Error(
      "Reinitialization guard did not reject an initialized folder",
    );

  const nonHostConnect = await command(joinDirectory, ["connect"]);
  if (
    nonHostConnect.exitCode === 0 ||
    !nonHostConnect.stderr.includes("Only the project host")
  )
    throw new Error("Host-only connection-string guard failed");

  const cancelledRemoval = await command(
    hostDirectory,
    ["remove"],
    [{ prompt: "Are you sure?", answer: "y" }],
  );
  requireSuccess(cancelledRemoval, "cancelled remove command");
  if (!cancelledRemoval.stdout.includes("Removal cancelled"))
    throw new Error("Remove accepted a value other than the full word yes");
  requireSuccess(
    await readPending(hostDirectory),
    "command after cancelled removal",
  );

  const memberRemoval = await command(
    joinDirectory,
    ["remove"],
    [{ prompt: "Are you sure?", answer: "yes" }],
  );
  requireSuccess(memberRemoval, "joined-member remove command");
  if (await Bun.file(join(joinDirectory, ".jobsmith", "config.json")).exists())
    throw new Error("Joined-member configuration remained after removal");

  const hostRemoval = await command(
    hostDirectory,
    ["remove"],
    [{ prompt: "Are you sure?", answer: "yes" }],
  );
  requireSuccess(hostRemoval, "host remove command");
  const afterRemoval = await readPending(hostDirectory);
  if (
    afterRemoval.exitCode === 0 ||
    !afterRemoval.stderr.includes("not initialized")
  )
    throw new Error("Removed folder still accepted project commands");

  const reinitialized = await command(
    hostDirectory,
    ["init"],
    [
      { prompt: "Select a number", answer: "1" },
      { prompt: "Project name", answer: "Reinitialized smoke project" },
      { prompt: "Your name", answer: "Host again" },
    ],
  );
  requireSuccess(reinitialized, "same-folder reinitialization");
  reinitializedProjectId = (
    await Bun.file(join(hostDirectory, ".jobsmith", "config.json")).json()
  ).projectId as string;
  const reinitializedPending = await readPending(hostDirectory);
  requireSuccess(reinitializedPending, "reinitialized project isolation");
  if (!reinitializedPending.stdout.includes("No pending jobs"))
    throw new Error("Reinitialized project exposed work from the old project");
  requireSuccess(
    await command(
      hostDirectory,
      ["remove"],
      [{ prompt: "Are you sure?", answer: "yes" }],
    ),
    "remove after reinitialization",
  );
  if (await Bun.file(join(hostDirectory, ".jobsmith", "config.json")).exists())
    throw new Error("Reinitialized folder was not removed cleanly");

  process.stdout.write(
    "Live CLI smoke passed in jobsmith_test: help, init, connect, manager, pending, every worker action, remove/reinitialize, invite guards, PostgreSQL, and Valkey.\n",
  );
} finally {
  try {
    const configFile = Bun.file(
      join(hostDirectory, ".jobsmith", "config.json"),
    );
    if (await configFile.exists()) {
      const configuredProjectId = (await configFile.json()).projectId as string;
      if (!projectId) projectId = configuredProjectId;
      else if (configuredProjectId !== projectId)
        reinitializedProjectId = configuredProjectId;
    }
    const cleanupProjectId = projectId;
    for (const id of [cleanupProjectId, reinitializedProjectId])
      if (id)
        await withDatabaseRetry(
          async () => await sql`DELETE FROM jobsmith_projects WHERE id=${id}`,
        );
  } finally {
    await sql.end();
    await rm(root, { recursive: true, force: true });
    await rm(join(hostDirectory, ".jobsmith"), {
      recursive: true,
      force: true,
    });
  }
}
