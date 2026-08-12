import pino, {
  type DestinationStream,
  type LevelWithSilent,
  type Logger,
} from "pino";

const redactPaths = [
  "password",
  "token",
  "secret",
  "authorization",
  "cookie",
  "apiKey",
  "DATABASE_URL",
  "DATABASE_MIGRATION_URL",
  "VALKEY_URL",
  "databaseUrl",
  "valkeyUrl",
  "connectionString",
  "invite",
  "*.password",
  "*.token",
  "*.secret",
  "*.authorization",
  "*.cookie",
  "*.apiKey",
  "*.databaseUrl",
  "*.valkeyUrl",
  "*.connectionString",
  "*.invite",
  "*.*.password",
  "*.*.token",
  "*.*.secret",
  "*.*.authorization",
  "*.*.cookie",
  "*.*.apiKey",
];

export function createLogger(
  service: string,
  destination?: DestinationStream,
  level: LevelWithSilent = (process.env.LOG_LEVEL as LevelWithSilent) ?? "warn",
): Logger {
  return pino(
    {
      level,
      base: { service },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: redactPaths, censor: "[REDACTED]" },
      serializers: {
        err: (error: Error) => {
          const serialized = pino.stdSerializers.err(error);
          return {
            ...serialized,
            message: serialized.message?.slice(0, 16384),
            stack: serialized.stack?.slice(0, 32768),
          };
        },
      },
    },
    destination,
  );
}

export const logger = createLogger("jobsmith");

export function errorFields(error: unknown): { err: Error; errorType: string } {
  const err = error instanceof Error ? error : new Error(String(error));
  return { err, errorType: err.name };
}
