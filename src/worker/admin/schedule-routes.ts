import { Hono } from "hono";
import { z } from "zod";
import { utcToWall } from "../../domain/time";
import { applyBodySchema, previewBodySchema, type ScheduleEdit } from "../../shared/schemas";
import type { UnavailabilityDTO, WindowDTO } from "../../shared/types";
import type { AppEnv, Env, StaffPrincipal } from "../env";
import { clock } from "../lib/clock";
import { HttpError, readJson } from "../lib/http";
import { requireStaff } from "../middleware/session";
import { loadWindows } from "../repos/schedule";
import { applyChange, previewChange } from "../scheduling/roster";

/** Schedule editing: any staff member may look; admins change everything, technicians only their own time off. */
export const scheduleRoutes = new Hono<AppEnv>();
scheduleRoutes.use("*", requireStaff());

async function authorize(env: Env, actor: StaffPrincipal, change: ScheduleEdit): Promise<void> {
  if (actor.role === "admin") return;
  if (change.type === "unavailability.create" && change.staffId === actor.id) return;
  if (change.type === "unavailability.delete") {
    const row = await env.DB.prepare("SELECT staff_id AS staffId FROM staff_unavailability WHERE id = ?").bind(change.id).first<{ staffId: number }>();
    if (!row) throw new HttpError(404, "not_found");
    if (row.staffId === actor.id) return;
  }
  throw new HttpError(403, "forbidden");
}

scheduleRoutes.get("/windows", async (c) => {
  const db = c.env.DB;
  const today = utcToWall(clock.now(), c.env.APP_TIMEZONE).date;
  const [windows, overrides, staff] = await Promise.all([
    loadWindows(db, today, "9999-12-31"),
    db.prepare("SELECT date, note FROM date_overrides WHERE date >= ? ORDER BY date").bind(today).all<{ date: string; note: string | null }>(),
    db.prepare("SELECT id, name, bookable, active FROM staff ORDER BY name, id").all<{ id: number; name: string; bookable: number; active: number }>(),
  ]);
  const dto = (w: WindowDTO): WindowDTO => ({ id: w.id, kind: w.kind, weekday: w.weekday, date: w.date, startMin: w.startMin, endMin: w.endMin, staffIds: w.staffIds });
  return c.json({
    weekly: windows.filter((w) => w.kind === "weekly").map(dto),
    overrides: overrides.results.map((o) => ({
      date: o.date,
      note: o.note,
      windows: windows.filter((w) => w.kind === "date" && w.date === o.date).map(dto),
    })),
    staff: staff.results.map((s) => ({ id: s.id, name: s.name, bookable: s.bookable === 1, active: s.active === 1 })),
  });
});

const unavailabilityQuery = z.object({
  staffId: z.coerce.number().int().positive().optional(),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
});

const DEFAULT_SPAN_MS = 90 * 24 * 60 * 60_000;
const MAX_ROWS = 500;

/** Time off overlapping [from (default now), to (default from + 90 days)), soonest first, at most 500 rows; reasons only for admins and the owner. */
scheduleRoutes.get("/unavailability", async (c) => {
  const q = unavailabilityQuery.parse({ staffId: c.req.query("staffId"), from: c.req.query("from"), to: c.req.query("to") });
  const from = q.from ?? clock.now();
  const where = ["u.end_at > ?", "u.start_at < ?"];
  const binds: unknown[] = [from, q.to ?? from + DEFAULT_SPAN_MS];
  if (q.staffId !== undefined) {
    where.push("u.staff_id = ?");
    binds.push(q.staffId);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.staff_id AS staffId, s.name AS staffName, u.start_at AS startAt, u.end_at AS endAt, u.reason
     FROM staff_unavailability u JOIN staff s ON s.id = u.staff_id
     WHERE ${where.join(" AND ")} ORDER BY u.start_at, u.id LIMIT ${MAX_ROWS}`,
  )
    .bind(...binds)
    .all<UnavailabilityDTO>();
  // The reason is personal: admins and the technician it belongs to see it, other technicians only the period.
  const me = c.var.staff!;
  return c.json({ unavailability: results.map((u) => (me.role === "admin" || u.staffId === me.id ? u : { ...u, reason: null })) });
});

scheduleRoutes.post("/preview", async (c) => {
  const { change, resolutions } = await readJson(c, previewBodySchema);
  await authorize(c.env, c.var.staff!, change);
  return c.json(await previewChange(c.env, change, resolutions));
});

scheduleRoutes.post("/apply", async (c) => {
  const { change, version, resolutions } = await readJson(c, applyBodySchema);
  await authorize(c.env, c.var.staff!, change);
  return c.json(await applyChange(c.env, c.var.staff!, change, version, resolutions));
});
