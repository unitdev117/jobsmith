import { expect, test } from "bun:test";
import type { Database } from "../../src/db/pool.ts";
import { inTransaction } from "../../src/db/transaction.ts";

test("transaction rollback preserves the original error", async () => {
  const expected = new Error("conflict");
  const sql = {
    begin: async (run: (tx: Database) => Promise<unknown>) =>
      run({} as Database),
  } as unknown as Database;
  let actual: unknown;
  try {
    await inTransaction(sql, "test.conflict", async () => {
      throw expected;
    });
  } catch (error) {
    actual = error;
  }
  expect(actual).toBe(expected);
});
