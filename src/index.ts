#!/usr/bin/env bun
import {
  runManager,
  runPending,
  runUpdate,
  runWorker,
} from "./cli/manualApp.ts";
import { runDaemonCommand, runStatus } from "./cli/daemonApp.ts";
import { runConnect, runInit, runRemove } from "./cli/projectApp.ts";
import { loadDatabaseConfig } from "./config/index.ts";
import { ProjectNotifier } from "./coordination/valkey.ts";
import { closeDatabase, createDatabase } from "./db/pool.ts";
import { createLogger } from "./observability/logger.ts";
import { findLocalProject } from "./project/localConfig.ts";
import { ManualJobService } from "./services/manualJobService.ts";

const help = `jobsmith — shared terminal work coordination

Usage:
  jobsmith init      Initialize this folder or join an existing project
  jobsmith connect   Generate a one-use connection string (host only)
  jobsmith remove    Remove Jobsmith initialization from this folder
  jobsmith manager   Enlist a new job through an interactive wizard
  jobsmith worker    Select and claim one or more jobs
  jobsmith update    Report progress or finish claimed work
  jobsmith pending   Show all unfinished jobs and their states
  jobsmith daemon    Start, stop, or check the background online worker
  jobsmith status    Show which workers are online
  jobsmith help      Show this help
`;

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";
  if (["help", "--help", "-h"].includes(command)) {
    process.stdout.write(help);
    return;
  }
  if (
    ![
      "init",
      "connect",
      "remove",
      "manager",
      "worker",
      "update",
      "pending",
      "daemon",
      "status",
    ].includes(command)
  ) {
    process.stderr.write(`Unknown command: ${command}\n\n${help}`);
    process.exitCode = 1;
    return;
  }

  const log = createLogger("jobsmith");
  if (command === "init") {
    await runInit(log);
    return;
  }

  const { root, config: project } = await findLocalProject();
  if (command === "remove") {
    await runRemove(root, project, log);
    return;
  }
  if (command === "connect") {
    await runConnect(project, log);
    return;
  }
  if (command === "daemon") {
    await runDaemonCommand(root, process.argv[3], log);
    return;
  }
  if (command === "status") {
    await runStatus(project, log);
    return;
  }

  const databaseConfig = loadDatabaseConfig({
    ...process.env,
    DATABASE_URL: project.databaseUrl,
    DATABASE_MIGRATION_URL: undefined,
  });
  const sql = createDatabase(databaseConfig, log);
  const notifier =
    command === "pending"
      ? null
      : new ProjectNotifier(project.valkeyUrl, project.projectId, log);
  try {
    const jobs = new ManualJobService(
      sql,
      project,
      notifier ?? { publish: async () => {} },
      log,
    );
    log.info(
      {
        event: "cli.started",
        command,
        projectId: project.projectId,
        memberId: project.memberId,
      },
      "Jobsmith command started",
    );
    if (command === "manager") await runManager(jobs, project, root);
    else if (command === "worker") await runWorker(jobs, project, root);
    else if (command === "update")
      await runUpdate(jobs, project, root, process.argv[3]);
    else await runPending(jobs, root);
    log.info(
      { event: "cli.completed", command, projectId: project.projectId },
      "Jobsmith command completed",
    );
  } finally {
    await notifier?.close();
    await closeDatabase(sql, log);
  }
}

await main().catch((error: unknown) => {
  if (error instanceof Error && error.message === "Input cancelled") {
    process.stdout.write("\nCancelled.\n");
    process.exitCode = 130;
    return;
  }
  let message = error instanceof Error ? error.message : String(error);
  if (!message && error instanceof AggregateError) {
    const cause = error.errors.find(
      (candidate): candidate is Error => candidate instanceof Error,
    );
    message = cause?.message ?? error.name;
  }
  process.stderr.write(`Jobsmith failed: ${message || "unknown error"}\n`);
  process.exitCode = 1;
});
