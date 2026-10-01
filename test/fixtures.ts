import { env } from "cloudflare:test";
import { api, cookieFrom } from "./helpers";
import { processOutbox } from "../src/worker/mail/outbox";

export const TZ = "Asia/Tokyo";

export async function seedStaff(email: string, role: "admin" | "technician" = "technician", active = true): Promise<number> {
  const row = await env.DB.prepare("INSERT INTO staff(email, name, role, active, created_at, updated_at) VALUES (?, 'Test Person', ?, ?, 0, 0) RETURNING id")
    .bind(email, role, active ? 1 : 0)
    .first<{ id: number }>();
  return row!.id;
}

/** Four bookable technicians plus an admin (also bookable). */
export async function seedTeam(): Promise<{ admin: number; a: number; b: number; c: number; d: number }> {
  return {
    admin: await seedStaff("admin@example.test", "admin"),
    a: await seedStaff("tech-a@example.test"),
    b: await seedStaff("tech-b@example.test"),
    c: await seedStaff("tech-c@example.test"),
    d: await seedStaff("tech-d@example.test"),
  };
}

/** A weekly availability window (weekday 0 = Sunday; minutes since local midnight) staffed by `staffIds`. */
export async function seedWeekly(weekday: number, startMin: number, endMin: number, staffIds: number[]): Promise<number> {
  const row = await env.DB.prepare("INSERT INTO availability_windows(kind, weekday, start_min, end_min) VALUES ('weekly', ?, ?, ?) RETURNING id")
    .bind(weekday, startMin, endMin)
    .first<{ id: number }>();
  for (const staffId of staffIds) {
    await env.DB.prepare("INSERT INTO availability_window_staff(window_id, staff_id) VALUES (?, ?)").bind(row!.id, staffId).run();
  }
  return row!.id;
}

/** A customer account with one contact (default pat@example.test). Returns the customer id. */
export async function seedCustomer(o: { number?: string; name?: string; email?: string; active?: boolean; contactActive?: boolean } = {}): Promise<number> {
  const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM customers").first<{ n: number }>())!.n + 1;
  const row = await env.DB.prepare("INSERT INTO customers(customer_number, name, active, created_at, updated_at) VALUES (?, ?, ?, 0, 0) RETURNING id")
    .bind(o.number ?? `C-${n}`, o.name ?? "Acme Test Co", o.active === false ? 0 : 1)
    .first<{ id: number }>();
  await env.DB.prepare("INSERT INTO customer_contacts(customer_id, email, active) VALUES (?, ?, ?)")
    .bind(row!.id, o.email ?? "pat@example.test", o.contactActive === false ? 0 : 1)
    .run();
  return row!.id;
}

/** Deliver queued mail, then return the token from the newest message to `email` (null when none). */
export async function lastMailTo(email: string): Promise<string | null> {
  await processOutbox(env, 50);
  const row = await env.DB.prepare("SELECT text FROM dev_mailbox WHERE to_email = ? ORDER BY id DESC LIMIT 1").bind(email).first<{ text: string }>();
  return row ? (/#t=([A-Za-z0-9_-]+)/.exec(row.text)?.[1] ?? null) : null;
}

async function login(kind: "customer" | "staff", email: string): Promise<string> {
  await api("POST", `/api/auth/${kind}/request`, { body: { email } });
  const token = await lastMailTo(email);
  if (!token) throw new Error(`no ${kind} login mail for ${email}`);
  const res = await api("POST", "/api/auth/redeem", { body: { token } });
  if (res.status !== 200) throw new Error(`redeem failed: ${res.status}`);
  return cookieFrom(res.setCookie);
}

/** Request a magic link, deliver it, redeem it; returns the session cookie. The contact must already exist. */
export const loginCustomer = (email: string): Promise<string> => login("customer", email);
export const loginStaff = (email: string): Promise<string> => login("staff", email);

/**
 * Wraps env.DB so `hook` runs once, right before the first db.batch() commits: after the code under test has
 * loaded its schedule snapshot and decided what to write, exactly where a concurrent request would land.
 */
export function withBatchHook(hook: () => Promise<void>): { env: typeof env; calls: { batches: number } } {
  const real = env.DB;
  const calls = { batches: 0 };
  let fired = false;
  const db = {
    prepare: (q: string) => real.prepare(q),
    batch: async (stmts: D1PreparedStatement[]) => {
      calls.batches++;
      if (!fired) {
        fired = true;
        await hook();
      }
      return real.batch(stmts);
    },
  } as unknown as D1Database;
  return { env: { ...env, DB: db } as typeof env, calls };
}
