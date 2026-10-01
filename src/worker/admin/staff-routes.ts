import { Hono } from "hono";
import { z } from "zod";
import { staffApplyBodySchema, staffCreateSchema, staffPatchSchema, staffPreviewBodySchema } from "../../shared/schemas";
import type { AppEnv } from "../env";
import { clock } from "../lib/clock";
import { assertSql, audit } from "../lib/db";
import { HttpError, readJson } from "../lib/http";
import { requireStaff } from "../middleware/session";
import { getStaff, listStaff, OTHER_ACTIVE_ADMIN_SQL } from "../repos/staff";
import { applyChange, previewChange } from "../scheduling/roster";

/** Staff management: any staff member may list the team; admins add people and change them. */
export const staffRoutes = new Hono<AppEnv>();

const idParam = z.coerce.number().int().positive();
const parseId = (raw: string) => {
  const id = idParam.safeParse(raw);
  if (!id.success) throw new HttpError(404, "not_found");
  return id.data;
};

staffRoutes.get("/team", requireStaff(), async (c) => c.json({ staff: await listStaff(c.env.DB) }));

staffRoutes.post("/team", requireStaff("admin"), async (c) => {
  const body = await readJson(c, staffCreateSchema);
  const db = c.env.DB;
  const now = clock.now();
  try {
    await db.batch([
      db
        .prepare("INSERT INTO staff(email, name, role, bookable, notify, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)")
        .bind(body.email, body.name, body.role, body.bookable ? 1 : 0, body.notify ? 1 : 0, now, now),
      audit(db, { actorKind: "staff", actor: String(c.var.staff!.id), action: "staff.create", details: body }),
    ]);
  } catch (e) {
    if (String(e instanceof Error ? e.message : e).includes("UNIQUE constraint failed: staff.email")) throw new HttpError(409, "email_taken");
    throw e;
  }
  const row = await db.prepare("SELECT id FROM staff WHERE email = ?").bind(body.email).first<{ id: number }>();
  return c.json({ staff: await getStaff(db, row!.id) }, 201);
});

/** Admins may not remove their own admin access this way: someone else has to do it. */
function assertNotSelf(actorId: number, targetId: number): void {
  if (actorId === targetId) throw new HttpError(409, "self");
}

staffRoutes.patch("/team/:id", requireStaff("admin"), async (c) => {
  const id = parseId(c.req.param("id"));
  const patch = await readJson(c, staffPatchSchema);
  const db = c.env.DB;
  const current = await getStaff(db, id);
  if (!current) throw new HttpError(404, "not_found");

  const changed = (["name", "role", "notify"] as const).filter((k) => patch[k] !== undefined && patch[k] !== current[k]);
  if (changed.length === 0) return c.json({ staff: current });

  // Only an ACTIVE admin counts towards the rule; demoting an inactive one leaves the active admins as they are.
  const demotes = current.role === "admin" && current.active && patch.role === "technician";
  if (demotes) assertNotSelf(c.var.staff!.id, id);

  const sets = changed.map((k) => `${k} = ?`);
  const values = changed.map((k) => (k === "notify" ? (patch.notify ? 1 : 0) : patch[k]));
  try {
    await db.batch([
      ...(demotes ? [assertSql(db, OTHER_ACTIVE_ADMIN_SQL, id)] : []),
      db.prepare(`UPDATE staff SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).bind(...values, clock.now(), id),
      audit(db, {
        actorKind: "staff",
        actor: String(c.var.staff!.id),
        action: "staff.update",
        details: { id, ...Object.fromEntries(changed.map((k) => [k, patch[k]])) },
      }),
    ]);
  } catch (e) {
    // The batch's only guard is the last-admin one: another admin vanished between our read and the commit.
    if (String(e instanceof Error ? e.message : e).includes("guard.ok")) throw new HttpError(409, "last_admin");
    throw e;
  }
  return c.json({ staff: await getStaff(db, id) });
});

staffRoutes.post("/team/:id/preview", requireStaff("admin"), async (c) => {
  const id = parseId(c.req.param("id"));
  const body = await readJson(c, staffPreviewBodySchema);
  if (body.active === false) assertNotSelf(c.var.staff!.id, id);
  return c.json(await previewChange(c.env, { type: "staff.update", id, active: body.active, bookable: body.bookable }, body.resolutions));
});

staffRoutes.post("/team/:id/apply", requireStaff("admin"), async (c) => {
  const id = parseId(c.req.param("id"));
  const { version, ...body } = await readJson(c, staffApplyBodySchema);
  if (body.active === false) assertNotSelf(c.var.staff!.id, id);
  return c.json(await applyChange(c.env, c.var.staff!, { type: "staff.update", id, active: body.active, bookable: body.bookable }, version, body.resolutions));
});
