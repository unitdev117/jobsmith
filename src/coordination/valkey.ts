import Redis from "ioredis";
import type { Logger } from "pino";

export class ProjectNotifier {
  private readonly client: Redis;

  constructor(
    valkeyUrl: string,
    private readonly projectId: string,
    private readonly log: Logger,
  ) {
    this.client = new Redis(valkeyUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
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
        `jobsmith:${this.projectId}:events`,
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
      // PostgreSQL is authoritative; a missed wake-up must not undo committed work.
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
