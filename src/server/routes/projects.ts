import { Hono } from "hono";
import type { LocalProject } from "../../project/localConfig.ts";
import type { ProjectService } from "../../services/projectService.ts";
import {
  handleError,
  validationDetails,
  validationFailure,
} from "../errors.ts";
import { inviteBodySchema } from "../schemas.ts";
import type { Logger } from "pino";

export interface ProjectRouteDeps {
  project: LocalProject;
  invites: Pick<ProjectService, "createInvite">;
  log: Logger;
}

export const projectRoutes = (deps: ProjectRouteDeps): Hono => {
  const routes = new Hono();
  routes.get("/project", (c) =>
    c.json({
      projectId: deps.project.projectId,
      projectName: deps.project.projectName,
      me: {
        memberId: deps.project.memberId,
        memberName: deps.project.memberName,
        role: deps.project.role,
      },
    }),
  );
  routes.post("/invites", async (c) => {
    try {
      const parsed = inviteBodySchema.safeParse(await c.req.json());
      if (!parsed.success)
        return validationFailure(c, validationDetails(parsed.error));
      const invite = await deps.invites.createInvite(
        deps.project,
        parsed.data.ttlMinutes,
      );
      return c.json(
        { connectionString: invite.value, expiresAt: invite.expiresAt },
        201,
      );
    } catch (error) {
      return handleError(c, deps.log, error);
    }
  });
  return routes;
};
