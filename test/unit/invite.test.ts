import { describe, expect, test } from "bun:test";
import { decodeInvite } from "../../src/services/projectService.ts";

const validPayload = {
  version: 1,
  inviteId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  projectName: "Decoder test",
  token: "a".repeat(43),
  databaseUrl: "postgresql://user:pass@localhost:5432/db?sslmode=require",
  valkeyUrl: "redis://127.0.0.1:6379",
  expiresAt: "2030-01-01T00:00:00.000Z",
};

const encode = (payload: unknown): string =>
  `jsm1_${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;

describe("connection strings", () => {
  test("rejects malformed and unsupported values", () => {
    expect(() => decodeInvite("not-an-invite")).toThrow(
      "Invalid Jobsmith connection string",
    );
    expect(() => decodeInvite("jsm1_invalid-base64")).toThrow(
      "Invalid Jobsmith connection string",
    );
  });

  test("round-trips a well-formed payload", () => {
    const invite = decodeInvite(encode(validPayload));
    expect(invite).toMatchObject({
      version: 1,
      inviteId: validPayload.inviteId,
      projectId: validPayload.projectId,
      projectName: validPayload.projectName,
      token: validPayload.token,
      databaseUrl: validPayload.databaseUrl,
      valkeyUrl: validPayload.valkeyUrl,
    });
    expect(invite.expiresAt).toBe(validPayload.expiresAt);
  });

  test("rejects payloads that fail schema validation", () => {
    expect(() => decodeInvite(encode({ ...validPayload, version: 2 }))).toThrow(
      "Invalid Jobsmith connection string",
    );
    expect(() =>
      decodeInvite(encode({ ...validPayload, databaseUrl: "mysql://x" })),
    ).toThrow("Invalid Jobsmith connection string");
    expect(() =>
      decodeInvite(encode({ ...validPayload, token: "short" })),
    ).toThrow("Invalid Jobsmith connection string");
    expect(() => decodeInvite("jsm1_notjson")).toThrow(
      "Invalid Jobsmith connection string",
    );
  });
});
