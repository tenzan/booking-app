import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import { HttpError } from "../lib/http";

export const security: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Cache-Control", "no-store");
  const method = c.req.method;
  if (method !== "GET" && method !== "HEAD") {
    const origin = c.req.header("origin");
    const xrw = c.req.header("x-requested-with");
    if (origin !== new URL(c.env.APP_BASE_URL).origin || xrw !== "fetch") {
      throw new HttpError(403, "csrf");
    }
  }
  await next();
};
