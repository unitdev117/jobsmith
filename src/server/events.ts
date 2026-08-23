import Redis from "ioredis";
import type { Logger } from "pino";

export interface EventEnvelope {
  type: string;
  workItemId?: string | undefined;
  occurredAt: string;
}

// Minimal subscriber surface so tests can inject a fake instead of a socket.
export interface EventSubscriber {
  status: string;
  connect(): Promise<unknown>;
  subscribe(channel: string): Promise<unknown>;
  on(event: string, handler: (...args: never[]) => void): unknown;
  disconnect(): void;
}

export interface EventBusLike {
  start(): Promise<void>;
  onChange(fn: (envelope: EventEnvelope) => void): () => void;
  close(): Promise<void>;
}

export interface ProjectEventBusInput {
  valkeyUrl: string;
  channel: string;
  log: Logger;
  subscriber?: EventSubscriber;
}

const parseEnvelope = (raw: string): EventEnvelope | null => {
  try {
    const parsed = JSON.parse(raw) as Partial<EventEnvelope>;
    if (
      typeof parsed.type === "string" &&
      typeof parsed.occurredAt === "string"
    )
      return {
        type: parsed.type,
        workItemId: parsed.workItemId,
        occurredAt: parsed.occurredAt,
      };
  } catch {}
  return null;
};

export class ProjectEventBus implements EventBusLike {
  private readonly subscriber: EventSubscriber;
  private readonly channel: string;
  private readonly log: Logger;
  private readonly listeners = new Set<(envelope: EventEnvelope) => void>();
  private startPromise: Promise<void> | null = null;

  constructor(input: ProjectEventBusInput) {
    this.channel = input.channel;
    this.log = input.log;
    this.subscriber =
      input.subscriber ??
      (new Redis(input.valkeyUrl, {
        connectionName: "jobsmith-serve-events",
        lazyConnect: true,
        connectTimeout: 1_500,
        // A dropped subscriber stays down; clients keep their last view.
        retryStrategy: () => null,
        maxRetriesPerRequest: null,
      }) as unknown as EventSubscriber);
    this.subscriber.on("message", (_channel: string, message: string) =>
      this.relay(message),
    );
    this.subscriber.on("error", (error: Error) =>
      this.log.warn(
        { event: "sse.subscriber_error", err: error },
        "Valkey subscriber error",
      ),
    );
  }

  private relay(raw: string): void {
    const envelope = parseEnvelope(raw);
    if (!envelope) {
      this.log.warn(
        { event: "sse.message_dropped" },
        "Unparseable project event dropped",
      );
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener(envelope);
      } catch (error) {
        this.log.warn(
          { event: "sse.relay_failed", err: error },
          "Event listener failed",
        );
      }
    }
  }

  get clientCount(): number {
    return this.listeners.size;
  }

  async start(): Promise<void> {
    if (!this.startPromise)
      this.startPromise = (async () => {
        try {
          if (this.subscriber.status !== "ready")
            await this.subscriber.connect();
          await this.subscriber.subscribe(this.channel);
          this.log.info(
            { event: "sse.bus_started", channel: this.channel },
            "Project event bus subscribed",
          );
        } catch (error) {
          // Forget the failed attempt so a later start() can retry.
          this.startPromise = null;
          throw error;
        }
      })();
    return this.startPromise;
  }

  onChange(fn: (envelope: EventEnvelope) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  async close(): Promise<void> {
    this.listeners.clear();
    this.startPromise = null;
    if (this.subscriber.status !== "end") this.subscriber.disconnect();
  }
}
