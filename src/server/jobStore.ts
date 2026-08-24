import type { Logger } from "pino";
import type {
  ManualJob,
  ManualJobService,
  WorkState,
} from "../services/manualJobService.ts";
import {
  decodeJobCursor,
  encodeJobCursor,
  jobRank,
  type JobCursor,
} from "../services/pagination.ts";
import { ServiceError } from "../services/errors.ts";
import type { EventBusLike } from "./events.ts";
import {
  isWrappedDescription,
  renderDescription,
} from "./descriptionMarkdown.ts";

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_MAX_RETRY_DELAY_MS = 10000;
const DEFAULT_REVALIDATE_AFTER_MS = 15_000;

// The routes only ever see this surface, so the store can stand in for the
// service and serve reads entirely from memory.
export type JobBoard = Pick<
  ManualJobService,
  | "listPage"
  | "countAll"
  | "create"
  | "update"
  | "cancel"
  | "claim"
  | "transition"
  | "setProgress"
  | "addNote"
>;

export interface JobStoreDeps {
  jobs: JobBoard;
  bus: EventBusLike;
  log: Logger;
  debounceMs?: number;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  // Injection seam so tests can force a failing renderer.
  renderDescription?: (raw: string) => string | null;
  // Snapshots older than this are re-fetched before serving reads, so
  // external writers stay visible even without Valkey events.
  revalidateAfterMs?: number;
  now?: () => number;
}

// Extra field served to dashboards; never persisted or sent to the CLI.
export interface ApiJob extends ManualJob {
  descriptionHtml?: string;
}

export interface ApiJobPage {
  jobs: ApiJob[];
  nextCursor: string | null;
}

interface SortKey {
  rank: number;
  priority: number;
  createdAtUs: bigint;
  id: string;
}

const sortKey = (job: PagedJob): SortKey => ({
  rank: jobRank(job.state),
  priority: job.priority,
  createdAtUs: BigInt(job.createdAtUs),
  id: job.id,
});

const compareKeys = (a: SortKey, b: SortKey): number => {
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.createdAtUs !== b.createdAtUs)
    return a.createdAtUs < b.createdAtUs ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

type PagedJob = ManualJob & { createdAtUs: string };

/**
 * Event-refreshed in-memory view of the project's work items. Mirrors the
 * daemon cache philosophy: one debounced database load per burst of events,
 * while every HTTP read is served instantly from memory.
 */
export class JobStore implements JobBoard {
  private readonly jobs: JobStoreDeps["jobs"];
  private readonly bus: EventBusLike;
  private readonly log: Logger;
  private readonly debounceMs: number;
  private readonly retryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly renderDescription: (raw: string) => string | null;
  private readonly revalidateAfterMs: number;
  private readonly now: () => number;
  private rows: PagedJob[] = [];
  private ready = false;
  // Wall-clock of the last successful database load; drives read revalidation.
  private loadedAt: number | null = null;
  private backoffMs = 0;
  private reloadQueue = Promise.resolve();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(deps: JobStoreDeps) {
    this.jobs = deps.jobs;
    this.bus = deps.bus;
    this.log = deps.log;
    this.debounceMs = deps.debounceMs ?? 300;
    this.retryDelayMs = deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.maxRetryDelayMs = deps.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    this.sleep =
      deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.renderDescription = deps.renderDescription ?? renderDescription;
    this.revalidateAfterMs =
      deps.revalidateAfterMs ?? DEFAULT_REVALIDATE_AFTER_MS;
    this.now = deps.now ?? Date.now;
  }

  async start(): Promise<void> {
    await this.loadUntilSuccess();
    this.unsubscribe = this.bus.onChange(() => this.scheduleReload());
  }

  async close(): Promise<void> {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async listPage(
    options: { limit?: number; cursor?: string | null; state?: string } = {},
  ): Promise<ApiJobPage> {
    // Until the first successful load the snapshot is empty but valid
    // rows exist server-side; refusing here keeps dashboards honest.
    if (!this.ready) throw new ServiceError(503, "Work items are loading");
    await this.revalidateIfStale();
    const limit = Math.min(
      MAX_PAGE_LIMIT,
      Math.max(1, options.limit ?? DEFAULT_PAGE_LIMIT),
    );
    const cursor = options.cursor ? decodeJobCursor(options.cursor) : null;
    const filtered = options.state
      ? this.rows.filter((job) => job.state === options.state)
      : this.rows;
    const sorted = filtered.sort((a, b) => compareKeys(sortKey(a), sortKey(b)));
    const startAt = cursor ? this.findStart(sorted, cursor) : 0;
    const page = sorted.slice(startAt, startAt + limit);
    const last = page[page.length - 1];
    const nextCursor =
      last && startAt + limit < sorted.length ? encode(last) : null;
    return { jobs: page.map((job) => this.toApiJob(job)), nextCursor };
  }

  // Counts are always exact so terminal states outside the row cache
  // still report live totals for the dashboard filter menu.
  async countAll(state?: WorkState): Promise<number> {
    return this.jobs.countAll(state);
  }

  async create(input: Parameters<JobBoard["create"]>[0]): Promise<ManualJob> {
    const job = await this.jobs.create(input);
    await this.enqueueReload();
    return job;
  }

  async update(id: string, patch: never): Promise<ManualJob>;
  async update(
    id: string,
    patch: Partial<
      Pick<ManualJob, "title" | "description" | "priority" | "tags">
    >,
  ): Promise<ManualJob>;
  async update(
    id: string,
    patch: Partial<
      Pick<ManualJob, "title" | "description" | "priority" | "tags">
    >,
  ): Promise<ManualJob> {
    const job = await this.jobs.update(id, patch);
    await this.enqueueReload();
    return job;
  }

  async cancel(id: string): Promise<ManualJob> {
    const job = await this.jobs.cancel(id);
    await this.enqueueReload();
    return job;
  }

  async claim(id: string): Promise<ManualJob> {
    const job = await this.jobs.claim(id);
    await this.enqueueReload();
    return job;
  }

  async transition(
    id: string,
    outcome: Parameters<JobBoard["transition"]>[1],
    message?: string,
  ): Promise<void> {
    await this.jobs.transition(id, outcome, message);
    await this.enqueueReload();
  }

  async setProgress(id: string, progress: number): Promise<void> {
    await this.jobs.setProgress(id, progress);
    await this.enqueueReload();
  }

  async addNote(id: string, note: string): Promise<void> {
    await this.jobs.addNote(id, note);
    await this.enqueueReload();
  }

  // External events coalesce: bursts collapse into one database load.
  private scheduleReload(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.enqueueReload();
    }, this.debounceMs);
  }

  // Read-path revalidation: stale snapshots trigger one shared reload so
  // overlapping requests cannot stampede the database.
  private revalidateLoad: Promise<void> | null = null;

  private isStale(): boolean {
    return (
      this.loadedAt === null ||
      this.now() - this.loadedAt > this.revalidateAfterMs
    );
  }

  private async revalidateIfStale(): Promise<void> {
    if (!this.isStale()) return;
    this.revalidateLoad ??= this.enqueueReload().finally(() => {
      this.revalidateLoad = null;
    });
    await this.revalidateLoad;
  }

  private enqueueReload(): Promise<void> {
    this.reloadQueue = this.reloadQueue.then(() => this.reload());
    return this.reloadQueue;
  }

  // A suspended database rejects early connections; boot blocks on the
  // first success instead of pinning an empty snapshot for the lifetime.
  private async loadUntilSuccess(): Promise<void> {
    while (!(await this.attemptLoad())) await this.sleep(this.nextBackoff());
  }

  private async attemptLoad(): Promise<boolean> {
    try {
      const rows: PagedJob[] = [];
      let cursor: string | null = null;
      while (true) {
        const page = await this.jobs.listPage({
          limit: MAX_PAGE_LIMIT,
          cursor,
        });
        rows.push(
          ...page.jobs.map((job) => ({
            ...job,
            createdAtUs: (
              BigInt(new Date(job.createdAt).getTime()) * 1000n
            ).toString(),
          })),
        );
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      this.rows = rows;
      this.backoffMs = 0;
      this.loadedAt = this.now();
      if (!this.ready) {
        this.ready = true;
        this.log.info(
          { event: "server.store_ready", rows: rows.length },
          "Work item store ready",
        );
      } else {
        this.log.debug(
          { event: "server.store_reloaded", projectIdRows: rows.length },
          "Work item store reloaded",
        );
      }
      return true;
    } catch (error) {
      this.log.warn(
        { event: "server.store_reload_failed", err: error },
        "Work item store reload failed; serving previous snapshot",
      );
      return false;
    }
  }

  private nextBackoff(): number {
    this.backoffMs =
      this.backoffMs === 0
        ? this.retryDelayMs
        : Math.min(this.backoffMs * 2, this.maxRetryDelayMs);
    return this.backoffMs;
  }

  private async reload(): Promise<void> {
    if (await this.attemptLoad()) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.enqueueReload();
    }, this.nextBackoff());
  }

  // First row at or after the cursor position in sort order.
  private findStart(sorted: PagedJob[], cursor: JobCursor): number {
    const key: SortKey = {
      rank: cursor.rank,
      priority: cursor.priority,
      createdAtUs: BigInt(cursor.createdAtUs),
      id: cursor.id,
    };
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (compareKeys(sortKey(sorted[mid]!), key) <= 0) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  private toApiJob(job: PagedJob): ApiJob {
    const { createdAtUs: _createdAtUs, ...rest } = job;
    if (!isWrappedDescription(job.description)) return rest;
    try {
      const descriptionHtml = this.renderDescription(job.description);
      return descriptionHtml ? { ...rest, descriptionHtml } : rest;
    } catch (error) {
      // A malformed render must never fail the whole listing.
      this.log.warn(
        {
          event: "server.description_render_failed",
          jobId: job.id,
          errorType: error instanceof Error ? error.name : "UnknownError",
        },
        "Description markdown render failed",
      );
      return rest;
    }
  }
}

const encode = (job: PagedJob): string =>
  encodeJobCursor({
    rank: jobRank(job.state),
    priority: job.priority,
    createdAt: new Date(job.createdAt).toISOString(),
    createdAtUs: job.createdAtUs,
    id: job.id,
  });
