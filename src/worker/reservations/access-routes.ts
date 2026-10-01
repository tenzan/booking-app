import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { clock } from "../lib/clock";
import { sha256Hex } from "../lib/crypto";
import { HttpError, readJson } from "../lib/http";
import { rateLimit } from "../lib/rate-limit";
import { getSettings } from "../repos/settings";
import { getCustomerReservationByAccessToken } from "./queries";

const WINDOW_MS = 15 * 60_000;
const IP_LIMIT = 60;

const body = z.object({ token: z.string().min(20).max(200) });

/** Link-based access (from emails): no session, the token alone scopes access to one reservation. */
export const accessRoutes = new Hono<AppEnv>();

accessRoutes.post("/reservation", async (c) => {
  const ip = c.req.header("cf-connecting-ip");
  if (ip && !(await rateLimit(c.env.DB, `access:ip:${ip}`, IP_LIMIT, WINDOW_MS))) throw new HttpError(429, "rate_limited");
  const { token } = await readJson(c, body);
  // Unknown, tampered and expired tokens are deliberately indistinguishable.
  const reservation = await getCustomerReservationByAccessToken(c.env.DB, await sha256Hex(token), clock.now());
  if (!reservation) throw new HttpError(404, "invalid_link");
  const settings = await getSettings(c.env.DB, c.env);
  return c.json({ reservation, timezone: c.env.APP_TIMEZONE, supportPhone: settings.supportPhone, cancelCutoffMin: settings.cancelCutoffMin });
});
