import type { Context, MiddlewareHandler } from "hono";
import type { Logger } from "pino";

// Minimal counter surface; tests inject an in-memory backend.
export interface RateLimitCounter {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<void>;
}

export interface RateLimitDeps {
  counter: Pick<RateLimitCounter, "incr" | "expire">;
  projectId: string;
  limit: number;
  log: Logger;
  now?: () => number;
  windowSeconds?: number;
  onBlock?: (() => void) | undefined;
}

export const clientIp = (c: Context): string =>
  (c.env as { incomingSocket?: { remoteAddress?: string } } | undefined)
    ?.incomingSocket?.remoteAddress ?? "local";

// Fixed-window counter in Valkey; availability beats strictness, so any
// backend failure allows the request through.
export const rateLimiter =
  (deps: RateLimitDeps): MiddlewareHandler =>
  async (c, next) => {
    const windowSeconds = deps.windowSeconds ?? 60;
    const windowMs = windowSeconds * 1000;
    const at = (deps.now ?? Date.now)();
    const windowIndex = Math.floor(at / windowMs);
    const resetSeconds = Math.max(
      1,
      Math.ceil(((windowIndex + 1) * windowMs - at) / 1000),
    );
    const ip = clientIp(c);
    const key = `jobsmith:${deps.projectId}:rl:${windowIndex}:${ip}`;

    let count: number;
    try {
      count = await deps.counter.incr(key);
      if (count === 1) await deps.counter.expire(key, windowSeconds);
    } catch (error) {
      deps.log.warn(
        { event: "ratelimit.backend_error", err: error },
        "Rate limit backend unavailable; allowing request",
      );
      return next();
    }

    c.header("X-RateLimit-Limit", String(deps.limit));
    c.header("X-RateLimit-Remaining", String(Math.max(0, deps.limit - count)));
    c.header("X-RateLimit-Reset", String(resetSeconds));

    if (count > deps.limit) {
      deps.log.warn(
        { event: "ratelimit.blocked", ip, windowIndex },
        "Request blocked by rate limit",
      );
      deps.onBlock?.();
      return c.json({ error: "rate_limited" }, 429, {
        "Retry-After": String(resetSeconds),
      });
    }
    await next();
  };
