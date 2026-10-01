import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../helpers";
import { lastMailTo, loginCustomer, loginStaff, seedCustomer, seedTeam, seedWeekly, TZ, withBatchHook } from "../fixtures";
import { clock, setNow } from "../../src/worker/lib/clock";
import { processOutbox } from "../../src/worker/mail/outbox";
import { sha256Hex } from "../../src/worker/lib/crypto";
import { getSettings } from "../../src/worker/repos/settings";
import { submitReservation, type SubmitInput } from "../../src/worker/reservations/submit";
import { wallToUtc } from "../../src/domain/time";

afterEach(() => {
  vi.restoreAllMocks();
  setNow(null);
});

const THU = "2026-10-01";
const FRI = "2026-10-02";
const at = (date: string, h: number, m = 0) => wallToUtc(date, h * 60 + m, TZ);

let team: Awaited<ReturnType<typeof seedTeam>>;
let customerId: number;
let customerCookie: string;
let adminCookie: string;
let techCookie: string;

beforeEach(async () => {
  setNow(at(THU, 8));
  team = await seedTeam();
  await seedWeekly(5, 600, 660, [team.a, team.b]);
  customerId = await seedCustomer({ email: "pat@example.test" });
  customerCookie = await loginCustomer("pat@example.test");
  adminCookie = await loginStaff("admin@example.test");
  techCookie = await loginStaff("tech-a@example.test");
});

const setBooking = (enabled: boolean, cookie = adminCookie) => api("POST", "/api/staff/settings/booking", { cookie, body: { enabled } });
const requestLink = (email: string, path = "/api/auth/customer/request") => api("POST", path, { body: { email } });
const count = async (sql: string) => (await env.DB.prepare(sql).first<{ n: number }>())!.n;
const body = (startAt: number) => ({
  customerId,
  startAt,
  contactName: "Pat Example",
  phone: "+81 3-1234-5678",
  issue: "Printer is offline",
  idempotencyKey: crypto.randomUUID(),
});
const submit = (startAt = at(FRI, 10), cookie = customerCookie) => api("POST", "/api/customer/reservations", { cookie, body: body(startAt) });
const availability = () => api("GET", `/api/customer/availability?from=${FRI}&to=${FRI}`, { cookie: customerCookie });

describe("default", () => {
  it("is enabled when no row exists", async () => {
    expect((await getSettings(env.DB, env)).bookingEnabled).toBe(true);
    const me = await api("GET", "/api/auth/me");
    expect(me.json.bookingEnabled).toBe(true);
    expect((await availability()).status).toBe(200);
    expect((await submit()).status).toBe(201);
  });

  it("falls back to enabled when the stored value is not a boolean", async () => {
    for (const value of ['"false"', "0", "null", "not json"]) {
      await env.DB.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('bookingEnabled', ?)").bind(value).run();
      expect((await getSettings(env.DB, env)).bookingEnabled).toBe(true);
    }
    await env.DB.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('bookingEnabled', 'false')").run();
    expect((await getSettings(env.DB, env)).bookingEnabled).toBe(false);
  });
});

describe("POST /api/staff/settings/booking", () => {
  it("lets an admin pause and resume booking, with an audit row each time", async () => {
    const off = await setBooking(false);
    expect(off.status).toBe(200);
    expect(off.json).toEqual({ bookingEnabled: false });
    expect((await getSettings(env.DB, env)).bookingEnabled).toBe(false);
    expect((await env.DB.prepare("SELECT value FROM settings WHERE key = 'bookingEnabled'").first<{ value: string }>())!.value).toBe("false");

    const on = await setBooking(true);
    expect(on.json).toEqual({ bookingEnabled: true });
    expect((await getSettings(env.DB, env)).bookingEnabled).toBe(true);

    const rows = await env.DB.prepare("SELECT actor_kind, actor, details FROM audit_log WHERE action = 'settings.booking' ORDER BY id").all<any>();
    expect(rows.results.map((r) => [r.actor_kind, r.actor, JSON.parse(r.details)])).toEqual([
      ["staff", String(team.admin), { enabled: false }],
      ["staff", String(team.admin), { enabled: true }],
    ]);
  });

  it("rejects a technician with 403 and changes nothing", async () => {
    expect((await setBooking(false, techCookie)).status).toBe(403);
    expect(await count("SELECT COUNT(*) AS n FROM settings WHERE key = 'bookingEnabled'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'settings.booking'")).toBe(0);
  });

  it("answers 401 without a staff session, including with only a customer cookie", async () => {
    expect((await setBooking(false, "")).status).toBe(401);
    expect((await setBooking(false, customerCookie)).status).toBe(401);
    expect(await count("SELECT COUNT(*) AS n FROM settings WHERE key = 'bookingEnabled'")).toBe(0);
  });

  it("validates the body", async () => {
    for (const b of [{}, { enabled: "false" }, { enabled: 0 }]) {
      expect((await api("POST", "/api/staff/settings/booking", { cookie: adminCookie, body: b })).status).toBe(400);
    }
  });
});

describe("while booking is paused", () => {
  it("sends no customer link and charges no rate-limit bucket, whatever the address or Turnstile state", async () => {
    await processOutbox(env, 50);
    const mailbox = await count("SELECT COUNT(*) AS n FROM dev_mailbox WHERE to_email = 'pat@example.test'");
    await env.DB.prepare("DELETE FROM rate_limits").run(); // the sign-ins in beforeEach charged some
    await setBooking(false);
    const jobs = await count("SELECT COUNT(*) AS n FROM email_jobs");
    env.TURNSTILE_SECRET_KEY = "secret";
    try {
      for (let i = 0; i < 6; i++) {
        const res = await api("POST", "/api/auth/customer/request", {
          body: { email: "pat@example.test", turnstileToken: "whatever" },
          headers: { "cf-connecting-ip": "203.0.113.9" },
        });
        expect(res.status).toBe(200);
        expect(res.json).toEqual({ ok: true });
      }
    } finally {
      delete env.TURNSTILE_SECRET_KEY;
    }
    expect((await requestLink("nobody@example.test")).json).toEqual({ ok: true });
    expect(await count("SELECT COUNT(*) AS n FROM email_jobs")).toBe(jobs);
    expect(await count("SELECT COUNT(*) AS n FROM rate_limits")).toBe(0);
    await processOutbox(env, 50);
    expect(await count("SELECT COUNT(*) AS n FROM dev_mailbox WHERE to_email = 'pat@example.test'")).toBe(mailbox);
  });

  it("resend is silent for a customer token (no mail, no buckets) but still works for a staff token", async () => {
    await requestLink("pat@example.test");
    const token = (await lastMailTo("pat@example.test"))!;
    await env.DB.prepare("DELETE FROM rate_limits").run();

    await setBooking(false);
    const jobs = await count("SELECT COUNT(*) AS n FROM email_jobs");
    const res = await api("POST", "/api/auth/resend", { body: { token } });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
    expect(await count("SELECT COUNT(*) AS n FROM email_jobs")).toBe(jobs);
    expect(await count("SELECT COUNT(*) AS n FROM rate_limits")).toBe(0);

    await api("POST", "/api/auth/staff/request", { body: { email: "admin@example.test" } });
    const staffToken = (await lastMailTo("admin@example.test"))!;
    expect(staffToken).toBeTruthy();
    const staffJobs = await count("SELECT COUNT(*) AS n FROM email_jobs");
    await api("POST", "/api/auth/resend", { body: { token: staffToken } });
    expect(await count("SELECT COUNT(*) AS n FROM email_jobs")).toBe(staffJobs + 1);
  });

  it("answers 409 booking_disabled for availability and submit, and creates nothing", async () => {
    await setBooking(false);
    const a = await availability();
    expect(a.status).toBe(409);
    expect(a.json.error).toBe("booking_disabled");
    const s = await submit();
    expect(s.status).toBe(409);
    expect(s.json.error).toBe("booking_disabled");
    expect(await count("SELECT COUNT(*) AS n FROM reservations")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM tech_blocks")).toBe(0);
    // checked before the submit rate limit
    expect(await count("SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE 'submit:%'")).toBe(0);
  });

  it("resumes normally once switched back on", async () => {
    await setBooking(false);
    await setBooking(true);
    expect((await availability()).status).toBe(200);
    expect((await submit()).status).toBe(201);
  });

  it("respects a pause that lands between the check and the commit", async () => {
    const w = withBatchHook(async () => {
      await env.DB.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('bookingEnabled', 'false')").run();
    });
    await expect(submitReservation(w.env, "pat@example.test", body(at(FRI, 10)) as SubmitInput)).rejects.toMatchObject({
      status: 409,
      code: "booking_disabled",
    });
    expect(w.calls.batches).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM reservations")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM tech_blocks")).toBe(0);
  });

  it("keeps staff sign-in, existing reservations, /r access links and the customer's own list working", async () => {
    const created = await submit();
    expect(created.status).toBe(201);
    const id = created.json.reservation.id as string;
    const token = `tok-${crypto.randomUUID()}-${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO access_tokens(token_hash, reservation_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(token), id, clock.now(), at(FRI, 12))
      .run();

    await setBooking(false);

    expect((await loginStaff("tech-a@example.test")).length).toBeGreaterThan(0);
    const viaLink = await api("POST", "/api/access/reservation", { body: { token } });
    expect(viaLink.status).toBe(200);
    expect(viaLink.json.reservation.id).toBe(id);
    expect((await api("GET", "/api/customer/reservations", { cookie: customerCookie })).json.reservations).toHaveLength(1);
    expect((await api("GET", "/api/customer/accounts", { cookie: customerCookie })).status).toBe(200);
    const staffList = await api("GET", "/api/staff/reservations", { cookie: techCookie });
    expect(staffList.status).toBe(200);
    expect(staffList.json.reservations).toHaveLength(1);
  });
});

describe("GET /api/auth/me", () => {
  it("exposes bookingEnabled and supportPhone to anonymous visitors", async () => {
    await env.DB.prepare("INSERT INTO settings(key, value) VALUES ('supportPhone', ?)").bind(JSON.stringify("+81 3-0000-0000")).run();
    let me = await api("GET", "/api/auth/me");
    expect(me.json).toMatchObject({ bookingEnabled: true, supportPhone: "+81 3-0000-0000" });
    await setBooking(false);
    me = await api("GET", "/api/auth/me");
    expect(me.json).toMatchObject({ bookingEnabled: false, supportPhone: "+81 3-0000-0000" });
  });

  it("defaults supportPhone to an empty string", async () => {
    expect((await api("GET", "/api/auth/me")).json.supportPhone).toBe("");
  });
});
