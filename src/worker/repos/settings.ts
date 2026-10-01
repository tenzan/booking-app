import type { Env } from "../env";
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
    try {
      target[key] = JSON.parse(value);
    } catch {
      console.warn(`settings: ignoring unparseable value for key "${key}"`);
    }
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
