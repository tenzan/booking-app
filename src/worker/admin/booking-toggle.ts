import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { audit } from "../lib/db";
import { readJson } from "../lib/http";
import { requireStaff } from "../middleware/session";

const body = z.object({ enabled: z.boolean() });

/** Admin switch for online booking (the setting `bookingEnabled`); the full settings API comes later. */
export const bookingToggleRoutes = new Hono<AppEnv>();

bookingToggleRoutes.post("/settings/booking", requireStaff("admin"), async (c) => {
  const { enabled } = await readJson(c, body);
  const db = c.env.DB;
  await db.batch([
    db
      .prepare("INSERT INTO settings(key, value) VALUES ('bookingEnabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(JSON.stringify(enabled)),
    audit(db, { actorKind: "staff", actor: c.var.staff!.email, action: "settings.booking", details: { enabled } }),
  ]);
  return c.json({ bookingEnabled: enabled });
});
