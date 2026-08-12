import { z } from "zod";
import type { Logger } from "pino";
import { parse } from "dotenv";
import { join } from "node:path";
import {
  loadDatabaseConfig,
  loadHostConfig,
  loadInviteTtl,
} from "../config/index.ts";
import { ProjectNotifier } from "../coordination/valkey.ts";
import { migrate } from "../db/migrate.ts";
import { checkDatabase, closeDatabase, createDatabase } from "../db/pool.ts";
import {
  localProjectExists,
  removeLocalProject,
  writeLocalProject,
  type LocalProject,
} from "../project/localConfig.ts";
import {
  decodeInvite,
  ProjectService,
  type JoinRole,
} from "../services/projectService.ts";
import { ask, askSecret, selectMenu } from "./terminal.ts";

const requiredName = async (question: string): Promise<string> =>
  z
    .string()
    .min(1)
    .max(120)
    .parse(await ask(question, { required: true }));

export async function runInit(log: Logger): Promise<void> {
  if (await localProjectExists())
    throw new Error("This folder is already initialized for Jobsmith");
  const mode = await selectMenu(
    "Set up Jobsmith in this folder",
    ["Initialize", "Join"] as const,
    (choice) =>
      choice === "Initialize"
        ? "Initialize — create and host a project"
        : "Join — connect to an existing project",
  );
  if (!mode) {
    process.stdout.write("Initialization cancelled.\n");
    return;
  }
  if (mode === "Initialize") await initializeHost(log);
  else await joinProject(log);
}

async function initializeHost(log: Logger): Promise<void> {
  const installationEnvironmentPath = join(import.meta.dir, "../../.env");
  const installationEnvironment = (await Bun.file(
    installationEnvironmentPath,
  ).exists())
    ? parse(await Bun.file(installationEnvironmentPath).text())
    : {};
  const source = { ...installationEnvironment, ...process.env };
  const databaseUrl =
    source.DATABASE_URL ?? (await askSecret("PostgreSQL connection URL"));
  const valkeyUrl =
    source.VALKEY_URL ??
    (await ask("Valkey connection URL", {
      required: true,
      defaultValue: "redis://127.0.0.1:6379",
    }));
  const config = loadHostConfig({
    ...source,
    DATABASE_URL: databaseUrl,
    VALKEY_URL: valkeyUrl,
  });
  const projectName = await requiredName("Project name");
  const memberName = await requiredName("Your name");
  await migrate(config.DATABASE_URL);
  const sql = createDatabase(config, log);
  const notifier = new ProjectNotifier(config.VALKEY_URL, "initializing", log);
  try {
    await checkDatabase(sql, log);
    await notifier.check();
    const projects = new ProjectService(sql, log);
    const project = await projects.initialize({
      projectName,
      memberName,
      databaseUrl: config.DATABASE_URL,
      valkeyUrl: config.VALKEY_URL,
    });
    await writeLocalProject(process.cwd(), project);
    const invite = await projects.createInvite(
      project,
      config.INVITE_TTL_MINUTES,
    );
    process.stdout.write(
      `\nInitialized ${project.projectName}. You are the host.\n\nConnection string (one use; expires ${invite.expiresAt.toISOString()}):\n${invite.value}\n\nTreat this connection string as a secret.\n`,
    );
  } finally {
    await notifier.close();
    await closeDatabase(sql, log);
  }
}

async function joinProject(log: Logger): Promise<void> {
  const encoded = await ask("Connection string", { required: true });
  const invite = decodeInvite(encoded);
  const memberName = await requiredName("Your name");
  const selectedRole = await selectMenu(
    "How will this member work?",
    ["MEMBER", "AGENT"] as const,
    (role) => (role === "MEMBER" ? "Person" : "AI agent"),
  );
  if (!selectedRole) {
    process.stdout.write("Join cancelled.\n");
    return;
  }
  const role: JoinRole = selectedRole;
  const databaseConfig = loadDatabaseConfig({
    ...process.env,
    DATABASE_URL: invite.databaseUrl,
    DATABASE_MIGRATION_URL: undefined,
  });
  const sql = createDatabase(databaseConfig, log);
  const notifier = new ProjectNotifier(invite.valkeyUrl, invite.projectId, log);
  try {
    await checkDatabase(sql, log);
    await notifier.check();
    const project = await new ProjectService(sql, log).join({
      invite,
      memberName,
      role,
    });
    await writeLocalProject(process.cwd(), project);
    await notifier.publish("member.joined");
    process.stdout.write(
      `\nJoined ${project.projectName} as ${project.memberName}.\n`,
    );
  } finally {
    await notifier.close();
    await closeDatabase(sql, log);
  }
}

export async function runConnect(
  project: LocalProject,
  log: Logger,
): Promise<void> {
  if (project.role !== "HOST")
    throw new Error("Only the project host can run `jobsmith connect`");
  const config = loadDatabaseConfig({
    ...process.env,
    DATABASE_URL: project.databaseUrl,
    DATABASE_MIGRATION_URL: undefined,
  });
  const sql = createDatabase(config, log);
  try {
    await checkDatabase(sql, log);
    const invite = await new ProjectService(sql, log).createInvite(
      project,
      loadInviteTtl(),
    );
    process.stdout.write(
      `\nConnection string (one use; expires ${invite.expiresAt.toISOString()}):\n${invite.value}\n\nTreat this connection string as a secret.\n`,
    );
  } finally {
    await closeDatabase(sql, log);
  }
}

export async function runRemove(
  root: string,
  project: LocalProject,
  log: Logger,
): Promise<void> {
  process.stdout.write(
    `This will remove Jobsmith initialization from ${root}.\nShared project data will not be deleted.\n`,
  );
  const confirmation = (
    await ask("Are you sure? Type yes to remove")
  ).toLowerCase();
  if (confirmation !== "yes") {
    process.stdout.write("Removal cancelled.\n");
    return;
  }
  await removeLocalProject(root);
  log.info(
    {
      event: "project.local_removed",
      projectId: project.projectId,
      memberId: project.memberId,
      role: project.role,
    },
    "Local project initialization removed",
  );
  process.stdout.write(
    "Jobsmith initialization removed. Run `jobsmith init` to initialize this folder again.\n",
  );
}
