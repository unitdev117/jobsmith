import type { Logger } from "pino";
import type { ProjectNotifier } from "../coordination/valkey.ts";
import type { Database } from "../db/pool.ts";
import { inTransaction } from "../db/transaction.ts";
import type { LocalProject } from "../project/localConfig.ts";
import { decodeJobCursor, encodeJobCursor, jobRank } from "./pagination.ts";
import { ServiceError } from "./errors.ts";

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
  assignedMemberId: string | null;
  assignedWorkerName: string | null;
  tags: string[];
  dueAt: Date | null;
  blockedReason: string | null;
  claimedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PendingFetch {
  jobs: ManualJob[];
  truncated: boolean;
}

export interface JobPage {
  jobs: ManualJob[];
  nextCursor: string | null;
}

export interface ClaimFailure {
  id: string;
  reason: string;
}

interface ManualJobRow {
  id: string;
  title: string;
  description: string;
  priority: number;
  state: WorkState;
  progress_percent: number;
  assigned_member_id: string | null;
  assigned_worker_name: string | null;
  tags: string[];
  due_at: Date | null;
  blocked_reason: string | null;
  claimed_until: Date | null;
  created_at: Date;
  updated_at: Date;
}

// Pagination needs sub-millisecond precision JS Date cannot hold.
interface PagedJobRow extends ManualJobRow {
  created_at_us: string;
}

const mapJob = (row: ManualJobRow): ManualJob => ({
  id: row.id,
  title: row.title,
  description: row.description,
  priority: row.priority,
  state: row.state,
  progressPercent: row.progress_percent,
  assignedMemberId: row.assigned_member_id,
  assignedWorkerName: row.assigned_worker_name,
  tags: row.tags,
  dueAt: row.due_at,
  blockedReason: row.blocked_reason,
  claimedUntil: row.claimed_until,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const fields = `id,title,description,priority,status AS state,progress_percent,
  assigned_member_id,assigned_worker_name,tags,due_at,blocked_reason,claimed_until,created_at,updated_at`;

export const ACTIVE_STATES = ["IN_PROGRESS", "PAUSED", "BLOCKED"] as const;

// A claim is a lease. Owners refresh it on every touch; an expired lease
// lets another worker take over, so abandoned sessions never strand work.
export const DEFAULT_CLAIM_LEASE_MINUTES = 30;

export const DEFAULT_PENDING_LIMIT = 100;

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

export class ManualJobService {
  constructor(
    private readonly sql: Database,
    private readonly project: LocalProject,
    private readonly notifier: Pick<ProjectNotifier, "publish">,
    private readonly log: Logger,
    private readonly claimLeaseMinutes = DEFAULT_CLAIM_LEASE_MINUTES,
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

  async listPending(limit = DEFAULT_PENDING_LIMIT): Promise<PendingFetch> {
    const rows = await this.sql<ManualJobRow[]>`
      SELECT ${this.sql.unsafe(fields)} FROM jobsmith_work_items
      WHERE project_id=${this.project.projectId}
        AND status IN ('PENDING','READY','IN_PROGRESS','PAUSED','BLOCKED')
      ORDER BY CASE status WHEN 'BLOCKED' THEN 0 WHEN 'IN_PROGRESS' THEN 1 ELSE 2 END,
        priority DESC,created_at LIMIT ${limit + 1}`;
    return {
      jobs: rows.slice(0, limit).map(mapJob),
      truncated: rows.length > limit,
    };
  }

  async listPage(
    options: {
      limit?: number;
      cursor?: string | null;
      state?: WorkState;
    } = {},
  ): Promise<JobPage> {
    const limit = Math.min(
      MAX_PAGE_LIMIT,
      Math.max(1, options.limit ?? DEFAULT_PAGE_LIMIT),
    );
    const decoded = options.cursor ? decodeJobCursor(options.cursor) : null;
    const rank = () =>
      this
        .sql`CASE status WHEN 'BLOCKED' THEN 0 WHEN 'IN_PROGRESS' THEN 1 ELSE 2 END`;
    const scope =
      options.state !== undefined
        ? this
            .sql`project_id=${this.project.projectId} AND status=${options.state}`
        : this.sql`project_id=${this.project.projectId}
      AND status IN ('PENDING','READY','IN_PROGRESS','PAUSED','BLOCKED')`;
    // Keyset predicate mirrors the ORDER BY so new high-priority inserts
    // cannot shift or duplicate later pages; the microsecond key keeps the
    // boundary row exact where ISO milliseconds would round it back in.
    const where = decoded
      ? this.sql`${scope} AND (
          ${rank()} > ${decoded.rank} OR
          (${rank()} = ${decoded.rank} AND priority < ${decoded.priority}) OR
          (${rank()} = ${decoded.rank} AND priority = ${decoded.priority} AND created_at > (DATE 'epoch' + ${decoded.createdAtUs}::numeric * INTERVAL '1 microsecond')) OR
          (${rank()} = ${decoded.rank} AND priority = ${decoded.priority} AND created_at = (DATE 'epoch' + ${decoded.createdAtUs}::numeric * INTERVAL '1 microsecond') AND id > ${decoded.id})
        )`
      : scope;
    const rows = await this.sql<PagedJobRow[]>`
      SELECT ${this.sql.unsafe(fields)},
        (EXTRACT(EPOCH FROM created_at)*1000000)::bigint AS created_at_us
      FROM jobsmith_work_items
      WHERE ${where}
      ORDER BY ${rank()},priority DESC,created_at,id
      LIMIT ${limit + 1}`;
    const jobs = rows.slice(0, limit).map(mapJob);
    const hasNext = rows.length > limit;
    const last = rows[limit - 1];
    const nextCursor =
      hasNext && last
        ? encodeJobCursor({
            rank: jobRank(last.state),
            priority: last.priority,
            createdAt: last.created_at.toISOString(),
            createdAtUs: last.created_at_us,
            id: last.id,
          })
        : null;
    this.log.debug(
      {
        event: "work_item.page_fetched",
        projectId: this.project.projectId,
        limit,
        hasCursor: decoded !== null,
        count: jobs.length,
        hasNext,
      },
      "Work item page fetched",
    );
    return { jobs, nextCursor };
  }

  async countAll(state?: WorkState): Promise<number> {
    const scope =
      state !== undefined ? this.sql`AND status=${state}` : this.sql``;
    const rows = await this.sql<{ total: string }[]>`
      SELECT COUNT(*)::text AS total FROM jobsmith_work_items
      WHERE project_id=${this.project.projectId} ${scope}`;
    const total = Number(rows[0]?.total ?? 0);
    this.log.debug(
      {
        event: "work_item.count_fetched",
        projectId: this.project.projectId,
        total,
        ...(state !== undefined ? { state } : {}),
      },
      "Work item total fetched",
    );
    return total;
  }

  private async claimInTx(tx: Database, id: string): Promise<ManualJob> {
    const targets = await tx<
      {
        status: WorkState;
        assigned_member_id: string | null;
        claimed_until: Date | null;
      }[]
    >`
      SELECT status,assigned_member_id,claimed_until FROM jobsmith_work_items
      WHERE id=${id} AND project_id=${this.project.projectId} FOR UPDATE`;
    const target = targets[0];
    const mine =
      target !== undefined &&
      target.assigned_member_id === this.project.memberId;
    const leaseExpired =
      target?.claimed_until != null && target.claimed_until <= new Date();
    const available =
      target &&
      ((["PENDING", "READY"].includes(target.status) &&
        target.assigned_member_id === null) ||
        (["IN_PROGRESS", "PAUSED", "BLOCKED"].includes(target.status) &&
          target.assigned_member_id === this.project.memberId) ||
        // An expired lease means the owning session is gone; anyone may
        // take over, including a re-claim by the same member.
        (["IN_PROGRESS", "PAUSED", "BLOCKED"].includes(target.status) &&
          leaseExpired));
    if (!available || !target)
      throw new ServiceError(409, "Job is no longer available");
    const rows = await tx<ManualJobRow[]>`
      UPDATE jobsmith_work_items SET status='IN_PROGRESS',assigned_member_id=${this.project.memberId},
        assigned_worker_name=${this.project.memberName},blocked_reason=NULL,
        claimed_until=clock_timestamp()+(${this.leaseMinutes()} * INTERVAL '1 minute'),
        started_at=COALESCE(started_at,clock_timestamp()),version=version+1,updated_at=clock_timestamp()
      WHERE id=${id} AND project_id=${this.project.projectId}
      RETURNING ${tx.unsafe(fields)}`;
    await tx`INSERT INTO jobsmith_work_events(project_id,work_item_id,event_type,from_status,to_status,member_id,worker_name,metadata)
      VALUES(${this.project.projectId},${id},'WORK_STARTED',${target.status},'IN_PROGRESS',${this.project.memberId},${this.project.memberName},${tx.json({ resumed: !["PENDING", "READY"].includes(target.status), tookOver: !mine && !["PENDING", "READY"].includes(target.status) })})`;
    return mapJob(rows[0]!);
  }

  private leaseMinutes(): number {
    return this.claimLeaseMinutes;
  }

  async claim(id: string): Promise<ManualJob> {
    const job = await inTransaction(this.sql, "work_item.claim", (tx) =>
      this.claimInTx(tx, id),
    );
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

  async claimMany(ids: string[]): Promise<{
    claimed: ManualJob[];
    failures: ClaimFailure[];
  }> {
    const claimed: ManualJob[] = [];
    const failures: ClaimFailure[] = [];
    await inTransaction(this.sql, "work_item.claim_many", async (tx) => {
      for (const id of ids) {
        // Caught here so earlier claims in the batch stay committed.
        try {
          claimed.push(await this.claimInTx(tx, id));
        } catch (error) {
          failures.push({
            id,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });
    if (claimed.length)
      this.log.info(
        {
          event: "work_item.claimed_many",
          projectId: this.project.projectId,
          memberId: this.project.memberId,
          count: claimed.length,
          failed: failures.length,
        },
        "Work items claimed",
      );
    await Promise.all(
      claimed.map((job) => this.notifier.publish("work.claimed", job.id)),
    );
    return { claimed, failures };
  }

  async cancel(id: string): Promise<ManualJob> {
    const job = await inTransaction(
      this.sql,
      "work_item.cancel",
      async (tx) => {
        const targets = await tx<
          { status: WorkState; assigned_member_id: string | null }[]
        >`
        SELECT status,assigned_member_id FROM jobsmith_work_items
        WHERE id=${id} AND project_id=${this.project.projectId} FOR UPDATE`;
        const target = targets[0];
        const cancellable =
          target &&
          ((target.status === "PENDING" &&
            target.assigned_member_id === null) ||
            (["IN_PROGRESS", "PAUSED", "BLOCKED"].includes(target.status) &&
              target.assigned_member_id === this.project.memberId));
        if (!cancellable || !target)
          throw new ServiceError(
            409,
            "Only unclaimed pending jobs or your own claimed jobs can be cancelled",
          );
        const rows = await tx<ManualJobRow[]>`
        UPDATE jobsmith_work_items SET status='CANCELLED',blocked_reason=NULL,
          completed_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
        WHERE id=${id} AND project_id=${this.project.projectId}
        RETURNING ${tx.unsafe(fields)}`;
        await tx`INSERT INTO jobsmith_work_events(project_id,work_item_id,event_type,from_status,to_status,member_id,worker_name,metadata)
        VALUES(${this.project.projectId},${id},'WORK_STATE_CHANGED',${target.status},'CANCELLED',${this.project.memberId},${this.project.memberName},${tx.json({ cancelled: true })})`;
        return mapJob(rows[0]!);
      },
    );
    this.log.info(
      {
        event: "work_item.cancelled",
        projectId: this.project.projectId,
        jobId: id,
        memberId: this.project.memberId,
      },
      "Work item cancelled",
    );
    await this.notifier.publish("work.state_changed", id);
    return job;
  }

  async update(
    id: string,
    patch: {
      title?: string;
      description?: string;
      priority?: number;
      tags?: string[];
      dueAt?: Date | null;
    },
  ): Promise<ManualJob> {
    const changes = (
      ["title", "description", "priority", "tags", "dueAt"] as const
    ).filter((field) => patch[field] !== undefined);
    const job = await inTransaction(
      this.sql,
      "work_item.update",
      async (tx) => {
        const targets = await tx<
          { status: WorkState; assigned_member_id: string | null }[]
        >`
        SELECT status,assigned_member_id FROM jobsmith_work_items
        WHERE id=${id} AND project_id=${this.project.projectId} FOR UPDATE`;
        const target = targets[0];
        if (!target) throw new ServiceError(404, "Work item not found");
        const editable =
          ((target.status === "PENDING" || target.status === "READY") &&
            target.assigned_member_id === null) ||
          (["IN_PROGRESS", "PAUSED", "BLOCKED"].includes(target.status) &&
            target.assigned_member_id === this.project.memberId);
        if (!editable || !target)
          throw new ServiceError(
            409,
            "Only unclaimed pending jobs or your own claimed jobs can be edited",
          );
        const rows = await tx<ManualJobRow[]>`
        UPDATE jobsmith_work_items SET
          title=COALESCE(${patch.title ?? null},title),
          description=COALESCE(${patch.description ?? null},description),
          priority=COALESCE(${patch.priority ?? null},priority),
          tags=COALESCE(${patch.tags ?? null},tags),
          ${patch.dueAt !== undefined ? tx`due_at=${patch.dueAt},` : tx``}
          claimed_until=CASE WHEN assigned_member_id=${this.project.memberId}
            THEN clock_timestamp()+(${this.claimLeaseMinutes} * INTERVAL '1 minute') ELSE claimed_until END,
          version=version+1,updated_at=clock_timestamp()
        WHERE id=${id} AND project_id=${this.project.projectId}
        RETURNING ${tx.unsafe(fields)}`;
        await tx`INSERT INTO jobsmith_work_events(project_id,work_item_id,event_type,to_status,member_id,worker_name,metadata)
        VALUES(${this.project.projectId},${id},'WORK_UPDATED',${target.status},${this.project.memberId},${this.project.memberName},${tx.json({ changed: changes })})`;
        return mapJob(rows[0]!);
      },
    );
    this.log.info(
      {
        event: "work_item.updated",
        projectId: this.project.projectId,
        jobId: id,
        memberId: this.project.memberId,
        changed: changes,
      },
      "Work item updated",
    );
    await this.notifier.publish("work.updated", id);
    return job;
  }

  async addNote(id: string, note: string): Promise<void> {
    await inTransaction(this.sql, "work_item.note", async (tx) => {
      const updated =
        await tx`UPDATE jobsmith_work_items SET updated_at=clock_timestamp(),version=version+1,
          claimed_until=clock_timestamp()+(${this.claimLeaseMinutes} * INTERVAL '1 minute')
        WHERE id=${id} AND project_id=${this.project.projectId} AND status='IN_PROGRESS'
          AND assigned_member_id=${this.project.memberId} RETURNING id`;
      if (!updated.length)
        throw new ServiceError(409, "You no longer own this job");
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
        await tx`UPDATE jobsmith_work_items SET progress_percent=${progress},updated_at=clock_timestamp(),version=version+1,
          claimed_until=clock_timestamp()+(${this.claimLeaseMinutes} * INTERVAL '1 minute')
        WHERE id=${id} AND project_id=${this.project.projectId} AND status='IN_PROGRESS'
          AND assigned_member_id=${this.project.memberId} RETURNING id`;
      if (!updated.length)
        throw new ServiceError(409, "You no longer own this job");
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
        claimed_until=CASE WHEN ${outcome} IN ('PENDING','COMPLETED','FAILED') THEN NULL
          ELSE clock_timestamp()+(${this.claimLeaseMinutes} * INTERVAL '1 minute') END,
        blocked_reason=CASE WHEN ${outcome}='BLOCKED' THEN ${message ?? "Blocked"} ELSE NULL END,
        completed_at=CASE WHEN ${outcome}='COMPLETED' THEN clock_timestamp() ELSE completed_at END,
        failed_at=CASE WHEN ${outcome}='FAILED' THEN clock_timestamp() ELSE failed_at END,
        failure_reason=CASE WHEN ${outcome}='FAILED' THEN ${message ?? "Worker marked job failed"} ELSE failure_reason END,
        updated_at=clock_timestamp(),version=version+1
        WHERE id=${id} AND project_id=${this.project.projectId} AND status='IN_PROGRESS'
          AND assigned_member_id=${this.project.memberId} RETURNING id`;
      if (!updated.length)
        throw new ServiceError(409, "You no longer own this job");
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
    const saved = await this.sql<{ id: string }[]>`
      WITH touched AS (
        UPDATE jobsmith_work_items
        SET updated_at=clock_timestamp(),
          claimed_until=clock_timestamp()+(${this.claimLeaseMinutes} * INTERVAL '1 minute')
        WHERE id=${id} AND project_id=${this.project.projectId}
          AND status='IN_PROGRESS' AND assigned_member_id=${this.project.memberId}
        RETURNING id
      )
      INSERT INTO jobsmith_work_events(project_id,work_item_id,event_type,from_status,to_status,member_id,worker_name)
      SELECT ${this.project.projectId},t.id,'WORK_SESSION_SAVED','IN_PROGRESS','IN_PROGRESS',${this.project.memberId},${this.project.memberName}
      FROM touched t RETURNING id`;
    if (!saved.length)
      throw new ServiceError(409, "You no longer own this job");
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
