import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { ProjectNotifier } from "../../src/coordination/valkey.ts";
import { createLogger } from "../../src/observability/logger.ts";

const log = createLogger("valkey-notifier-test", undefined, "silent");

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

describe("ProjectNotifier", () => {
  const notifiers: ProjectNotifier[] = [];
  afterEach(async () => {
    await Promise.all(notifiers.splice(0).map((notifier) => notifier.close()));
  });

  test("publish fails fast and never throws when Valkey is unreachable", async () => {
    const notifier = new ProjectNotifier(
      `redis://127.0.0.1:${await unusedPort()}`,
      "unreachable-project",
      log,
    );
    notifiers.push(notifier);
    const started = Date.now();
    // publish swallows connection failures, so it always resolves.
    await notifier.publish("work.created", "job-1");
    expect(Date.now() - started).toBeLessThan(5_000);
    // A later publish in the same process must not stall either.
    const second = Date.now();
    await notifier.publish("work.updated", "job-2");
    expect(Date.now() - second).toBeLessThan(5_000);
  });

  test("check rejects quickly when Valkey is unreachable", async () => {
    const notifier = new ProjectNotifier(
      `redis://127.0.0.1:${await unusedPort()}`,
      "unreachable-project",
      log,
    );
    notifiers.push(notifier);
    const started = Date.now();
    let threw = false;
    try {
      await notifier.check();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
