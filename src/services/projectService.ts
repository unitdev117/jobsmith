import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Logger } from "pino";
import type { Database } from "../db/pool.ts";
import { inTransaction } from "../db/transaction.ts";
import type { LocalProject } from "../project/localConfig.ts";

const inviteSchema = z.object({
  version: z.literal(1),
  inviteId: z.string().uuid(),
  projectId: z.string().uuid(),
  projectName: z.string().min(1).max(120),
  token: z.string().min(32),
  databaseUrl: z.string().url().startsWith("postgresql://"),
  valkeyUrl: z
    .string()
    .url()
    .refine((url) => url.startsWith("redis://") || url.startsWith("rediss://")),
  expiresAt: z.string().datetime(),
});

type InvitePayload = z.infer<typeof inviteSchema>;
export type JoinRole = "MEMBER" | "AGENT";

const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

export function decodeInvite(value: string): InvitePayload {
  if (!value.startsWith("jsm1_"))
    throw new Error("Invalid Jobsmith connection string");
  try {
    return inviteSchema.parse(
      JSON.parse(Buffer.from(value.slice(5), "base64url").toString("utf8")),
    );
  } catch {
    throw new Error("Invalid Jobsmith connection string");
  }
}

export class ProjectService {
  constructor(
    private readonly sql: Database,
    private readonly log: Logger,
  ) {}

  async initialize(input: {
    projectName: string;
    memberName: string;
    databaseUrl: string;
    valkeyUrl: string;
  }): Promise<LocalProject> {
    const projectId = crypto.randomUUID();
    const memberId = crypto.randomUUID();
    const machineId = crypto.randomUUID();
    await inTransaction(this.sql, "project.initialize", async (tx) => {
      await tx`INSERT INTO jobsmith_projects(id,name) VALUES(${projectId},${input.projectName})`;
      await tx`INSERT INTO jobsmith_members(id,project_id,name,role,machine_id)
        VALUES(${memberId},${projectId},${input.memberName},'HOST',${machineId})`;
    });
    this.log.info(
      { event: "project.initialized", projectId, memberId },
      "Project initialized",
    );
    return {
      schemaVersion: 1,
      projectId,
      projectName: input.projectName,
      memberId,
      memberName: input.memberName,
      role: "HOST",
      machineId,
      databaseUrl: input.databaseUrl,
      valkeyUrl: input.valkeyUrl,
    };
  }

  async createInvite(
    project: LocalProject,
    ttlMinutes: number,
  ): Promise<{ value: string; expiresAt: Date }> {
    if (project.role !== "HOST")
      throw new Error("Only the project host can create connection strings");
    const inviteId = crypto.randomUUID();
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
    await this
      .sql`INSERT INTO jobsmith_invites(id,project_id,token_hash,created_by,expires_at)
      VALUES(${inviteId},${project.projectId},${hashToken(token)},${project.memberId},${expiresAt})`;
    const payload: InvitePayload = {
      version: 1,
      inviteId,
      projectId: project.projectId,
      projectName: project.projectName,
      token,
      databaseUrl: project.databaseUrl,
      valkeyUrl: project.valkeyUrl,
      expiresAt: expiresAt.toISOString(),
    };
    this.log.info(
      {
        event: "invite.created",
        projectId: project.projectId,
        inviteId,
        expiresAt,
      },
      "Connection string created",
    );
    return {
      value: `jsm1_${Buffer.from(JSON.stringify(payload)).toString("base64url")}`,
      expiresAt,
    };
  }

  async join(input: {
    invite: InvitePayload;
    memberName: string;
    role: JoinRole;
  }): Promise<LocalProject> {
    if (new Date(input.invite.expiresAt).getTime() <= Date.now())
      throw new Error("This connection string has expired");
    const memberId = crypto.randomUUID();
    const machineId = crypto.randomUUID();
    await inTransaction(this.sql, "project.join", async (tx) => {
      const rows = await tx<{ id: string }[]>`
        SELECT id FROM jobsmith_invites
        WHERE id=${input.invite.inviteId} AND project_id=${input.invite.projectId}
          AND token_hash=${hashToken(input.invite.token)} AND consumed_at IS NULL
          AND expires_at > clock_timestamp()
        FOR UPDATE`;
      if (!rows.length)
        throw new Error(
          "Connection string is invalid, expired, or already used",
        );
      await tx`INSERT INTO jobsmith_members(id,project_id,name,role,machine_id)
        VALUES(${memberId},${input.invite.projectId},${input.memberName},${input.role},${machineId})`;
      await tx`UPDATE jobsmith_invites SET consumed_at=clock_timestamp(),consumed_by=${memberId}
        WHERE id=${input.invite.inviteId}`;
    });
    this.log.info(
      {
        event: "project.joined",
        projectId: input.invite.projectId,
        memberId,
        role: input.role,
      },
      "Member joined project",
    );
    return {
      schemaVersion: 1,
      projectId: input.invite.projectId,
      projectName: input.invite.projectName,
      memberId,
      memberName: input.memberName,
      role: input.role,
      machineId,
      databaseUrl: input.invite.databaseUrl,
      valkeyUrl: input.invite.valkeyUrl,
    };
  }
}
