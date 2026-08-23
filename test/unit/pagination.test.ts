import { describe, expect, test } from "bun:test";
import {
  decodeJobCursor,
  encodeJobCursor,
} from "../../src/services/pagination.ts";

const cursor = {
  rank: 2,
  priority: 7,
  createdAt: "2026-08-13T10:30:00.000Z",
  createdAtUs: "1786603800000000",
  id: "11111111-1111-4111-8111-111111111111",
};

describe("job cursor codec", () => {
  test("round-trips all fields through the versioned envelope", () => {
    const encoded = encodeJobCursor(cursor);
    expect(encoded).not.toContain("=");

    expect(decodeJobCursor(encoded)).toEqual(cursor);
  });

  test("produces different encodings for different cursors", () => {
    expect(encodeJobCursor(cursor)).not.toBe(
      encodeJobCursor({ ...cursor, priority: 3 }),
    );
    expect(encodeJobCursor(cursor)).not.toBe(
      encodeJobCursor({ ...cursor, createdAtUs: "1786603800000001" }),
    );
  });

  test("rejects truncated input", () => {
    const encoded = encodeJobCursor(cursor);
    expect(decodeJobCursor(encoded.slice(0, encoded.length - 4))).toBeNull();
  });

  test("rejects malformed base64url payloads", () => {
    expect(decodeJobCursor("!!!!")).toBeNull();
    expect(decodeJobCursor("")).toBeNull();
  });

  test("rejects a missing or unknown envelope version", () => {
    const decoded = JSON.parse(
      Buffer.from(encodeJobCursor(cursor), "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(
      decodeJobCursor(
        Buffer.from(JSON.stringify({ ...decoded, v: 3 })).toString("base64url"),
      ),
    ).toBeNull();
    // Legacy v1 cursors (no microsecond key) must not decode either.
    expect(
      decodeJobCursor(
        Buffer.from(JSON.stringify({ ...decoded, v: 1 })).toString("base64url"),
      ),
    ).toBeNull();

    const { v: _v, ...withoutVersion } = decoded;
    expect(
      decodeJobCursor(
        Buffer.from(JSON.stringify(withoutVersion)).toString("base64url"),
      ),
    ).toBeNull();
  });

  test("rejects out-of-range or malformed fields", () => {
    const build = (patch: Record<string, unknown>): string =>
      Buffer.from(
        JSON.stringify({
          ...JSON.parse(
            Buffer.from(encodeJobCursor(cursor), "base64url").toString("utf8"),
          ),
          ...patch,
        }),
      ).toString("base64url");
    expect(decodeJobCursor(build({ p: 10 }))).toBeNull();
    expect(decodeJobCursor(build({ p: -1 }))).toBeNull();
    expect(decodeJobCursor(build({ r: 3 }))).toBeNull();
    expect(decodeJobCursor(build({ c: "yesterday" }))).toBeNull();
    expect(decodeJobCursor(build({ m: "12.5" }))).toBeNull();
    expect(decodeJobCursor(build({ m: "" }))).toBeNull();
    expect(decodeJobCursor(build({ i: "not-a-uuid" }))).toBeNull();
    expect(decodeJobCursor(Buffer.from("[]").toString("base64url"))).toBeNull();
  });
});
