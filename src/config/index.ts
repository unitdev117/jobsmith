import "dotenv/config";
import { z } from "zod";

const optionalPostgresUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().url().startsWith("postgresql://").optional(),
);

const valkeyUrl = z
  .string()
  .url()
  .refine(
    (value) => value.startsWith("redis://") || value.startsWith("rediss://"),
    {
      message: "must start with redis:// or rediss://",
    },
  );

const schema = z.object({
  DATABASE_URL: z.string().url().startsWith("postgresql://"),
  DATABASE_MIGRATION_URL: optionalPostgresUrl,
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("warn"),
});

export type DatabaseConfig = z.infer<typeof schema>;

const hostSchema = schema.extend({
  VALKEY_URL: valkeyUrl,
  INVITE_TTL_MINUTES: z.coerce.number().int().min(1).max(60).default(5),
});

export type HostConfig = z.infer<typeof hostSchema>;

export function loadDatabaseConfig(
  source: Record<string, string | undefined> = process.env,
): DatabaseConfig {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${details}`);
  }
  return parsed.data;
}

export function loadHostConfig(
  source: Record<string, string | undefined> = process.env,
): HostConfig {
  const parsed = hostSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${details}`);
  }
  return parsed.data;
}

export function loadInviteTtl(
  source: Record<string, string | undefined> = process.env,
): number {
  return z.coerce
    .number()
    .int()
    .min(1)
    .max(60)
    .default(5)
    .parse(source.INVITE_TTL_MINUTES);
}
