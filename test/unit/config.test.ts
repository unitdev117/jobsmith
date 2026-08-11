import { describe, expect, test } from "bun:test";
import {
  loadDatabaseConfig,
  loadHostConfig,
  loadInviteTtl,
} from "../../src/config/index.ts";

describe("CLI configuration", () => {
  test("accepts PostgreSQL with an empty optional migration URL", () => {
    const config = loadDatabaseConfig({
      DATABASE_URL: "postgresql://user:pass@localhost/jobsmith",
      DATABASE_MIGRATION_URL: "",
    });
    expect(config.DATABASE_MIGRATION_URL).toBeUndefined();
    expect(config.LOG_LEVEL).toBe("warn");
  });

  test("rejects a non-PostgreSQL database URL", () => {
    expect(() =>
      loadDatabaseConfig({ DATABASE_URL: "https://example.test/database" }),
    ).toThrow("Invalid configuration");
  });

  test("validates host Valkey settings and invitation lifetime", () => {
    expect(
      loadHostConfig({
        DATABASE_URL: "postgresql://user:pass@localhost/jobsmith",
        VALKEY_URL: "redis://localhost:6379",
        INVITE_TTL_MINUTES: "8",
      }).INVITE_TTL_MINUTES,
    ).toBe(8);
    expect(loadInviteTtl({})).toBe(5);
    expect(() =>
      loadHostConfig({
        DATABASE_URL: "postgresql://user:pass@localhost/jobsmith",
        VALKEY_URL: "https://localhost:6379",
      }),
    ).toThrow("Invalid configuration");
  });
});
