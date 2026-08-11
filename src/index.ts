#!/usr/bin/env bun
import { runManager, runPending, runWorker } from "./cli/manualApp.ts";
import { runConnect, runInit } from "./cli/projectApp.ts";
import { loadDatabaseConfig } from "./config/index.ts";
import { ProjectNotifier } from "./coordination/valkey.ts";
import { checkDatabase, closeDatabase, createDatabase } from "./db/pool.ts";
import { createLogger } from "./observability/logger.ts";
import { findLocalProject } from "./project/localConfig.ts";
import { ManualJobService } from "./services/manualJobService.ts";

const help = `jobsmith — shared terminal work coordination

Usage:
  jobsmith init      Initialize this folder or join an existing project
  jobsmith connect   Generate a one-use connection string (host only)
  jobsmith manager   Enlist a new job through an interactive wizard
  jobsmith worker    Select, claim, update, and finish a job
  jobsmith pending   Show all unfinished jobs and their states
  jobsmith help      Show this help
`;

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";
  if (["help", "--help", "-h"].includes(command)) {
    process.stdout.write(help);
    return;
  }
  if (!["init", "connect", "manager", "worker", "pending"].includes(command)) {
    process.stderr.write(`Unknown command: ${command}\n\n${help}`);
    process.exitCode = 1;
    return;
  }

  const log = createLogger("jobsmith");
  if (command === "init") {
    await runInit(log);
    return;
  }

  const { config: project } = await findLocalProject();
  if (command === "connect") {
    await runConnect(project, log);
    return;
  }

  const databaseConfig = loadDatabaseConfig({
    ...process.env,
    DATABASE_URL: project.databaseUrl,
    DATABASE_MIGRATION_URL: undefined,
  });
  const sql = createDatabase(databaseConfig, log);
  const notifier = new ProjectNotifier(
    project.valkeyUrl,
    project.projectId,
    log,
  );
  try {
    await checkDatabase(sql, log);
    await notifier.check();
    const jobs = new ManualJobService(sql, project, notifier, log);
    log.info(
      {
        event: "cli.started",
        command,
        projectId: project.projectId,
        memberId: project.memberId,
      },
      "Jobsmith command started",
    );
    if (command === "manager") await runManager(jobs, project);
    else if (command === "worker") await runWorker(jobs, project);
    else await runPending(jobs);
    log.info(
      { event: "cli.completed", command, projectId: project.projectId },
      "Jobsmith command completed",
    );
  } finally {
    await notifier.close();
    await closeDatabase(sql, log);
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(
    `Jobsmith failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
});
