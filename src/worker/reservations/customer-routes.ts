import { Hono } from "hono";
import { z } from "zod";
import { addDays } from "../../domain/time";
import type { AppEnv } from "../env";
import { HttpError, readJson } from "../lib/http";
import { kickOutbox } from "../mail/outbox";
import { rateLimit } from "../lib/rate-limit";
import { requireCustomer } from "../middleware/session";
import { eligibleAccountsForEmail, lastPhonesForEmail } from "../repos/customers";
import { customerAvailability } from "../scheduling/availability";
import { submitReservation } from "./submit";

const MAX_SPAN_DAYS = 31;
const SUBMIT_LIMIT = 10;
const HOUR_MS = 60 * 60_000;

/** YYYY-MM-DD that is a real calendar date. */
const isCalendarDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && addDays(s, 0) === s;
const dateSchema = z.string().refine(isCalendarDate);

const availabilityQuery = z
  .object({ from: dateSchema, to: dateSchema })
  .refine((q) => q.to >= q.from && q.to <= addDays(q.from, MAX_SPAN_DAYS));

export const customerRoutes = new Hono<AppEnv>();
customerRoutes.use("*", requireCustomer());

customerRoutes.get("/accounts", async (c) => {
  const email = c.var.customerEmail!;
  const [accounts, phones] = await Promise.all([eligibleAccountsForEmail(c.env.DB, email), lastPhonesForEmail(c.env.DB, email)]);
  return c.json({ accounts: accounts.map((a) => ({ ...a, lastPhone: phones.get(a.id) ?? null })) });
});

customerRoutes.get("/availability", async (c) => {
  const { from, to } = availabilityQuery.parse({ from: c.req.query("from"), to: c.req.query("to") });
  return c.json(await customerAvailability(c.env, from, to));
});

const submitBody = z.object({
  customerId: z.number().int(),
  startAt: z.number().int(),
  contactName: z.string().trim().min(1).max(100),
  phone: z.string().min(5).max(30).regex(/^[0-9+()\- ]+$/),
  issue: z.string().trim().min(1).max(1000),
  idempotencyKey: z.uuid(),
});

customerRoutes.post("/reservations", async (c) => {
  if (!(await rateLimit(c.env.DB, `submit:${c.var.sessionHash}`, SUBMIT_LIMIT, HOUR_MS))) throw new HttpError(429, "rate_limited");
  const input = await readJson(c, submitBody);
  const { created, ...reservation } = await submitReservation(c.env, c.var.customerEmail!, input);
  if (created) kickOutbox(c);
  return c.json({ reservation }, created ? 201 : 200);
});
