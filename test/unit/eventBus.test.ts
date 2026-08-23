import { describe, expect, test } from "bun:test";
import type {
  EventEnvelope,
  EventSubscriber,
} from "../../src/server/events.ts";
import { ProjectEventBus } from "../../src/server/events.ts";
import { createLogger } from "../../src/observability/logger.ts";

const log = createLogger("event-bus-test", undefined, "silent");

interface FakeSubscriberState {
  connected: number;
  subscribed: string[];
  disconnected: boolean;
  messageHandler: ((channel: string, message: string) => void) | null;
}

function fakeSubscriber(
  status = "wait",
): EventSubscriber & { state: FakeSubscriberState } {
  const state: FakeSubscriberState = {
    connected: 0,
    subscribed: [],
    disconnected: false,
    messageHandler: null,
  };
  return {
    state,
    status,
    connect: async () => {
      state.connected += 1;
      return "OK";
    },
    subscribe: async (channel) => {
      state.subscribed.push(channel);
      return 1;
    },
    on: (event: string, handler: (...args: never[]) => void) => {
      if (event === "message")
        state.messageHandler = handler as (
          channel: string,
          message: string,
        ) => void;
      return undefined;
    },
    disconnect: () => {
      state.disconnected = true;
    },
  };
}

const envelope = (overrides: Partial<EventEnvelope> = {}): string =>
  JSON.stringify({
    type: "work.created",
    workItemId: "11111111-1111-4111-8111-111111111111",
    occurredAt: "2026-08-13T12:00:00.000Z",
    ...overrides,
  });

describe("ProjectEventBus", () => {
  test("connects and subscribes exactly once across repeated starts", async () => {
    const subscriber = fakeSubscriber();
    const bus = new ProjectEventBus({
      valkeyUrl: "redis://localhost:6379",
      channel: "jobsmith:p:events",
      log,
      subscriber,
    });
    await bus.start();
    await bus.start();
    expect(subscriber.state.connected).toBe(1);
    expect(subscriber.state.subscribed).toEqual(["jobsmith:p:events"]);
    await bus.close();
  });

  test("fans each published envelope out to every listener", async () => {
    const subscriber = fakeSubscriber();
    const bus = new ProjectEventBus({
      valkeyUrl: "redis://localhost:6379",
      channel: "jobsmith:p:events",
      log,
      subscriber,
    });
    await bus.start();
    const seen: EventEnvelope[] = [];
    const stop = bus.onChange((received) => seen.push(received));
    const second: EventEnvelope[] = [];
    bus.onChange((received) => second.push(received));
    expect(bus.clientCount).toBe(2);

    subscriber.state.messageHandler!(
      "jobsmith:p:events",
      envelope({ type: "work.claimed" }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.type).toBe("work.claimed");
    expect(second).toHaveLength(1);

    stop();
    expect(bus.clientCount).toBe(1);
    subscriber.state.messageHandler!("jobsmith:p:events", envelope());
    expect(seen).toHaveLength(1);
    expect(second).toHaveLength(2);
    await bus.close();
  });

  test("a throwing listener warns but does not break other listeners", () => {
    const subscriber = fakeSubscriber();
    const bus = new ProjectEventBus({
      valkeyUrl: "redis://localhost:6379",
      channel: "jobsmith:p:events",
      log,
      subscriber,
    });
    const received: EventEnvelope[] = [];
    bus.onChange(() => {
      throw new Error("relay boom");
    });
    bus.onChange((received_) => received.push(received_));
    expect(() =>
      subscriber.state.messageHandler!("jobsmith:p:events", envelope()),
    ).not.toThrow();
    expect(received).toHaveLength(1);
  });

  test("malformed payloads are dropped silently for listeners", () => {
    const subscriber = fakeSubscriber();
    const bus = new ProjectEventBus({
      valkeyUrl: "redis://localhost:6379",
      channel: "jobsmith:p:events",
      log,
      subscriber,
    });
    const received: EventEnvelope[] = [];
    bus.onChange((received_) => received.push(received_));
    subscriber.state.messageHandler!("jobsmith:p:events", "not-json");
    subscriber.state.messageHandler!(
      "jobsmith:p:events",
      JSON.stringify({ nope: true }),
    );
    expect(received).toHaveLength(0);
  });

  test("unsubscribing twice and closing are safe", async () => {
    const subscriber = fakeSubscriber("ready");
    const bus = new ProjectEventBus({
      valkeyUrl: "redis://localhost:6379",
      channel: "jobsmith:p:events",
      log,
      subscriber,
    });
    const stop = bus.onChange(() => undefined);
    stop();
    stop();
    await bus.close();
    await bus.close();
    expect(subscriber.state.disconnected).toBe(true);
    expect(bus.clientCount).toBe(0);
  });
});
