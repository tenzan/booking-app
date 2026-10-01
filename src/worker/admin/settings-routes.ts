import { Hono } from "hono";
import { z } from "zod";
import { HolidayImportError, planHolidayImport, type HolidayImportRow } from "../../domain/holiday-import";
import { utcToWall } from "../../domain/time";
import type { Settings } from "../../domain/settings";
import { settingsApplyBodySchema, settingsPatchIssues, settingsPreviewBodySchema } from "../../shared/schemas";
import type { ImpactDTO } from "../../shared/types";
import type { AppEnv } from "../env";
import { clock } from "../lib/clock";
import { readScheduleVersion } from "../lib/db";
import { HttpError, readJson } from "../lib/http";
import { requireStaff } from "../middleware/session";
import { getSettings } from "../repos/settings";
import { applyChange, previewChange, type ScheduleChange } from "../scheduling/roster";

/** Settings and holidays: any staff member may read; admins change them (through the roster engine's preview/apply). */
export const settingsRoutes = new Hono<AppEnv>();

const EMPTY_IMPACT: ImpactDTO = { moved: [], conflicts: [], warnings: [] };

/** The patch is checked field by field by the body schema; here the merged result (cross-field rules) against what is stored. */
async function settingsChange(c: { env: AppEnv["Bindings"] }, patch: Partial<Settings>): Promise<ScheduleChange> {
  const issues = settingsPatchIssues(await getSettings(c.env.DB, c.env), patch);
  // Paths are relative to the request body, like the schema errors of the same request.
  if (issues.length > 0) throw new HttpError(400, "invalid", issues.map((i) => ({ ...i, path: ["patch", ...i.path] })));
  return { type: "settings.update", patch };
}

settingsRoutes.get("/settings", requireStaff(), async (c) => {
  return c.json({ settings: await getSettings(c.env.DB, c.env), timezone: c.env.APP_TIMEZONE });
});

settingsRoutes.post("/settings/preview", requireStaff("admin"), async (c) => {
  const { patch } = await readJson(c, settingsPreviewBodySchema);
  return c.json(await previewChange(c.env, await settingsChange(c, patch)));
});

settingsRoutes.post("/settings/apply", requireStaff("admin"), async (c) => {
  const { patch, version } = await readJson(c, settingsApplyBodySchema);
  return c.json(await applyChange(c.env, c.var.staff!, await settingsChange(c, patch), version));
});

// ---- Holidays ---------------------------------------------------------------------------------------------------

const yearQuery = z.coerce.number().int().min(1970).max(2200);

/** Holidays of a calendar year (default: the current year in the app time zone), by date. */
settingsRoutes.get("/holidays", requireStaff(), async (c) => {
  const raw = c.req.query("year");
  const year = raw === undefined ? Number(utcToWall(clock.now(), c.env.APP_TIMEZONE).date.slice(0, 4)) : yearQuery.parse(raw);
  const { results } = await c.env.DB.prepare("SELECT date, name FROM holidays WHERE date >= ? AND date <= ? ORDER BY date")
    .bind(`${year}-01-01`, `${year}-12-31`)
    .all<{ date: string; name: string }>();
  return c.json(results);
});

const importBody = z.object({ csv: z.string().max(100_000) });
const importApplyBody = importBody.extend({ version: z.number().int().nonnegative() });

type ImportRowDTO = HolidayImportRow & { /** Appointments or requests that the holiday would take away (preview only). */ conflicts: number };

/** Plans the import against the stored holidays; the rows that would write something become one composite change. */
async function planImport(c: { env: AppEnv["Bindings"] }, csv: string) {
  const { results } = await c.env.DB.prepare("SELECT date, name FROM holidays").all<{ date: string; name: string }>();
  let rows: HolidayImportRow[];
  try {
    rows = planHolidayImport(csv, new Map(results.map((h) => [h.date, h.name])));
  } catch (e) {
    if (e instanceof HolidayImportError) throw new HttpError(400, e.code, e.line === undefined ? undefined : { line: e.line, message: e.message });
    throw e;
  }
  const set = rows.filter((r) => r.status === "new" || r.status === "changed").map((r) => ({ date: r.date, name: r.name }));
  const change: ScheduleChange | null = set.length > 0 ? { type: "holiday.bulk", set } : null;
  return { rows, change };
}

settingsRoutes.post("/holidays/import/preview", requireStaff("admin"), async (c) => {
  const { csv } = await readJson(c, importBody);
  const { rows, change } = await planImport(c, csv);
  const { version, impact } = change ? await previewChange(c.env, change) : { version: await readScheduleVersion(c.env.DB), impact: EMPTY_IMPACT };
  const perDate = new Map<string, number>();
  for (const k of impact.conflicts) {
    const date = utcToWall(k.startAt, c.env.APP_TIMEZONE).date;
    perDate.set(date, (perDate.get(date) ?? 0) + 1);
  }
  const dto: ImportRowDTO[] = rows.map((r) => ({ ...r, conflicts: r.status === "error" ? 0 : (perDate.get(r.date) ?? 0) }));
  return c.json({ version, rows: dto, impact });
});

settingsRoutes.post("/holidays/import/apply", requireStaff("admin"), async (c) => {
  const { csv, version } = await readJson(c, importApplyBody);
  const { rows, change } = await planImport(c, csv);
  if (rows.some((r) => r.status === "error")) throw new HttpError(400, "invalid_rows", { rows: rows.filter((r) => r.status === "error") });
  if (!change) throw new HttpError(400, "nothing_to_import");
  const result = await applyChange(c.env, c.var.staff!, change, version);
  return c.json({ ...result, applied: rows.filter((r) => r.status !== "unchanged").length });
});

