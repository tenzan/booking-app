import { Hono } from "hono";
import { buildCalendar } from "../domain/ics";
import { t } from "../shared/i18n/i18n";
import type { AppEnv, Env } from "./env";
import { clock } from "./lib/clock";
import { audit } from "./lib/db";
import { randomToken } from "./lib/crypto";
import { HttpError } from "./lib/http";
import { rateLimit } from "./lib/rate-limit";
import { requireStaff } from "./middleware/session";
import { getSettings } from "./repos/settings";
import { ICS_SELECT, staffEventFromRow, type IcsRow } from "./reservations/ics";

export type FeedKind = "mine" | "team";

const DAY = 86_400_000;
const WINDOW_MS = 15 * 60_000;
const IP_LIMIT = 120;
const TOKEN = /^[A-Za-z0-9_-]{20,200}$/;
const FILE = /^(mine|team)\.ics$/;

const baseUrl = (env: Env) => env.APP_BASE_URL.replace(/\/+$/, "");
export const feedUrl = (env: Env, token: string, kind: FeedKind) => `${baseUrl(env)}/api/feed/${token}/${kind}.ics`;

/** "Tim" from "Tim Tech": the Team calendar's title prefix. */
export const firstName = (name: string | null) => name?.trim().split(/\s+/)[0] || "—";

/** The staff member an active feed token belongs to; a reset token or a deactivated owner reads nothing. */
export async function staffIdForFeedToken(db: D1Database, token: string): Promise<number | null> {
  const row = await db
    .prepare("SELECT f.staff_id FROM calendar_feeds f JOIN staff s ON s.id = f.staff_id WHERE f.token = ? AND s.active = 1")
    .bind(token)
    .first<{ staff_id: number }>();
  return row?.staff_id ?? null;
}

/** Confirmed appointments from 30 days ago on: mine, or everyone else's, as one calendar. */
export async function feedCalendar(env: Env, staffId: number, kind: FeedKind, now: number): Promise<string> {
  const { results } = await env.DB.prepare(
    `${ICS_SELECT} WHERE r.status = 'confirmed' AND r.end_at > ?1 AND r.assigned_staff_id ${kind === "mine" ? "=" : "<>"} ?2 ORDER BY r.start_at, r.id`,
  )
    .bind(now - 30 * DAY, staffId)
    .all<IcsRow>();
  const s = await getSettings(env.DB, env);
  const events = results.map((r) =>
    staffEventFromRow(
      env,
      r,
      kind === "mine"
        ? t("calendarFeed.mineSummary", { customer: r.customer_name, ref: r.ref })
        : t("calendarFeed.teamSummary", { tech: firstName(r.assigned_name), customer: r.customer_name, ref: r.ref }),
    ),
  );
  return buildCalendar({ name: t(kind === "mine" ? "calendarFeed.mineName" : "calendarFeed.teamName", { org: s.orgName }), events });
}

/** `/api/feed/<token>/{mine,team}.ics`: polled by calendar apps, so failures are plain text for a person who opens one. */
export const feedRoutes = new Hono<AppEnv>();

feedRoutes.get("/:token/:file", async (c) => {
  const ip = c.req.header("cf-connecting-ip");
  if (ip && !(await rateLimit(c.env.DB, `feed:ip:${ip}`, IP_LIMIT, WINDOW_MS))) throw new HttpError(429, "rate_limited");
  const token = c.req.param("token");
  const kind = FILE.exec(c.req.param("file"))?.[1] as FeedKind | undefined;
  const staffId = kind && TOKEN.test(token) ? await staffIdForFeedToken(c.env.DB, token) : null;
  if (!kind || staffId === null) return c.text(t("calendarFeed.invalid", { url: `${baseUrl(c.env)}/` }), 404);
  return c.body(await feedCalendar(c.env, staffId, kind, clock.now()), 200, {
    "Content-Type": "text/calendar; charset=utf-8",
    "Content-Disposition": `inline; filename="${kind}.ics"`,
    "Cache-Control": "no-store",
  });
});

/** The caller's token, created on first use. INSERT OR IGNORE makes a race between two tabs end with one token. */
export async function ensureFeedToken(db: D1Database, staffId: number): Promise<string> {
  await db.prepare("INSERT OR IGNORE INTO calendar_feeds(staff_id, token, created_at) VALUES (?, ?, ?)").bind(staffId, randomToken(), clock.now()).run();
  const row = await db.prepare("SELECT token FROM calendar_feeds WHERE staff_id = ?").bind(staffId).first<{ token: string }>();
  return row!.token;
}

/** Staff session routes for the subscribe card (mounted under /api/staff). */
export const staffFeedRoutes = new Hono<AppEnv>();
staffFeedRoutes.use("*", requireStaff());

/** A POST, since the first call creates the token (no GET changes state). */
staffFeedRoutes.post("/calendar-feed", async (c) => {
  const token = await ensureFeedToken(c.env.DB, c.var.staff!.id);
  return c.json({ mine: feedUrl(c.env, token, "mine"), team: feedUrl(c.env, token, "team") });
});

/** New links; calendars subscribed with the old ones stop updating. Recorded in the activity log. */
staffFeedRoutes.post("/calendar-feed/reset", async (c) => {
  const staff = c.var.staff!;
  const token = randomToken();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO calendar_feeds(staff_id, token, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(staff_id) DO UPDATE SET token = ?2, created_at = ?3",
    ).bind(staff.id, token, clock.now()),
    audit(c.env.DB, { actorKind: "staff", actor: String(staff.id), action: "calendar_feed.reset" }),
  ]);
  return c.json({ mine: feedUrl(c.env, token, "mine"), team: feedUrl(c.env, token, "team") });
});
