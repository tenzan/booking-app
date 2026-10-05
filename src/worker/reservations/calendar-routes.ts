import { Hono } from "hono";
import { t } from "../../shared/i18n/i18n";
import type { AppEnv } from "../env";
import { clock } from "../lib/clock";
import { sha256Hex } from "../lib/crypto";
import { HttpError } from "../lib/http";
import { rateLimit } from "../lib/rate-limit";
import { calendarFile, calendarTokenTarget, icsResponse } from "./ics";

const WINDOW_MS = 15 * 60_000;
const IP_LIMIT = 60;
const FILE = /^([A-Za-z0-9_-]{20,200})\.ics$/;

/**
 * `/api/cal/<token>.ics`: the calendar file behind an "Add to calendar" link, opened straight from an email or the app
 * (on an iPhone, one tap shows the Add to Calendar sheet). A calendar token only reads its reservation's file, as it
 * is now. A person lands here, not the app, so failures are short plain-text pages rather than JSON.
 */
export const calendarRoutes = new Hono<AppEnv>();

calendarRoutes.get("/:file", async (c) => {
  const ip = c.req.header("cf-connecting-ip");
  if (ip && !(await rateLimit(c.env.DB, `cal:ip:${ip}`, IP_LIMIT, WINDOW_MS))) throw new HttpError(429, "rate_limited");
  const home = `${c.env.APP_BASE_URL.replace(/\/+$/, "")}/`;
  const token = FILE.exec(c.req.param("file"))?.[1];
  const target = token ? await calendarTokenTarget(c.env.DB, await sha256Hex(token), clock.now()) : null;
  if (!target) return c.text(t("calendarLink.invalid", { url: home }), 404);
  try {
    return icsResponse(c, await calendarFile(c.env, target.id, target.audience));
  } catch (e) {
    if (e instanceof HttpError && e.status === 409) return c.text(t("calendarLink.unavailable", { url: home }), 409);
    throw e;
  }
});
