import { Hono } from "hono";
import type { Logger } from "pino";
import type { PresenceEntry } from "../../coordination/presence.ts";
import type { LocalProject } from "../../project/localConfig.ts";
import type { ProjectService } from "../../services/projectService.ts";
import { handleError } from "../errors.ts";

export interface MemberRouteDeps {
  project: LocalProject;
  members: Pick<ProjectService, "listMembers">;
  presence: (projectId: string) => Promise<PresenceEntry[] | null>;
  log: Logger;
}

export const memberRoutes = (deps: MemberRouteDeps): Hono => {
  const routes = new Hono();
  routes.get("/members", async (c) => {
    try {
      const [members, presence] = await Promise.all([
        deps.members.listMembers(deps.project.projectId),
        deps.presence(deps.project.projectId),
      ]);
      if (!presence)
        deps.log.warn(
          {
            event: "server.presence_unavailable",
            projectId: deps.project.projectId,
          },
          "Presence unavailable; reporting every member offline",
        );
      const onlineIds = new Set(
        (presence ?? []).map((entry) => entry.memberId),
      );
      const body = members.map((member) => ({
        memberId: member.memberId,
        name: member.name,
        role: member.role,
        online: onlineIds.has(member.memberId),
      }));
      deps.log.debug(
        {
          event: "server.members_listed",
          total: body.length,
          online: body.filter((member) => member.online).length,
        },
        "Members listed",
      );
      return c.json(body);
    } catch (error) {
      return handleError(c, deps.log, error);
    }
  });
  return routes;
};
