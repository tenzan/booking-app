import { Hono } from "hono";
import type { AppEnv } from "../env";
import { devMailEnabled } from "../lib/local";

export const devRoutes = new Hono<AppEnv>();

devRoutes.get("/mail", async (c) => {
  if (!devMailEnabled(c.env)) return c.json({ error: "not_found" }, 404);
  const { results } = await c.env.DB.prepare(
    "SELECT id, to_email, subject, html, text, reply_to, created_at FROM dev_mailbox ORDER BY id DESC LIMIT 50",
  ).all<{ id: number; to_email: string; subject: string; html: string; text: string; reply_to: string | null; created_at: number }>();
  return c.json({
    messages: results.map((r) => ({ id: r.id, to: r.to_email, subject: r.subject, html: r.html, text: r.text, replyTo: r.reply_to, createdAt: r.created_at })),
  });
});
