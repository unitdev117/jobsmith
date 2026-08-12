import { expect, test } from "bun:test";
import { Writable } from "node:stream";
import { createLogger } from "../../src/observability/logger.ts";

test("structured logger redacts credentials", () => {
  let output = "";
  const sink = new Writable({
    write(chunk, _encoding, done) {
      output += chunk.toString();
      done();
    },
  });
  const log = createLogger("test", sink, "info");
  log.info(
    {
      DATABASE_URL: "postgresql://secret",
      VALKEY_URL: "redis://secret",
      databaseUrl: "postgresql://local-secret",
      authorization: "Bearer secret",
      nested: { password: "secret", valkeyUrl: "redis://nested-secret" },
    },
    "redaction",
  );
  expect(output).not.toContain("postgresql://secret");
  expect(output).not.toContain("redis://secret");
  expect(output).not.toContain("postgresql://local-secret");
  expect(output).not.toContain("redis://nested-secret");
  expect(output).not.toContain("Bearer secret");
  expect(output).not.toContain('"password":"secret"');
  expect(output).toContain("[REDACTED]");
});
