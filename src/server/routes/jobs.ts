import { Hono } from "hono";
import type { Logger } from "pino";
import type { LocalProject } from "../../project/localConfig.ts";
import type { ManualJobService } from "../../services/manualJobService.ts";
import {
  handleError,
  validationDetails,
  validationFailure,
} from "../errors.ts";
import {
  createJobBodySchema,
  jobQuerySchema,
  noteBodySchema,
  progressBodySchema,
  transitionBodySchema,
  updateJobBodySchema,
} from "../schemas.ts";

export interface JobRouteDeps {
  project: LocalProject;
  jobs: Pick<
    ManualJobService,
    | "listPage"
    | "countAll"
    | "create"
    | "update"
    | "cancel"
    | "claim"
    | "transition"
    | "setProgress"
    | "addNote"
  >;
  log: Logger;
}

export const jobRoutes = (deps: JobRouteDeps): Hono => {
  const routes = new Hono();
  routes.get("/jobs", async (c) => {
    try {
      const parsed = jobQuerySchema.safeParse(c.req.query());
      if (!parsed.success)
        return validationFailure(c, validationDetails(parsed.error));
      if (parsed.data.count)
        return c.json({ total: await deps.jobs.countAll(parsed.data.state) });
      const page = await deps.jobs.listPage({
        limit: parsed.data.limit,
        cursor: parsed.data.cursor ?? null,
        ...(parsed.data.state ? { state: parsed.data.state } : {}),
      });
      return c.json({ jobs: page.jobs, nextCursor: page.nextCursor });
    } catch (error) {
      return handleError(c, deps.log, error);
    }
  });
  routes.post("/jobs", async (c) => {
    try {
      const parsed = createJobBodySchema.safeParse(await c.req.json());
      if (!parsed.success)
        return validationFailure(c, validationDetails(parsed.error));
      const job = await deps.jobs.create({
        title: parsed.data.title,
        description: parsed.data.description,
        priority: parsed.data.priority,
        tags: parsed.data.tags,
        dueAt: parsed.data.dueAt,
      });
      return c.json(job, 201);
    } catch (error) {
      return handleError(c, deps.log, error);
    }
  });
  routes.patch("/jobs/:id", async (c) => {
    try {
      const parsed = updateJobBodySchema.safeParse(await c.req.json());
      if (!parsed.success)
        return validationFailure(c, validationDetails(parsed.error));
      const patch: {
        title?: string;
        description?: string;
        priority?: number;
        tags?: string[];
        dueAt?: Date | null;
      } = {};
      if (parsed.data.title !== undefined) patch.title = parsed.data.title;
      if (parsed.data.description !== undefined)
        patch.description = parsed.data.description;
      if (parsed.data.priority !== undefined)
        patch.priority = parsed.data.priority;
      if (parsed.data.tags !== undefined) patch.tags = parsed.data.tags;
      if (parsed.data.dueAt !== undefined) patch.dueAt = parsed.data.dueAt;
      const job = await deps.jobs.update(c.req.param("id"), patch);
      return c.json(job);
    } catch (error) {
      return handleError(c, deps.log, error);
    }
  });
  routes.post("/jobs/:id/cancel", async (c) => {
    try {
      const job = await deps.jobs.cancel(c.req.param("id"));
      return c.json(job);
    } catch (error) {
      return handleError(c, deps.log, error);
    }
  });
  routes.post("/jobs/:id/claim", async (c) => {
    try {
      const job = await deps.jobs.claim(c.req.param("id"));
      return c.json(job);
    } catch (error) {
      return handleError(c, deps.log, error);
    }
  });
  routes.post("/jobs/:id/transition", async (c) => {
    try {
      const parsed = transitionBodySchema.safeParse(await c.req.json());
      if (!parsed.success)
        return validationFailure(c, validationDetails(parsed.error));
      await deps.jobs.transition(
        c.req.param("id"),
        parsed.data.outcome,
        parsed.data.message,
      );
      return c.json({ ok: true });
    } catch (error) {
      return handleError(c, deps.log, error);
    }
  });
  routes.post("/jobs/:id/progress", async (c) => {
    try {
      const parsed = progressBodySchema.safeParse(await c.req.json());
      if (!parsed.success)
        return validationFailure(c, validationDetails(parsed.error));
      await deps.jobs.setProgress(c.req.param("id"), parsed.data.progress);
      return c.json({ ok: true });
    } catch (error) {
      return handleError(c, deps.log, error);
    }
  });
  routes.post("/jobs/:id/notes", async (c) => {
    try {
      const parsed = noteBodySchema.safeParse(await c.req.json());
      if (!parsed.success)
        return validationFailure(c, validationDetails(parsed.error));
      await deps.jobs.addNote(c.req.param("id"), parsed.data.note);
      return c.json({ ok: true });
    } catch (error) {
      return handleError(c, deps.log, error);
    }
  });
  return routes;
};
