#!/usr/bin/env bun
import Redis from "ioredis";
import type { Logger } from "pino";
import { loadDatabaseConfig } from "../config/index.ts";
import {
  eventsChannel,
  presenceKey,
  serializePresence,
} from "../coordination/valkey.ts";
import { closeDatabase, createDatabase } from "../db/pool.ts";
import { createLogger } from "../observability/logger.ts";
import { findLocalProject, type LocalProject } from "../project/localConfig.ts";
import { refreshJobs } from "../project/jobCache.ts";
import type { PendingFetch } from "../services/manualJobService.ts";
import { ManualJobService } from "../services/manualJobService.ts";

export const PRESENCE_TTL_SECONDS = 60;
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const REFRESH_DEBOUNCE_MS = 300;

export interface ValkeyClient {
  subscribe(channel: string): Promise<void>;
  setPresence(key: string, value: string, ttlSeconds: number): Promise<void>;
  onMessage(handler: (channel: string, message: string) => void): void;
  close(): Promise<void>;
}

export interface DaemonRuntime {
  root: string;
  log: Logger;
  fetchJobs: () => Promise<PendingFetch>;
  client: ValkeyClient;
  channel: string;
  presenceKey: string;
  presenceValue: string;
  presenceTtlSeconds: number;
  heartbeatIntervalMs: number;
  refreshDebounceMs: number;
  schedule: (callback: () => void, intervalMs: number) => () => void;
  onSignal: (handler: (signal: string) => void | Promise<void>) => void;
}

export async function refreshCache(
  root: string,
  fetchJobs: () => Promise<PendingFetch>,
  log: Logger,
): Promise<void> {
  try {
    const result = await refreshJobs(root, fetchJobs);
    log.info(
      { event: "daemon.cache_refreshed", jobCount: result.jobs.length },
      "Job cache refreshed",
    );
  } catch (error) {
    log.warn(
      { event: "daemon.refresh_failed", err: error },
      "Job cache refresh failed",
    );
  }
}

export async function runDaemon(runtime: DaemonRuntime): Promise<void> {
  const {
    root,
    log,
    fetchJobs,
    client,
    channel,
    presenceKey: key,
    presenceValue,
    presenceTtlSeconds,
    heartbeatIntervalMs,
    refreshDebounceMs,
    schedule,
    onSignal,
  } = runtime;

  let stopped = false;
  let stopHeartbeat = (): void => undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const stop = async (signal: string): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    stopHeartbeat();
    try {
      await client.close();
    } catch (error) {
      log.warn(
        { event: "daemon.close_failed", err: error },
        "Daemon close failed",
      );
    }
    log.info({ event: "daemon.stopped", signal }, "Daemon stopped");
  };
  onSignal(stop);

  const beat = async (): Promise<void> => {
    try {
      await client.setPresence(key, presenceValue, presenceTtlSeconds);
      log.debug({ event: "daemon.heartbeat" }, "Presence heartbeat sent");
    } catch (error) {
      log.warn(
        { event: "daemon.heartbeat_failed", err: error },
        "Presence heartbeat failed",
      );
    }
  };
  void beat();
  stopHeartbeat = schedule(() => {
    void beat();
  }, heartbeatIntervalMs);

  // Pub/sub misses anything published before we listen, so subscribe first.
  let refreshQueue = Promise.resolve();

  // Debounce bursts into one refresh; each one opens a fresh DB connection.
  const scheduleDebouncedRefresh = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      // Back-to-back, never in parallel.
      refreshQueue = refreshQueue.then(() =>
        refreshCache(root, fetchJobs, log),
      );
    }, refreshDebounceMs);
  };

  client.onMessage(() => {
    if (!stopped) scheduleDebouncedRefresh();
  });
  try {
    await client.subscribe(channel);
    log.info({ event: "daemon.subscribed", channel }, "Daemon subscribed");
  } catch (error) {
    await stop("subscribe_failed");
    throw error;
  }
  await refreshCache(root, fetchJobs, log);
}

export function createValkeyClient(
  valkeyUrl: string,
  log: Logger,
): ValkeyClient {
  const client = new Redis(valkeyUrl, {
    connectionName: "jobsmith-daemon",
    retryStrategy: (times) => Math.min(times * 200, 5_000),
    maxRetriesPerRequest: null,
  });
  client.on("error", (error) =>
    log.warn(
      { event: "daemon.valkey_error", err: error },
      "Daemon Valkey connection error",
    ),
  );
  return {
    subscribe: async (target) => {
      await client.subscribe(target);
    },
    setPresence: async (target, value, ttlSeconds) => {
      await client.set(target, value, "EX", ttlSeconds);
    },
    onMessage: (handler) => {
      client.on("message", handler);
    },
    close: async () => {
      if (client.status !== "end") client.disconnect();
    },
  };
}

export function createFetchJobs(
  config: LocalProject,
  log: Logger,
): () => Promise<PendingFetch> {
  return async () => {
    const databaseConfig = loadDatabaseConfig({
      ...process.env,
      DATABASE_URL: config.databaseUrl,
      DATABASE_MIGRATION_URL: undefined,
    });
    const sql = createDatabase(databaseConfig, log);
    try {
      const service = new ManualJobService(
        sql,
        config,
        { publish: async () => {} },
        log,
      );
      return await service.listPending();
    } finally {
      await closeDatabase(sql, log);
    }
  };
}

export function defaultRuntime(
  config: LocalProject,
  root: string,
  log: Logger,
): DaemonRuntime {
  return {
    root,
    log,
    fetchJobs: createFetchJobs(config, log),
    client: createValkeyClient(config.valkeyUrl, log),
    channel: eventsChannel(config.projectId),
    presenceKey: presenceKey(config.projectId, config.memberId),
    presenceValue: serializePresence(config.memberName, config.machineId),
    presenceTtlSeconds: PRESENCE_TTL_SECONDS,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    refreshDebounceMs: REFRESH_DEBOUNCE_MS,
    schedule: (callback, intervalMs) => {
      const id = setInterval(callback, intervalMs);
      return () => clearInterval(id);
    },
    onSignal: (handler) => {
      const stop = (signal: string): void => {
        void Promise.resolve(handler(signal)).finally(() => process.exit(0));
      };
      process.once("SIGTERM", () => stop("SIGTERM"));
      process.once("SIGINT", () => stop("SIGINT"));
    },
  };
}

if (import.meta.main) {
  const log = createLogger("jobsmith-daemon");
  const { root, config } = await findLocalProject();
  await runDaemon(defaultRuntime(config, root, log)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `Jobsmith daemon failed: ${message || "unknown error"}\n`,
    );
    process.exitCode = 1;
  });
}
