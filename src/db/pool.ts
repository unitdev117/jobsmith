import postgres, { type Sql } from "postgres";
import type { DatabaseConfig } from "../config/index.ts";
import type { Logger } from "pino";

export type Database = Sql<Record<string, never>>;

export function createDatabase(
  config: DatabaseConfig,
  log: Logger,
  migration = false,
): Database {
  const url = migration
    ? (config.DATABASE_MIGRATION_URL ?? config.DATABASE_URL)
    : config.DATABASE_URL;
  const sql = postgres(url, {
    max: migration ? 1 : 2,
    idle_timeout: 20,
    connect_timeout: 10,
    connection: {
      statement_timeout: 15000,
      lock_timeout: 5000,
      idle_in_transaction_session_timeout: 15000,
      application_name: "jobsmith",
    },
    onnotice: () => undefined,
    debug: (_connection, query) =>
      log.trace(
        { operation: "database.query", queryLength: query.length },
        "database query",
      ),
  });
  return sql;
}

export async function checkDatabase(sql: Database, log: Logger): Promise<void> {
  const started = performance.now();
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await sql`select 1`;
      log.info(
        {
          operation: "database.health",
          attempt,
          durationMs: Math.round(performance.now() - started),
        },
        "database ready",
      );
      return;
    } catch (error) {
      if (attempt === 4) {
        log.error(
          {
            operation: "database.health",
            attempt,
            durationMs: Math.round(performance.now() - started),
            err: error,
          },
          "database unavailable",
        );
        throw error;
      }
      const retryDelayMs = attempt * 250 + Math.floor(Math.random() * 250);
      log.warn(
        {
          event: "database.health_retry",
          attempt,
          retryDelayMs,
          err: error,
        },
        "database startup check will retry",
      );
      await Bun.sleep(retryDelayMs);
    }
  }
}

export async function closeDatabase(sql: Database, log: Logger): Promise<void> {
  await sql.end({ timeout: 5 });
  log.info({ operation: "database.close" }, "database pool closed");
}
