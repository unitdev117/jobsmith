import { describe, expect, test } from "bun:test";
import { decodeInvite } from "../../src/services/projectService.ts";

describe("connection strings", () => {
  test("rejects malformed and unsupported values", () => {
    expect(() => decodeInvite("not-an-invite")).toThrow(
      "Invalid Jobsmith connection string",
    );
    expect(() => decodeInvite("jsm1_invalid-base64")).toThrow(
      "Invalid Jobsmith connection string",
    );
  });
});
