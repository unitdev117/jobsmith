export const DEFAULT_PORT = 7050;

const validPort = (value: number): number => {
  if (!Number.isInteger(value) || value < 1 || value > 65535)
    throw new Error("Use a port between 1 and 65535");
  return value;
};

export function resolvePort(
  argv: string[],
  source: Record<string, string | undefined> = process.env,
): number {
  const flag = argv.indexOf("--port");
  if (flag >= 0) {
    const raw = argv[flag + 1];
    if (!raw) throw new Error("Use --port <number>");
    return validPort(Number(raw));
  }
  if (source.JOBSMITH_PORT) return validPort(Number(source.JOBSMITH_PORT));
  return DEFAULT_PORT;
}

export const DEFAULT_RATE_LIMIT = 120;

export function resolveRateLimit(
  source: Record<string, string | undefined> = process.env,
): number {
  const raw = source.JOBSMITH_RATE_LIMIT;
  if (!raw) return DEFAULT_RATE_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1)
    throw new Error("JOBSMITH_RATE_LIMIT must be a positive integer");
  return value;
}
