import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadDatabaseConfig } from "../config/index.ts";
import { createLogger } from "../observability/logger.ts";
import { checkDatabase, createDatabase } from "./pool.ts";

export async function migrate(databaseUrl?: string): Promise<void> {
  const config = loadDatabaseConfig(
    databaseUrl
      ? {
          ...process.env,
          DATABASE_URL: databaseUrl,
          DATABASE_MIGRATION_URL: undefined,
        }
      : process.env,
  );
  const log = createLogger("migration");
  const sql = createDatabase(config, log, true);
  try {
    await checkDatabase(sql, log);
    await sql`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`;
    const directory = join(import.meta.dir, "migrations");
    const files = (await readdir(directory))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const exists = await sql<
        { version: string }[]
      >`SELECT version FROM schema_migrations WHERE version = ${file}`;
      if (exists.length) continue;
      const source = await Bun.file(join(directory, file)).text();
      await sql.begin(async (tx) => {
        await tx.unsafe(source);
        await tx`INSERT INTO schema_migrations (version) VALUES (${file})`;
      });
      log.info(
        { operation: "migration.apply", version: file },
        "migration applied",
      );
    }
  } finally {
    await sql.end();
  }
}

if (import.meta.main) await migrate();
