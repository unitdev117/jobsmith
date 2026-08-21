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

  async check(): Promise<void> {
    if (this.client.status === "wait") await this.client.connect();
    await this.client.ping();
    this.log.info({ event: "valkey.ready" }, "Valkey is ready");
  }

  async publish(type: string, workItemId?: string): Promise<void> {
    try {
      if (this.client.status === "wait") await this.client.connect();
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

  async close(): Promise<void> {
    if (this.client.status !== "end") this.client.disconnect();
  }
}
