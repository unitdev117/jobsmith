import Redis from "ioredis";
import type { Logger } from "pino";

export const eventsChannel = (projectId: string): string =>
  `jobsmith:${projectId}:events`;

export const presenceKey = (projectId: string, memberId: string): string =>
  `jobsmith:${projectId}:presence:${memberId}`;

export const presencePattern = (projectId: string): string =>
  `jobsmith:${projectId}:presence:*`;

export interface PresencePayload {
  name: string;
  machineId: string;
}

export const serializePresence = (name: string, machineId: string): string =>
  JSON.stringify({ name, machineId });

export const parsePresence = (value: string | null): PresencePayload | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as PresencePayload;
    if (
      typeof parsed.name === "string" &&
      parsed.name.length > 0 &&
      typeof parsed.machineId === "string"
    )
      return parsed;
  } catch {}
  return null;
};

export class ProjectNotifier {
  private readonly client: Redis;
  private connectPromise: Promise<void> | null = null;

  constructor(
    valkeyUrl: string,
    private readonly projectId: string,
    private readonly log: Logger,
  ) {
    this.client = new Redis(valkeyUrl, {
      lazyConnect: true,
      connectTimeout: 1_500,
      retryStrategy: () => null,
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      connectionName: "jobsmith-cli",
    });
    this.client.on("error", (error) =>
      this.log.warn(
        { event: "valkey.error", err: error },
        "Valkey connection error",
      ),
    );
  }

  // Lazy clients sit in "wait"; a failed attempt leaves "end". connect()
  // works from both, so one outage only skips one notification.
  private ensureConnected(): Promise<void> {
    const status = this.client.status;
    if (status === "connect" || status === "ready") return Promise.resolve();
    if (!this.connectPromise) {
      this.connectPromise = this.client
        .connect()
        .then(() => undefined)
        .finally(() => {
          this.connectPromise = null;
        });
    }
    return this.connectPromise;
  }

  async check(): Promise<void> {
    await this.ensureConnected();
    await this.client.ping();
    this.log.info({ event: "valkey.ready" }, "Valkey is ready");
  }

  async publish(type: string, workItemId?: string): Promise<void> {
    try {
      await this.ensureConnected();
      await this.client.publish(
        eventsChannel(this.projectId),
        JSON.stringify({
          type,
          workItemId,
          occurredAt: new Date().toISOString(),
        }),
      );
      this.log.debug(
        { event: "valkey.event_published", type, workItemId },
        "Project event published",
      );
    } catch (error) {
      this.log.warn(
        { event: "valkey.publish_failed", type, workItemId, err: error },
        "Project event was not published",
      );
    }
  }

  // Passthroughs so the serve process rate limiter reuses this connection
  // instead of opening its own.
  async incr(key: string): Promise<number> {
    await this.ensureConnected();
    return this.client.incr(key);
  }

  async expire(key: string, seconds: number): Promise<void> {
    await this.ensureConnected();
    await this.client.expire(key, seconds);
  }

  // ioredis 6 finishes its teardown asynchronously; waiting for the real
  // "end" keeps an immediate republish on the clean reconnect path instead
  // of racing the dying socket.
  async close(): Promise<void> {
    if (this.client.status === "end") return;
    const ended = new Promise<void>((resolve) => {
      this.client.once("end", () => resolve());
    });
    const timeout = new Promise<void>((resolve) => {
      setTimeout(resolve, 250);
    });
    this.client.disconnect();
    await Promise.race([ended, timeout]);
  }
}
