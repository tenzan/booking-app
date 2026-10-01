import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../helpers";
import { loginCustomer, loginStaff, seedCustomer, seedTeam, seedWeekly, TZ } from "../fixtures";
import { clock, setNow } from "../../src/worker/lib/clock";
import { sha256Hex } from "../../src/worker/lib/crypto";
import { wallToUtc } from "../../src/domain/time";

afterEach(() => setNow(null));

const THU = "2026-10-01";
const FRI = "2026-10-02";
const at = (date: string, h: number, m = 0) => wallToUtc(date, h * 60 + m, TZ);
const TZ_LABEL = "Asia/Tokyo (GMT+9)";

let team: Awaited<ReturnType<typeof seedTeam>>;
let pat: { id: number; cookie: string };
let sam: { id: number; cookie: string };
let adminCookie: string;

beforeEach(async () => {
  setNow(at(THU, 8));
  team = await seedTeam();
  for (const [id, name] of [
    [team.admin, "Ada Admin"],
    [team.a, "Tim Tech"],
    [team.b, "Una Tech"],
  ] as const) {
    await env.DB.prepare("UPDATE staff SET name = ? WHERE id = ?").bind(name, id).run();
  }
  pat = { id: await seedCustomer({ email: "pat@example.test", name: "Pat Co" }), cookie: "" };
  sam = { id: await seedCustomer({ email: "sam@example.test", name: "Sam Co" }), cookie: "" };
  pat.cookie = await loginCustomer("pat@example.test");
  sam.cookie = await loginCustomer("sam@example.test");
  adminCookie = await loginStaff("admin@example.test");
  await seedWeekly(5, 600, 720, [team.admin, team.a, team.b]);
  await env.DB.prepare("INSERT INTO settings(key, value) VALUES ('supportPhone', '\"+81 3-0000-0000\"')").run();
});

const submit = async (who: { id: number; cookie: string }, startAt: number) => {
  const res = await api("POST", "/api/customer/reservations", {
    cookie: who.cookie,
    body: { customerId: who.id, startAt, contactName: "Pat Example", phone: "+81 3-1234-5678", issue: "Printer is offline", idempotencyKey: crypto.randomUUID() },
  });
  expect(res.status).toBe(201);
  return res.json.reservation.id as string;
};
const confirmedWith = async (who: { id: number; cookie: string }, startAt: number, staffId: number) => {
  const id = await submit(who, startAt);
  const res = await api("POST", `/api/staff/reservations/${id}/approve`, { cookie: adminCookie, body: { staffId, version: 1 } });
  expect(res.status).toBe(200);
  return id;
};
const cancel = (who: { cookie: string }, id: string, body: Record<string, unknown>) =>
  api("POST", `/api/customer/reservations/${id}/cancel`, { cookie: who.cookie, body });
const mintToken = async (reservationId: string, expiresAt = at(FRI, 11) + 14 * 86_400_000) => {
  const token = `tok-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  await env.DB.prepare("INSERT INTO access_tokens(token_hash, reservation_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(token), reservationId, clock.now(), expiresAt)
    .run();
  return token;
};
const viaToken = (body: Record<string, unknown>, headers: Record<string, string> = {}) => api("POST", "/api/access/reservation/cancel", { body, headers });
const count = async (sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;
const row = (id: string) => env.DB.prepare("SELECT * FROM reservations WHERE id = ?").bind(id).first<any>();
const allBlocks = () => count("SELECT COUNT(*) AS n FROM tech_blocks");
const jobStatus = (dedupeKey: string) => env.DB.prepare("SELECT status FROM email_jobs WHERE dedupe_key = ?").bind(dedupeKey).first<string>("status");
const mailsTo = async (email: string, subjectLike = "%") =>
  (
    await env.DB.prepare("SELECT subject, text, html FROM dev_mailbox WHERE to_email = ? AND subject LIKE ? ORDER BY id")
      .bind(email, subjectLike)
      .all<{ subject: string; text: string; html: string }>()
  ).results;

const CUSTOMER_KEYS = ["accountName", "closeReason", "contactName", "createdAt", "customerNumber", "endAt", "id", "issue", "phone", "proposal", "ref", "startAt", "status", "version"];

describe("POST /api/customer/reservations/:id/cancel", () => {
  it("cancels a pending request: customer DTO without staff data, blocks freed, team and customer mailed", async () => {
    const id = await submit(pat, at(FRI, 10));
    const res = await cancel(pat, id, { reason: "  No longer needed ", version: 1 });
    expect(res.status).toBe(200);
    expect(Object.keys(res.json.reservation).sort()).toEqual(CUSTOMER_KEYS);
    expect(res.json.reservation).toMatchObject({ id, status: "cancelled", version: 2, closeReason: "No longer needed", accountName: "Pat Co" });
    expect(JSON.stringify(res.json)).not.toMatch(/staff|Tim Tech|Una Tech|Ada Admin|pat@example\.test/i);
    expect(await row(id)).toMatchObject({ status: "cancelled", closed_by_kind: "customer", closed_by: "pat@example.test", close_reason: "No longer needed" });
    expect(await allBlocks()).toBe(0);
    const a = await env.DB.prepare("SELECT * FROM audit_log WHERE action = 'reservation.cancelled'").first<any>();
    expect(a).toMatchObject({ actor_kind: "customer", actor: "pat@example.test", reservation_id: id, customer_id: pat.id });

    // The route delivers the mail after committing (no manual processOutbox).
    expect(await jobStatus(`cancelled:${id}`)).toBe("sent");
    const [c] = await mailsTo("pat@example.test", "Cancelled%");
    expect(c!.text).toContain("You cancelled this appointment.");
    expect(c!.text).toContain(TZ_LABEL);
    expect(c!.text).not.toContain("our team");
    for (const name of ["Tim Tech", "Una Tech", "Ada Admin"]) expect(c!.text).not.toContain(name);
    const [tm] = await mailsTo("admin@example.test", "%cancelled%");
    expect(tm!.text).toContain("The customer (pat@example.test) cancelled this reservation.");
    expect(tm!.text).toContain("Reason: No longer needed");
  });

  it("cancels a confirmed appointment before the cutoff, and its technician is told even with notify off", async () => {
    const id = await confirmedWith(pat, at(FRI, 10), team.a);
    await env.DB.prepare("UPDATE staff SET notify = 0 WHERE id IN (?, ?)").bind(team.a, team.b).run();
    setNow(at(FRI, 8, 59));
    pat.cookie = await loginCustomer("pat@example.test");
    const res = await cancel(pat, id, { version: 2 });
    expect(res.status).toBe(200);
    expect(res.json.reservation).toMatchObject({ status: "cancelled", version: 3, closeReason: null });
    expect(await allBlocks()).toBe(0);
    // The assigned technician (notify off) and the notify staff, not the other technician (notify off, not involved).
    expect(await jobStatus(`cancelled-team:${id}:${team.a}`)).toBe("sent");
    expect(await jobStatus(`cancelled-team:${id}:${team.admin}`)).toBe("sent");
    expect(await jobStatus(`cancelled-team:${id}:${team.b}`)).toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM email_jobs WHERE template = 'cancelled' AND to_email = 'tech-a@example.test'")).toBe(1);
    const [tm] = await mailsTo("tech-a@example.test", "%cancelled%");
    expect(tm!.text).toContain("The customer (pat@example.test) cancelled this reservation.");
    expect(tm!.text).toContain("Tim Tech");
  });

  it("does not duplicate the technician's mail when they are also a notify recipient", async () => {
    const id = await confirmedWith(pat, at(FRI, 10), team.a);
    expect((await cancel(pat, id, { version: 2 })).status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM email_jobs WHERE template = 'cancelled' AND to_email = 'tech-a@example.test'")).toBe(1);
  });

  it("refuses a confirmed appointment inside the cutoff with past_cutoff details; a pending request is still cancellable", async () => {
    const id = await confirmedWith(pat, at(FRI, 10), team.a);
    const pending = await submit(sam, at(FRI, 11));
    setNow(at(FRI, 9)); // exactly 60 minutes before
    pat.cookie = await loginCustomer("pat@example.test");
    sam.cookie = await loginCustomer("sam@example.test");
    const res = await cancel(pat, id, { version: 2 });
    expect([res.status, res.json.error]).toEqual([409, "past_cutoff"]);
    expect(res.json.details).toEqual({ cutoffMin: 60, supportPhone: "+81 3-0000-0000" });
    expect(await row(id)).toMatchObject({ status: "confirmed", version: 2 });
    expect(await allBlocks()).toBe(16);
    expect((await cancel(sam, pending, { version: 1 })).status).toBe(200);

    setNow(at(FRI, 10, 5));
    pat.cookie = await loginCustomer("pat@example.test");
    const started = await cancel(pat, id, { version: 2 });
    expect([started.status, started.json.error]).toEqual([409, "too_late"]);
  });

  it("answers other accounts, unknown ids and anonymous callers without revealing anything", async () => {
    const id = await submit(pat, at(FRI, 10));
    const other = await cancel(sam, id, { version: 1 });
    const missing = await cancel(sam, "nope", { version: 1 });
    expect([other.status, other.json]).toEqual([404, { error: "not_found" }]);
    expect(missing.json).toEqual(other.json);
    expect((await api("POST", `/api/customer/reservations/${id}/cancel`, { body: { version: 1 } })).status).toBe(401);
    expect((await api("POST", `/api/customer/reservations/${id}/cancel`, { cookie: adminCookie, body: { version: 1 } })).status).toBe(401);
    expect(await row(id)).toMatchObject({ status: "pending", version: 1 });
  });

  it("an inactive account can still cancel, a deactivated contact cannot", async () => {
    const id = await submit(pat, at(FRI, 10));
    await env.DB.prepare("UPDATE customers SET active = 0 WHERE id = ?").bind(pat.id).run();
    expect((await cancel(pat, id, { version: 1 })).status).toBe(200);

    const id2 = await submit(sam, at(FRI, 11));
    await env.DB.prepare("UPDATE customer_contacts SET active = 0 WHERE customer_id = ?").bind(sam.id).run();
    expect((await cancel(sam, id2, { version: 1 })).status).toBe(404);
  });

  it("stale versions return the current customer DTO", async () => {
    const id = await submit(pat, at(FRI, 10));
    await api("POST", `/api/staff/reservations/${id}/approve`, { cookie: adminCookie, body: { staffId: team.a, version: 1 } });
    const res = await cancel(pat, id, { version: 1 });
    expect([res.status, res.json.error]).toEqual([409, "stale"]);
    expect(Object.keys(res.json.details.current).sort()).toEqual(CUSTOMER_KEYS);
    expect(res.json.details.current).toMatchObject({ id, status: "confirmed", version: 2 });
    expect(JSON.stringify(res.json)).not.toMatch(/Tim Tech|staff/i);
  });

  it("is idempotent: an identical retry is 200, another version is 409 stale with the cancelled reservation", async () => {
    const id = await submit(pat, at(FRI, 10));
    expect((await cancel(pat, id, { reason: "Duplicate", version: 1 })).status).toBe(200);
    const jobsBefore = await count("SELECT COUNT(*) AS n FROM email_jobs");
    const retry = await cancel(pat, id, { reason: "Duplicate", version: 1 });
    expect(retry.status).toBe(200);
    expect(retry.json.reservation).toMatchObject({ status: "cancelled", version: 2, closeReason: "Duplicate" });
    const seen = await cancel(pat, id, { reason: "Other", version: 2 });
    expect([seen.status, seen.json.reservation.closeReason]).toEqual([200, "Duplicate"]);
    const different = await cancel(pat, id, { reason: "Other", version: 1 });
    expect([different.status, different.json.error, different.json.details.current.status]).toEqual([409, "stale", "cancelled"]);
    expect(Object.keys(different.json.details.current).sort()).toEqual(CUSTOMER_KEYS);
    expect(await count("SELECT COUNT(*) AS n FROM email_jobs")).toBe(jobsBefore);
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'reservation.cancelled'")).toBe(1);
  });

  it("validates the body", async () => {
    const id = await submit(pat, at(FRI, 10));
    for (const body of [{}, { version: "1" }, { version: 1, reason: "x".repeat(501) }, { version: 1, reason: 5 }]) {
      expect((await cancel(pat, id, body)).status, JSON.stringify(body).slice(0, 40)).toBe(400);
    }
    expect(await row(id)).toMatchObject({ status: "pending" });
  });
});

describe("POST /api/access/reservation/cancel", () => {
  it("cancels through the token as the reservation's contact", async () => {
    const id = await submit(pat, at(FRI, 10));
    const token = await mintToken(id);
    const res = await viaToken({ token, reason: "Changed plans", version: 1 });
    expect(res.status).toBe(200);
    expect(Object.keys(res.json.reservation).sort()).toEqual(CUSTOMER_KEYS);
    expect(res.json.reservation).toMatchObject({ id, status: "cancelled", closeReason: "Changed plans" });
    expect(await row(id)).toMatchObject({ closed_by_kind: "customer", closed_by: "pat@example.test" });
    expect(await allBlocks()).toBe(0);
    expect(await jobStatus(`cancelled:${id}`)).toBe("sent");
    const retry = await viaToken({ token, reason: "Changed plans", version: 1 });
    expect([retry.status, retry.json.reservation.status]).toEqual([200, "cancelled"]);
  });

  it("works for an inactive account and applies the cutoff, stale and not-found rules", async () => {
    const id = await confirmedWith(pat, at(FRI, 10), team.a);
    const token = await mintToken(id);
    await env.DB.prepare("UPDATE customers SET active = 0 WHERE id = ?").bind(pat.id).run();
    setNow(at(FRI, 9, 30));
    const cutoff = await viaToken({ token, version: 2 });
    expect([cutoff.status, cutoff.json.error, cutoff.json.details]).toEqual([409, "past_cutoff", { cutoffMin: 60, supportPhone: "+81 3-0000-0000" }]);
    setNow(at(FRI, 8));
    const stale = await viaToken({ token, version: 1 });
    expect([stale.status, stale.json.error, stale.json.details.current.version]).toEqual([409, "stale", 2]);
    expect(Object.keys(stale.json.details.current).sort()).toEqual(CUSTOMER_KEYS);
    expect((await viaToken({ token, version: 2 })).status).toBe(200);
  });

  it("only reaches the token's own reservation; bad, expired and malformed tokens look the same", async () => {
    const mine = await submit(pat, at(FRI, 10));
    const theirs = await submit(sam, at(FRI, 11));
    const token = await mintToken(mine);
    // Versions are per reservation; the token cannot be pointed at another one.
    const res = await viaToken({ token, reservationId: theirs, version: 1 });
    expect(res.status).toBe(200);
    expect(await row(mine)).toMatchObject({ status: "cancelled" });
    expect(await row(theirs)).toMatchObject({ status: "pending" });

    const expired = await mintToken(theirs, clock.now() - 1);
    const bad = await viaToken({ token: "x".repeat(40), version: 1 });
    const old = await viaToken({ token: expired, version: 1 });
    expect([bad.status, bad.json]).toEqual([404, { error: "invalid_link", details: undefined }]);
    expect([old.status, old.json]).toEqual([404, { error: "invalid_link", details: undefined }]);
    expect((await viaToken({ token: "short", version: 1 })).status).toBe(400);
    expect((await viaToken({ version: 1 })).status).toBe(400);
    expect(await row(theirs)).toMatchObject({ status: "pending" });
  });

  it("requires a same-origin request and is rate limited per address", async () => {
    const id = await submit(pat, at(FRI, 10));
    const token = await mintToken(id);
    expect((await api("POST", "/api/access/reservation/cancel", { body: { token, version: 1 }, origin: "http://evil.example.com" })).status).toBe(403);
    expect(await row(id)).toMatchObject({ status: "pending" });
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await viaToken({ token: "y".repeat(40), version: 1 }, { "cf-connecting-ip": "203.0.113.9" })).status;
    expect(last).toBe(429);
  });
});

describe("customer emails link to cancelling", () => {
  it("request-received and confirmed mails carry a cancel link, other mails and closed reservations do not", async () => {
    await confirmedWith(pat, at(FRI, 10), team.a);
    const [received] = await mailsTo("pat@example.test", "%received%");
    const [confirmed] = await mailsTo("pat@example.test", "%onfirmed%");
    for (const m of [received, confirmed]) {
      expect(m, "mail").toBeTruthy();
      expect(m!.text).toMatch(/Cancel reservation: http:\/\/localhost:5173\/r#t=[A-Za-z0-9_-]+&action=cancel/);
      expect(m!.html).toMatch(/http:\/\/localhost:5173\/r#t=[A-Za-z0-9_-]+&(amp;)?action=cancel/);
      // The same token views and cancels.
      expect(m!.text).toMatch(/http:\/\/localhost:5173\/r#t=([A-Za-z0-9_-]+)\r?\n/);
    }
    const token = /#t=([A-Za-z0-9_-]+)&action=cancel/.exec(confirmed!.text)![1]!;
    setNow(at(FRI, 8));
    const res = await viaToken({ token, version: 2 });
    expect(res.status).toBe(200);
  });
});

