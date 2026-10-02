import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import { HttpError } from "../lib/http";

export const security: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  // JSON only: nothing here is ever rendered as a document or framed. (The SPA's CSP lives in public/_headers.)
  c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  c.header("Cache-Control", "no-store");
  // No preload: that is a separate, hard-to-undo commitment for the whole registrable domain.
  c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
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
