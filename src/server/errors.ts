import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Logger } from "pino";
import type { ZodError } from "zod";
import { ServiceError } from "../services/errors.ts";

export const validationFailure = (c: Context, details: string[]): Response =>
  c.json({ error: "validation_failed", details }, 400);

export const validationDetails = (error: ZodError): string[] =>
  error.issues.map(
    (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
  );

// Carries ServiceError statuses straight through; everything else is a 500
// that must never leak stack traces or internals to the client.
export function handleError(c: Context, log: Logger, error: unknown): Response {
  if (error instanceof ServiceError)
    return c.json(
      { error: error.message },
      error.status as ContentfulStatusCode,
    );
  log.error(
    { event: "server.unhandled_error", err: error },
    "Request failed with an unhandled error",
  );
  return c.json({ error: "internal_error" }, 500);
}
