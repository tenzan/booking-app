import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { HttpError, readJson } from "../lib/http";
import { kickOutbox } from "../mail/outbox";
import { requireStaff } from "../middleware/session";
import { approveReservation } from "./approve";
import { declineReservation } from "./decline";
import { getAudit, getReservation, listReservations, techOptions } from "./queries";

const STATUSES = ["pending", "confirmed", "declined", "expired", "cancelled", "completed"] as const;

const listQuery = z.object({
  status: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(",") : undefined))
    .pipe(z.array(z.enum(STATUSES)).optional()),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
  staffId: z.coerce.number().int().optional(),
});
const approveBody = z.object({ staffId: z.number().int(), version: z.number().int() });
const declineBody = z.object({ reason: z.string().trim().min(1).max(500), version: z.number().int() });

export const staffReservationRoutes = new Hono<AppEnv>();
staffReservationRoutes.use("*", requireStaff());

staffReservationRoutes.get("/reservations", async (c) => {
  const filters = listQuery.parse({
    status: c.req.query("status"),
    from: c.req.query("from"),
    to: c.req.query("to"),
    staffId: c.req.query("staffId"),
  });
  return c.json({ reservations: await listReservations(c.env.DB, filters) });
});

staffReservationRoutes.get("/reservations/:id", async (c) => {
  const reservation = await getReservation(c.env.DB, c.req.param("id"));
  if (!reservation) throw new HttpError(404, "not_found");
  const [options, trail] = await Promise.all([techOptions(c.env, reservation), getAudit(c.env.DB, reservation.id)]);
  return c.json({ reservation, techOptions: options, audit: trail });
});

staffReservationRoutes.post("/reservations/:id/approve", async (c) => {
  const { staffId, version } = await readJson(c, approveBody);
  const reservation = await approveReservation(c.env, c.var.staff!, c.req.param("id"), staffId, version);
  kickOutbox(c);
  return c.json({ reservation });
});

staffReservationRoutes.post("/reservations/:id/decline", async (c) => {
  const { reason, version } = await readJson(c, declineBody);
  const reservation = await declineReservation(c.env, c.var.staff!, c.req.param("id"), reason, version);
  kickOutbox(c);
  return c.json({ reservation });
});
