import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { clock } from "../lib/clock";
import { sha256Hex } from "../lib/crypto";
import { HttpError, readJson } from "../lib/http";
import { rateLimit } from "../lib/rate-limit";
import { getSettings } from "../repos/settings";
import { cancelAsCustomer, customerCancelBody } from "./cancel";
import { kickOutbox } from "../mail/outbox";
import { getAccessTokenTarget, getCustomerReservationByAccessToken } from "./queries";
import { acceptBody, acceptProposal, rejectBody, rejectProposal } from "./respond";

const WINDOW_MS = 15 * 60_000;
const IP_LIMIT = 60;

const tokenField = z.string().min(20).max(200);
const body = z.object({ token: tokenField });
const cancelBody = customerCancelBody.extend({ token: tokenField });
const acceptTokenBody = acceptBody.extend({ token: tokenField });
const rejectTokenBody = rejectBody.extend({ token: tokenField });

/** Link-based access (from emails): no session, the token alone scopes access to one reservation. */
export const accessRoutes = new Hono<AppEnv>();

const limitByIp = async (c: Context<AppEnv>) => {
  const ip = c.req.header("cf-connecting-ip");
  if (ip && !(await rateLimit(c.env.DB, `access:ip:${ip}`, IP_LIMIT, WINDOW_MS))) throw new HttpError(429, "rate_limited");
};

accessRoutes.post("/reservation", async (c) => {
  await limitByIp(c);
  const { token } = await readJson(c, body);
  // Unknown, tampered and expired tokens are deliberately indistinguishable.
  const reservation = await getCustomerReservationByAccessToken(c.env.DB, await sha256Hex(token), clock.now());
  if (!reservation) throw new HttpError(404, "invalid_link");
  const settings = await getSettings(c.env.DB, c.env);
  return c.json({ reservation, timezone: c.env.APP_TIMEZONE, supportPhone: settings.supportPhone, cancelCutoffMin: settings.cancelCutoffMin });
});

/** Cancel through the link: the token scopes this to one reservation and the contact on it is the one acting. */
accessRoutes.post("/reservation/cancel", async (c) => {
  await limitByIp(c);
  const { token, ...input } = await readJson(c, cancelBody);
  const target = await getAccessTokenTarget(c.env.DB, await sha256Hex(token), clock.now());
  if (!target) throw new HttpError(404, "invalid_link");
  const reservation = await cancelAsCustomer(c.env, target.contactEmail, target.id, input);
  kickOutbox(c);
  return c.json({ reservation });
});

/** Answer the reservation's proposal through the link (accept one option): the reservation's contact is the one acting. */
accessRoutes.post("/proposal/accept", async (c) => {
  await limitByIp(c);
  const { token, ...input } = await readJson(c, acceptTokenBody);
  const target = await getAccessTokenTarget(c.env.DB, await sha256Hex(token), clock.now());
  if (!target) throw new HttpError(404, "invalid_link");
  const reservation = await acceptProposal(c.env, target.contactEmail, target.id, input);
  kickOutbox(c);
  return c.json({ reservation });
});

/** Keep the original time through the link: the proposal is rejected. */
accessRoutes.post("/proposal/reject", async (c) => {
  await limitByIp(c);
  const { token, ...input } = await readJson(c, rejectTokenBody);
  const target = await getAccessTokenTarget(c.env.DB, await sha256Hex(token), clock.now());
  if (!target) throw new HttpError(404, "invalid_link");
  const reservation = await rejectProposal(c.env, target.contactEmail, target.id, input);
  kickOutbox(c);
  return c.json({ reservation });
});
