import { Hono } from "hono";
import { z } from "zod";
import { addDays } from "../../domain/time";
import { isoDateSchema, reservationListQuerySchema } from "../../shared/schemas";
import type { AppEnv } from "../env";
import { HttpError, readJson } from "../lib/http";
import { kickOutbox } from "../mail/outbox";
import { requireStaff } from "../middleware/session";
import { approveReservation } from "./approve";
import { cancelReservation } from "./cancel";
import { declineReservation } from "./decline";
import { CANDIDATE_MAX_DAYS, proposalCandidates, proposeBody, proposeReservation, withdrawProposal } from "./propose";
import { reassignReservation } from "./reassign";
import { getAudit, getReservation, listReservations, techOptions } from "./queries";

const approveBody = z.object({ staffId: z.number().int(), version: z.number().int() });
const declineBody = z.object({ reason: z.string().trim().min(1).max(500), version: z.number().int() });
const reassignBody = approveBody;
const cancelBody = declineBody;
const withdrawBody = z.object({ proposalId: z.string().min(1).max(100) });
const candidatesQuery = z
  .object({ from: isoDateSchema, to: isoDateSchema })
  .refine((q) => q.to >= q.from && q.to <= addDays(q.from, CANDIDATE_MAX_DAYS - 1));

export const staffReservationRoutes = new Hono<AppEnv>();
staffReservationRoutes.use("*", requireStaff());

staffReservationRoutes.get("/reservations", async (c) => {
  return c.json(await listReservations(c.env.DB, reservationListQuerySchema.parse(c.req.query())));
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

staffReservationRoutes.post("/reservations/:id/reassign", async (c) => {
  const { staffId, version } = await readJson(c, reassignBody);
  const reservation = await reassignReservation(c.env, c.var.staff!, c.req.param("id"), staffId, version);
  kickOutbox(c);
  return c.json({ reservation });
});

staffReservationRoutes.post("/reservations/:id/cancel", async (c) => {
  const { reason, version } = await readJson(c, cancelBody);
  const reservation = await cancelReservation(c.env, { kind: "staff", staff: c.var.staff! }, c.req.param("id"), { reason, version });
  kickOutbox(c);
  return c.json({ reservation });
});

staffReservationRoutes.post("/reservations/:id/propose", async (c) => {
  const input = await readJson(c, proposeBody);
  const reservation = await proposeReservation(c.env, c.var.staff!, c.req.param("id"), input);
  kickOutbox(c);
  return c.json({ reservation });
});

staffReservationRoutes.post("/reservations/:id/proposal/withdraw", async (c) => {
  const { proposalId } = await readJson(c, withdrawBody);
  const reservation = await withdrawProposal(c.env, c.var.staff!, c.req.param("id"), proposalId);
  kickOutbox(c);
  return c.json({ reservation });
});

staffReservationRoutes.get("/reservations/:id/proposal-candidates", async (c) => {
  const { from, to } = candidatesQuery.parse({ from: c.req.query("from"), to: c.req.query("to") });
  return c.json(await proposalCandidates(c.env, c.req.param("id"), from, to));
});
