import { describe, expect, test } from "bun:test";
import type { PresenceEntry } from "../../src/coordination/presence.ts";
import { createLogger } from "../../src/observability/logger.ts";
import type { LocalProject } from "../../src/project/localConfig.ts";
import { memberRoutes } from "../../src/server/routes/members.ts";

const log = createLogger("members-route-test", undefined, "silent");

const project: LocalProject = {
  schemaVersion: 1,
  projectId: "22222222-2222-4222-8222-222222222222",
  projectName: "Test project",
  memberId: "33333333-3333-4333-8333-333333333333",
  memberName: "Me",
  role: "HOST",
  machineId: "44444444-4444-4444-8444-444444444444",
  databaseUrl: "postgresql://user:pass@localhost/jobsmith",
  valkeyUrl: "redis://localhost:6379",
};

const member = (
  memberId: string,
  name: string,
  role: "HOST" | "MEMBER" | "AGENT",
): {
  memberId: string;
  name: string;
  role: "HOST" | "MEMBER" | "AGENT";
  joinedAt: Date;
} => ({
  memberId,
  name,
  role,
  joinedAt: new Date("2026-08-13T09:00:00.000Z"),
});

const members = [
  member(project.memberId, "Host", "HOST"),
  member("55555555-5555-4555-8555-555555555555", "Worker", "MEMBER"),
  member("66666666-6666-4666-8666-666666666666", "Bot", "AGENT"),
];

interface Harness {
  presenceKeys: Set<string>;
  available: boolean;
}

function buildRoute(state: Harness) {
  return memberRoutes({
    project,
    members: {
      listMembers: async () => members.map((entry) => ({ ...entry })),
    },
    presence: async () =>
      state.available
        ? [...state.presenceKeys].map((memberId): PresenceEntry => ({
            memberId,
            name: memberId,
            machineId: "44444444-4444-4444-8444-444444444444",
          }))
        : null,
    log,
  });
}

describe("GET /api/members", () => {
  test("joins database roles with live presence keys", async () => {
    const state: Harness = {
      presenceKeys: new Set([project.memberId]),
      available: true,
    };
    const response = await buildRoute(state).request("/members");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      {
        memberId: project.memberId,
        name: "Host",
        role: "HOST",
        online: true,
      },
      {
        memberId: "55555555-5555-4555-8555-555555555555",
        name: "Worker",
        role: "MEMBER",
        online: false,
      },
      {
        memberId: "66666666-6666-4666-8666-666666666666",
        name: "Bot",
        role: "AGENT",
        online: false,
      },
    ]);
  });

  test("reports every member offline when presence is unavailable", async () => {
    const state: Harness = { presenceKeys: new Set(), available: false };
    const response = await buildRoute(state).request("/members");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { online: boolean }[];
    expect(body.map((entry) => entry.online)).toEqual([false, false, false]);
  });

  test("expired or missing keys mean offline while roles still surface", async () => {
    const state: Harness = { presenceKeys: new Set(), available: true };
    const response = await buildRoute(state).request("/members");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      role: string;
      online: boolean;
    }[];
    expect(body.map((entry) => entry.role)).toEqual([
      "HOST",
      "MEMBER",
      "AGENT",
    ]);
    expect(body.every((entry) => !entry.online)).toBe(true);
  });
});
