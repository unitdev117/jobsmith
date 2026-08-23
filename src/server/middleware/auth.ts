import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { Logger } from "pino";

// Hashing both sides lets timingSafeEqual work on fixed-length digests.
const digest = (value: string): Buffer =>
  createHash("sha256").update(value).digest();

export const bearerAuth =
  (token: string | undefined, log: Logger): MiddlewareHandler =>
  async (c, next) => {
    if (!token) return next();
    const header = c.req.header("authorization") ?? "";
    const matches = timingSafeEqual(digest(header), digest(`Bearer ${token}`));
    if (!matches) {
      log.warn(
        { event: "server.auth_failed", path: c.req.path },
        "Unauthorized API request",
      );
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
