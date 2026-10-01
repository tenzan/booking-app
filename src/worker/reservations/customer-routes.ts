import { Hono } from "hono";
import { z } from "zod";
import { addDays } from "../../domain/time";
import type { AppEnv } from "../env";
import { requireCustomer } from "../middleware/session";
import { eligibleAccountsForEmail, lastPhonesForEmail } from "../repos/customers";
import { customerAvailability } from "../scheduling/availability";

const MAX_SPAN_DAYS = 31;

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
