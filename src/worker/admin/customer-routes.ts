import { Hono } from "hono";
import { z } from "zod";
import {
  contactPatchSchema,
  contactInputSchema,
  customerActiveSchema,
  customerCreateSchema,
  customerListQuerySchema,
  customerPatchSchema,
} from "../../shared/schemas";
import type { AppEnv } from "../env";
import { clock } from "../lib/clock";
import { assertSql, audit } from "../lib/db";
import { HttpError, readJson } from "../lib/http";
import { requireStaff } from "../middleware/session";
import { getContact, getCustomer, getCustomerDetail, listCustomers } from "../repos/customers";

/** Customer administration: any staff member may look customers up; admins create and change them. */
export const customerAdminRoutes = new Hono<AppEnv>();

const idParam = z.coerce.number().int().positive();
const parseId = (raw: string) => {
  const id = idParam.safeParse(raw);
  if (!id.success) throw new HttpError(404, "not_found");
  return id.data;
};

const errorText = (e: unknown) => String(e instanceof Error ? e.message : e);
const emptyToNull = (v: string | null | undefined) => (v === undefined ? undefined : v === null || v === "" ? null : v);

const actor = (c: { var: AppEnv["Variables"] }) => String(c.var.staff!.id);

customerAdminRoutes.get("/customers", requireStaff(), async (c) => {
  const q = customerListQuerySchema.parse(c.req.query());
  return c.json(await listCustomers(c.env.DB, q));
});

customerAdminRoutes.get("/customers/:id", requireStaff(), async (c) => {
  const detail = await getCustomerDetail(c.env.DB, parseId(c.req.param("id")));
  if (!detail) throw new HttpError(404, "not_found");
  return c.json(detail);
});

customerAdminRoutes.post("/customers", requireStaff("admin"), async (c) => {
  const body = await readJson(c, customerCreateSchema);
  const db = c.env.DB;
  const now = clock.now();
  try {
    await db.batch([
      db
        .prepare("INSERT INTO customers(customer_number, name, phone, notes, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
        .bind(body.customerNumber, body.name, emptyToNull(body.phone) ?? null, emptyToNull(body.notes) ?? null, now, now),
      ...body.contacts.map((k) =>
        db
          .prepare("INSERT INTO customer_contacts(customer_id, email, name, phone, active) SELECT id, ?, ?, ?, 1 FROM customers WHERE customer_number = ?")
          .bind(k.email, emptyToNull(k.name) ?? null, emptyToNull(k.phone) ?? null, body.customerNumber),
      ),
      // The new id is not known yet: the audit row finds the customer by its (unique) number. Notes are never audited.
      db
        .prepare("INSERT INTO audit_log(at, actor_kind, actor, action, customer_id, details) SELECT ?, 'staff', ?, 'customer.create', id, ? FROM customers WHERE customer_number = ?")
        .bind(
          now,
          actor(c),
          JSON.stringify({ customerNumber: body.customerNumber, name: body.name, phone: emptyToNull(body.phone) ?? null, contacts: body.contacts.map((k) => k.email) }),
          body.customerNumber,
        ),
    ]);
  } catch (e) {
    if (errorText(e).includes("UNIQUE constraint failed: customers.customer_number")) throw new HttpError(409, "number_taken");
    throw e;
  }
  const row = await db.prepare("SELECT id FROM customers WHERE customer_number = ?").bind(body.customerNumber).first<{ id: number }>();
  return c.json(await getCustomerDetail(db, row!.id), 201);
});

customerAdminRoutes.patch("/customers/:id", requireStaff("admin"), async (c) => {
  const id = parseId(c.req.param("id"));
  const patch = await readJson(c, customerPatchSchema);
  const db = c.env.DB;
  const current = await getCustomer(db, id);
  if (!current) throw new HttpError(404, "not_found");

  const next = {
    customerNumber: patch.customerNumber,
    name: patch.name,
    phone: emptyToNull(patch.phone),
    notes: emptyToNull(patch.notes),
  };
  const changed = (["customerNumber", "name", "phone", "notes"] as const).filter((k) => next[k] !== undefined && next[k] !== current[k]);
  if (changed.length === 0) return c.json(await getCustomerDetail(db, id));

  const renumbers = changed.includes("customerNumber");
  const noReservations = "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM reservations WHERE customer_id = ?)";
  if (renumbers && (await db.prepare("SELECT 1 FROM reservations WHERE customer_id = ? LIMIT 1").bind(id).first())) {
    throw new HttpError(409, "number_locked");
  }

  const columns = { customerNumber: "customer_number", name: "name", phone: "phone", notes: "notes" } as const;
  try {
    await db.batch([
      // A reservation created after the check above must not slip under a renumbering.
      ...(renumbers ? [assertSql(db, noReservations, id)] : []),
      db
        .prepare(`UPDATE customers SET ${changed.map((k) => `${columns[k]} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
        .bind(...changed.map((k) => next[k]), clock.now(), id),
      audit(db, {
        actorKind: "staff",
        actor: actor(c),
        action: "customer.update",
        customerId: id,
        // Which fields changed, with the new values of all but the free-text notes.
        details: { fields: changed, ...Object.fromEntries(changed.filter((k) => k !== "notes").map((k) => [k, next[k]])) },
      }),
    ]);
  } catch (e) {
    const m = errorText(e);
    if (m.includes("UNIQUE constraint failed: customers.customer_number")) throw new HttpError(409, "number_taken");
    if (m.includes("guard.ok")) throw new HttpError(409, "number_locked");
    throw e;
  }
  return c.json(await getCustomerDetail(db, id));
});

/** Deactivating blocks new sign-ins and bookings only; existing reservations stay and can still be cancelled. Not a capacity change. */
customerAdminRoutes.post("/customers/:id/active", requireStaff("admin"), async (c) => {
  const id = parseId(c.req.param("id"));
  const { active } = await readJson(c, customerActiveSchema);
  const db = c.env.DB;
  const current = await getCustomer(db, id);
  if (!current) throw new HttpError(404, "not_found");
  if (current.active !== active) {
    await db.batch([
      db.prepare("UPDATE customers SET active = ?, updated_at = ? WHERE id = ?").bind(active ? 1 : 0, clock.now(), id),
      audit(db, { actorKind: "staff", actor: actor(c), action: active ? "customer.activate" : "customer.deactivate", customerId: id, details: { customerNumber: current.customerNumber } }),
    ]);
  }
  return c.json(await getCustomerDetail(db, id));
});

// ---- Contacts ---------------------------------------------------------------------------------------------------

customerAdminRoutes.post("/customers/:id/contacts", requireStaff("admin"), async (c) => {
  const id = parseId(c.req.param("id"));
  const body = await readJson(c, contactInputSchema);
  const db = c.env.DB;
  if (!(await getCustomer(db, id))) throw new HttpError(404, "not_found");
  try {
    await db.batch([
      db.prepare("INSERT INTO customer_contacts(customer_id, email, name, phone, active) VALUES (?, ?, ?, ?, 1)").bind(id, body.email, emptyToNull(body.name) ?? null, emptyToNull(body.phone) ?? null),
      audit(db, { actorKind: "staff", actor: actor(c), action: "customer.contact.add", customerId: id, details: { email: body.email } }),
    ]);
  } catch (e) {
    if (errorText(e).includes("UNIQUE constraint failed: customer_contacts.customer_id")) throw new HttpError(409, "contact_exists");
    throw e;
  }
  const row = await db.prepare("SELECT id FROM customer_contacts WHERE customer_id = ? AND email = ?").bind(id, body.email).first<{ id: number }>();
  return c.json({ contact: await getContact(db, id, row!.id) }, 201);
});

customerAdminRoutes.patch("/customers/:id/contacts/:contactId", requireStaff("admin"), async (c) => {
  const id = parseId(c.req.param("id"));
  const contactId = parseId(c.req.param("contactId"));
  const patch = await readJson(c, contactPatchSchema);
  const db = c.env.DB;
  const current = await getContact(db, id, contactId);
  if (!current) throw new HttpError(404, "not_found");

  const next = { name: emptyToNull(patch.name), phone: emptyToNull(patch.phone), active: patch.active };
  const changed = (["name", "phone", "active"] as const).filter((k) => next[k] !== undefined && next[k] !== current[k]);
  if (changed.length > 0) {
    await db.batch([
      db
        .prepare(`UPDATE customer_contacts SET ${changed.map((k) => `${k} = ?`).join(", ")} WHERE id = ? AND customer_id = ?`)
        .bind(...changed.map((k) => (k === "active" ? (next.active ? 1 : 0) : next[k])), contactId, id),
      audit(db, {
        actorKind: "staff",
        actor: actor(c),
        action: "customer.contact.update",
        customerId: id,
        details: { contactId, email: current.email, ...Object.fromEntries(changed.map((k) => [k, next[k]])) },
      }),
    ]);
  }
  return c.json({ contact: await getContact(db, id, contactId) });
});

/** Only a contact whose email never booked for this customer; otherwise 409 has_history and the contact is deactivated instead. */
customerAdminRoutes.delete("/customers/:id/contacts/:contactId", requireStaff("admin"), async (c) => {
  const id = parseId(c.req.param("id"));
  const contactId = parseId(c.req.param("contactId"));
  const db = c.env.DB;
  const current = await getContact(db, id, contactId);
  if (!current) throw new HttpError(404, "not_found");
  if (current.hasHistory) throw new HttpError(409, "has_history");
  try {
    await db.batch([
      // Re-checked in the batch: the contact may have booked, or been deleted, since the read above.
      assertSql(
        db,
        `SELECT 1 FROM customer_contacts cc WHERE cc.id = ? AND cc.customer_id = ?
           AND NOT EXISTS (SELECT 1 FROM reservations r WHERE r.customer_id = cc.customer_id AND r.contact_email = cc.email)`,
        contactId,
        id,
      ),
      db.prepare("DELETE FROM customer_contacts WHERE id = ? AND customer_id = ?").bind(contactId, id),
      audit(db, { actorKind: "staff", actor: actor(c), action: "customer.contact.remove", customerId: id, details: { contactId, email: current.email } }),
    ]);
  } catch (e) {
    if (!errorText(e).includes("guard.ok")) throw e;
    throw (await getContact(db, id, contactId)) ? new HttpError(409, "has_history") : new HttpError(404, "not_found");
  }
  return c.json({ ok: true });
});
