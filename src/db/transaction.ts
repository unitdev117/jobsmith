import type { Database } from "./pool.ts";
import { logger } from "../observability/logger.ts";

export async function inTransaction<T>(
  sql: Database,
  operation: string,
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  const started = performance.now();
  try {
    const value = (await sql.begin(async (tx) =>
      fn(tx as unknown as Database),
    )) as T;
    logger.debug(
      {
        operation,
        durationMs: Math.round(performance.now() - started),
      },
      "database transaction committed",
    );
    return value;
  } catch (error) {
    logger.warn(
      {
        operation,
        durationMs: Math.round(performance.now() - started),
        err: error,
      },
      "database transaction failed",
    );
    throw error;
  }
}
