import { z } from "zod";

export const workStateSchema = z.enum([
  "PENDING",
  "READY",
  "IN_PROGRESS",
  "PAUSED",
  "BLOCKED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

const tagsSchema = z
  .array(z.string().min(1).max(30))
  .max(10)
  .transform((tags) => [...new Set(tags)]);

export const jobQuerySchema = z.object({
  state: workStateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
  // Dashboard stats fetch a cheap project-wide total instead of a page.
  count: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
});

// Optional deadline; the CLI stores UTC midnight of the picked day.
const dueAtSchema = z
  .string()
  .datetime()
  .transform((value) => new Date(value));

export const createJobBodySchema = z.object({
  title: z.string().min(1).max(120),
  // The database requires at least one character, so empty is invalid here.
  description: z.string().min(1).max(4000),
  priority: z.number().int().min(0).max(9).default(5),
  tags: tagsSchema.default([]),
  dueAt: dueAtSchema.nullish().transform((value) => value ?? null),
});

export const updateJobBodySchema = z.object({
  title: z.string().min(1).max(120).optional(),
  description: z.string().min(1).max(4000).optional(),
  priority: z.number().int().min(0).max(9).optional(),
  tags: tagsSchema.optional(),
  dueAt: dueAtSchema
    .nullish()
    .transform((value) => (value === undefined ? undefined : value)),
});

export const inviteBodySchema = z.object({
  ttlMinutes: z.coerce.number().int().min(1).max(10080).default(60),
});

// Outcomes a worker can move an owned IN_PROGRESS job to.
export const transitionBodySchema = z.object({
  outcome: z.enum(["PAUSED", "BLOCKED", "COMPLETED", "FAILED", "PENDING"]),
  message: z.string().max(4000).optional(),
});

export const progressBodySchema = z.object({
  progress: z.number().int().min(0).max(100),
});

export const noteBodySchema = z.object({
  note: z.string().min(1).max(4000),
});
