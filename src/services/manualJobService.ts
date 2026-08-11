import type { Logger } from "pino";
import type { ProjectNotifier } from "../coordination/valkey.ts";
import type { Database } from "../db/pool.ts";
import { inTransaction } from "../db/transaction.ts";
import type { LocalProject } from "../project/localConfig.ts";

export type WorkState =
  | "PENDING"
  | "READY"
  | "IN_PROGRESS"
  | "PAUSED"
  | "BLOCKED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export interface ManualJob {
  id: string;
  title: string;
  description: string;
  priority: number;
  state: WorkState;
  progressPercent: number;
  assignedWorkerName: string | null;
  tags: string[];
  dueAt: Date | null;
  blockedReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ManualJobRow {
  id: string;
  title: string;
  description: string;
  priority: number;
  state: WorkState;
  progress_percent: number;
  assigned_worker_name: string | null;
  tags: string[];
  due_at: Date | null;
  blocked_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

const mapJob = (row: ManualJobRow): ManualJob => ({
  id: row.id,
  title: row.title,
  description: row.description,
  priority: row.priority,
  state: row.state,
  progressPercent: row.progress_percent,
  assignedWorkerName: row.assigned_worker_name,
  tags: row.tags,
  dueAt: row.due_at,
  blockedReason: row.blocked_reason,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const fields = `id,title,description,priority,status AS state,progress_percent,
  assigned_worker_name,tags,due_at,blocked_reason,created_at,updated_at`;

export class ManualJobService {
  constructor(
    private readonly sql: Database,
    private readonly project: LocalProject,
    private readonly notifier: Pick<ProjectNotifier, "publish">,
    private readonly log: Logger,
  ) {}

  async create(input: {
    title: string;
    description: string;
    priority: number;
    tags: string[];
    dueAt: Date | null;
  }): Promise<ManualJob> {
    const id = crypto.randomUUID();
    const job = await inTransaction(
      this.sql,
      "work_item.create",
      async (tx) => {
        const rows = await tx<ManualJobRow[]>`
        INSERT INTO jobsmith_work_items(id,project_id,title,description,priority,status,tags,due_at)
        VALUES(${id},${this.project.projectId},${input.title},${input.description},${input.priority},'PENDING',${input.tags},${input.dueAt})
        RETURNING ${tx.unsafe(fields)}`;
        await tx`INSERT INTO jobsmith_work_events(project_id,work_item_id,event_type,to_status,member_id,worker_name,metadata)
        VALUES(${this.project.projectId},${id},'JOB_CREATED','PENDING',${this.project.memberId},${this.project.memberName},${tx.json({ title: input.title })})`;
        return mapJob(rows[0]!);
      },
    );
    this.log.info(
      {
        event: "work_item.created",
        projectId: this.project.projectId,
        jobId: id,
        priority: input.priority,
      },
      "Work item created",
    );
    await this.notifier.publish("work.created", id);
    return job;
  }

  async listPending(limit = 100): Promise<ManualJob[]> {
    const rows = await this.sql<ManualJobRow[]>`
      SELECT ${this.sql.unsafe(fields)} FROM jobsmith_work_items
      WHERE project_id=${this.project.projectId}
        AND status IN ('PENDING','READY','IN_PROGRESS','PAUSED','BLOCKED')
      ORDER BY CASE status WHEN 'BLOCKED' THEN 0 WHEN 'IN_PROGRESS' THEN 1 ELSE 2 END,
        priority DESC,created_at LIMIT ${limit}`;
    return rows.map(mapJob);
  }

  async listForWorker(limit = 100): Promise<ManualJob[]> {
    const rows = await this.sql<ManualJobRow[]>`
      SELECT ${this.sql.unsafe(fields)} FROM jobsmith_work_items
      WHERE project_id=${this.project.projectId} AND (
        (status IN ('PENDING','READY') AND assigned_member_id IS NULL) OR
        (status IN ('IN_PROGRESS','PAUSED','BLOCKED') AND assigned_member_id=${this.project.memberId})
      )
      ORDER BY CASE WHEN assigned_member_id=${this.project.memberId} THEN 0 ELSE 1 END,
        priority DESC,created_at LIMIT ${limit}`;
    return rows.map(mapJob);
  }

  async claim(id: string): Promise<ManualJob> {
    const job = await inTransaction(this.sql, "work_item.claim", async (tx) => {
      const targets = await tx<
        { status: WorkState; assigned_member_id: string | null }[]
      >`
        SELECT status,assigned_member_id FROM jobsmith_work_items
        WHERE id=${id} AND project_id=${this.project.projectId} FOR UPDATE`;
      const target = targets[0];
      const available =
        target &&
        ((["PENDING", "READY"].includes(target.status) &&
          target.assigned_member_id === null) ||
          (["IN_PROGRESS", "PAUSED", "BLOCKED"].includes(target.status) &&
            target.assigned_member_id === this.project.memberId));
      if (!available || !target) throw new Error("Job is no longer available");
      const rows = await tx<ManualJobRow[]>`
        UPDATE jobsmith_work_items SET status='IN_PROGRESS',assigned_member_id=${this.project.memberId},
          assigned_worker_name=${this.project.memberName},blocked_reason=NULL,
          started_at=COALESCE(started_at,clock_timestamp()),version=version+1,updated_at=clock_timestamp()
        WHERE id=${id} AND project_id=${this.project.projectId}
        RETURNING ${tx.unsafe(fields)}`;
      await tx`INSERT INTO jobsmith_work_events(project_id,work_item_id,event_type,from_status,to_status,member_id,worker_name,metadata)
        VALUES(${this.project.projectId},${id},'WORK_STARTED',${target.status},'IN_PROGRESS',${this.project.memberId},${this.project.memberName},${tx.json({ resumed: !["PENDING", "READY"].includes(target.status) })})`;
      return mapJob(rows[0]!);
    });
    this.log.info(
      {
        event: "work_item.claimed",
        projectId: this.project.projectId,
        jobId: id,
        memberId: this.project.memberId,
      },
      "Work item claimed",
    );
    await this.notifier.publish("work.claimed", id);
    return job;
  }

  async addNote(id: string, note: string): Promise<void> {
    await inTransaction(this.sql, "work_item.note", async (tx) => {
      const updated =
        await tx`UPDATE jobsmith_work_items SET updated_at=clock_timestamp(),version=version+1
        WHERE id=${id} AND project_id=${this.project.projectId} AND status='IN_PROGRESS'
          AND assigned_member_id=${this.project.memberId} RETURNING id`;
      if (!updated.length) throw new Error("You no longer own this job");
      await tx`INSERT INTO jobsmith_work_events(project_id,work_item_id,event_type,from_status,to_status,member_id,worker_name,note)
        VALUES(${this.project.projectId},${id},'PROGRESS_NOTE','IN_PROGRESS','IN_PROGRESS',${this.project.memberId},${this.project.memberName},${note})`;
    });
    this.log.info(
      {
        event: "work_item.note_added",
        jobId: id,
        memberId: this.project.memberId,
      },
      "Progress note added",
    );
    await this.notifier.publish("work.updated", id);
  }

  async setProgress(id: string, progress: number): Promise<void> {
    await inTransaction(this.sql, "work_item.progress", async (tx) => {
      const updated =
        await tx`UPDATE jobsmith_work_items SET progress_percent=${progress},updated_at=clock_timestamp(),version=version+1
        WHERE id=${id} AND project_id=${this.project.projectId} AND status='IN_PROGRESS'
          AND assigned_member_id=${this.project.memberId} RETURNING id`;
      if (!updated.length) throw new Error("You no longer own this job");
      await tx`INSERT INTO jobsmith_work_events(project_id,work_item_id,event_type,from_status,to_status,member_id,worker_name,metadata)
        VALUES(${this.project.projectId},${id},'PROGRESS_UPDATED','IN_PROGRESS','IN_PROGRESS',${this.project.memberId},${this.project.memberName},${tx.json({ progress })})`;
    });
    this.log.info(
      {
        event: "work_item.progress_updated",
        jobId: id,
        memberId: this.project.memberId,
        progress,
      },
      "Work item progress updated",
    );
    await this.notifier.publish("work.updated", id);
  }

  async transition(
    id: string,
    outcome: "PAUSED" | "BLOCKED" | "COMPLETED" | "FAILED" | "PENDING",
    message?: string,
  ): Promise<void> {
    await inTransaction(this.sql, "work_item.transition", async (tx) => {
      const updated = await tx`UPDATE jobsmith_work_items SET status=${outcome},
        progress_percent=CASE WHEN ${outcome}='COMPLETED' THEN 100 ELSE progress_percent END,
        assigned_member_id=CASE WHEN ${outcome}='PENDING' THEN NULL ELSE assigned_member_id END,
        assigned_worker_name=CASE WHEN ${outcome}='PENDING' THEN NULL ELSE assigned_worker_name END,
        blocked_reason=CASE WHEN ${outcome}='BLOCKED' THEN ${message ?? "Blocked"} ELSE NULL END,
        completed_at=CASE WHEN ${outcome}='COMPLETED' THEN clock_timestamp() ELSE completed_at END,
        failed_at=CASE WHEN ${outcome}='FAILED' THEN clock_timestamp() ELSE failed_at END,
        failure_reason=CASE WHEN ${outcome}='FAILED' THEN ${message ?? "Worker marked job failed"} ELSE failure_reason END,
        updated_at=clock_timestamp(),version=version+1
        WHERE id=${id} AND project_id=${this.project.projectId} AND status='IN_PROGRESS'
          AND assigned_member_id=${this.project.memberId} RETURNING id`;
      if (!updated.length) throw new Error("You no longer own this job");
      await tx`INSERT INTO jobsmith_work_events(project_id,work_item_id,event_type,from_status,to_status,member_id,worker_name,note)
        VALUES(${this.project.projectId},${id},'WORK_STATE_CHANGED','IN_PROGRESS',${outcome},${this.project.memberId},${this.project.memberName},${message ?? null})`;
    });
    this.log.info(
      {
        event: "work_item.state_changed",
        jobId: id,
        memberId: this.project.memberId,
        outcome,
      },
      "Work item state changed",
    );
    await this.notifier.publish("work.state_changed", id);
  }

  async saveSession(id: string): Promise<void> {
    const saved = await this
      .sql`INSERT INTO jobsmith_work_events(project_id,work_item_id,event_type,from_status,to_status,member_id,worker_name)
      SELECT project_id,id,'WORK_SESSION_SAVED','IN_PROGRESS','IN_PROGRESS',${this.project.memberId},${this.project.memberName}
      FROM jobsmith_work_items WHERE id=${id} AND project_id=${this.project.projectId}
        AND status='IN_PROGRESS' AND assigned_member_id=${this.project.memberId} RETURNING id`;
    if (!saved.length) throw new Error("You no longer own this job");
    this.log.info(
      {
        event: "work_item.session_saved",
        jobId: id,
        memberId: this.project.memberId,
      },
      "Worker session saved",
    );
    await this.notifier.publish("work.updated", id);
  }
}
