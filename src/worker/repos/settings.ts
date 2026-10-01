import type { Env } from "../env";
import { HttpError } from "../lib/http";
import { DEFAULT_SETTINGS, type Settings } from "../../domain/settings";
import type { BhCtx } from "../../domain/business-hours";

/** Defaults <- ORG_NAME env <- settings rows (key = Settings field, value = JSON). Always a fresh copy. */
export async function getSettings(db: D1Database, env: Env): Promise<Settings> {
  const s: Settings = structuredClone(DEFAULT_SETTINGS);
  if (env.ORG_NAME) s.orgName = env.ORG_NAME;

  const { results } = await db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const target = s as unknown as Record<string, unknown>;
  for (const { key, value } of results) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      console.warn(`settings: ignoring unparseable value for key "${key}"`);
      continue;
    }
    // A boolean switch with a stored non-boolean keeps its default (a bad row must not flip it).
    if (typeof DEFAULT_SETTINGS[key as keyof Settings] === "boolean" && typeof parsed !== "boolean") {
      console.warn(`settings: ignoring non-boolean value for key "${key}"`);
      continue;
    }
    target[key] = parsed;
  }
  return s;
}

export async function getHolidays(db: D1Database): Promise<Set<string>> {
  const { results } = await db.prepare("SELECT date FROM holidays").all<{ date: string }>();
  return new Set(results.map((r) => r.date));
}

export async function bhCtx(db: D1Database, env: Env, s?: Settings): Promise<BhCtx> {
  const settings = s ?? (await getSettings(db, env));
  return { tz: env.APP_TIMEZONE, hours: settings.businessHours, holidays: await getHolidays(db) };
}

/** Customer booking endpoints call this first: 409 booking_disabled while the admin switch is off. */
export async function assertBookingEnabled(db: D1Database, env: Env): Promise<void> {
  if (!(await getSettings(db, env)).bookingEnabled) throw new HttpError(409, "booking_disabled");
}
