import { Hono } from "hono";
import { z } from "zod";
import { runSweeps } from "../cron";
import type { AppEnv } from "../env";
import { clock } from "../lib/clock";
import { HttpError } from "../lib/http";
import { devRoutesEnabled } from "../lib/local";
import { processOutbox } from "../mail/outbox";

export const devRoutes = new Hono<AppEnv>();

/** Local development only: dev mail on a localhost app, and the request itself to a loopback host. Otherwise not found. */
devRoutes.use("*", async (c, next) => {
  if (!devRoutesEnabled(c.env, c.req.url)) return c.json({ error: "not_found" }, 404);
  await next();
});

devRoutes.get("/mail", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, to_email, subject, html, text, reply_to, created_at FROM dev_mailbox ORDER BY id DESC LIMIT 50",
  ).all<{ id: number; to_email: string; subject: string; html: string; text: string; reply_to: string | null; created_at: number }>();
  return c.json({
    messages: results.map((r) => ({ id: r.id, to: r.to_email, subject: r.subject, html: r.html, text: r.text, replyTo: r.reply_to, createdAt: r.created_at })),
  });
});

const cronBody = z.object({ now: z.number().int().positive().optional() }).strict();

/** Run the per-minute cron on demand (e2e): the sweeps as of `now` (default: the clock), then the outbox. Local dev only, like the mailbox. */
devRoutes.post("/cron", async (c) => {
  const raw = await c.req.text();
  let body: unknown = {};
  if (raw.trim() !== "") {
    try {
      body = JSON.parse(raw);
    } catch {
      throw new HttpError(400, "invalid_json");
    }
  }
  const { now } = cronBody.parse(body);
  const sweeps = await runSweeps(c.env, now ?? clock.now());
  const outbox = await processOutbox(c.env, 50);
  return c.json({ ...sweeps, outbox });
});
