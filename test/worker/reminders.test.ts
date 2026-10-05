import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../helpers";
import { loginCustomer, loginStaff, seedCustomer, seedTeam, seedWeekly, TZ } from "../fixtures";
import { clock, setNow } from "../../src/worker/lib/clock";
import { processOutbox } from "../../src/worker/mail/outbox";
import { cancelReservation } from "../../src/worker/reservations/cancel";
import { reminderStatements } from "../../src/worker/reservations/reminders";
import { DEFAULT_SETTINGS } from "../../src/domain/settings";
import { MIN, wallToUtc } from "../../src/domain/time";
import type { StaffPrincipal } from "../../src/worker/env";

afterEach(() => setNow(null));

const THU = "2026-10-01";
const FRI = "2026-10-02";
const at = (date: string, h: number, m = 0) => wallToUtc(date, h * 60 + m, TZ);
const START = at(FRI, 10);
const TZ_LABEL = "Asia/Tokyo (GMT+9)";

let team: Awaited<ReturnType<typeof seedTeam>>;
let pat: { id: number; cookie: string };
let adminCookie: string;

const setSetting = (key: string, value: unknown) =>
  env.DB.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)").bind(key, JSON.stringify(value)).run();
const count = async (sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;
const reminders = async (status?: string) =>
  (await env.DB.prepare(`SELECT * FROM email_jobs WHERE template = 'appointment_reminder' ${status ? "AND status = ?" : ""} ORDER BY send_after`)
    .bind(...(status ? [status] : []))
    .all<any>()).results;
const mailbox = async (subjectLike = "Reminder: remote support%") =>
  (await env.DB.prepare("SELECT subject, text, html FROM dev_mailbox WHERE to_email = 'pat@example.test' AND subject LIKE ? ORDER BY id").bind(subjectLike).all<{ subject: string; text: string; html: string }>()).results;

beforeEach(async () => {
  setNow(at(THU, 8));
  team = await seedTeam();
  pat = { id: await seedCustomer({ email: "pat@example.test", name: "Pat Co" }), cookie: "" };
  pat.cookie = await loginCustomer("pat@example.test");
  adminCookie = await loginStaff("admin@example.test");
  await seedWeekly(5, 600, 660, [team.admin, team.a]);
});

const submit = async (startAt = START) => {
  const res = await api("POST", "/api/customer/reservations", {
    cookie: pat.cookie,
    body: { customerId: pat.id, startAt, contactName: "Pat Example", phone: "+81 3-1234-5678", issue: "Printer is offline", idempotencyKey: crypto.randomUUID() },
  });
  expect(res.status).toBe(201);
  return res.json.reservation.id as string;
};
const approve = async (id: string) => {
  const res = await api("POST", `/api/staff/reservations/${id}/approve`, { cookie: adminCookie, body: { staffId: team.admin, version: 1 } });
  expect(res.status).toBe(200);
};
const confirmed = async () => {
  const id = await submit();
  await approve(id);
  return id;
};

describe("enqueueing on approval", () => {
  it("queues one reminder per offset, at start minus offset, deduped, with the start in the payload", async () => {
    const id = await confirmed();
    const jobs = await reminders();
    expect(jobs.map((j) => [j.send_after, j.dedupe_key, JSON.parse(j.payload), j.to_email, j.reservation_id, j.status])).toEqual([
      [START - 1440 * MIN, `reminder:${id}:v2:${START}:1440`, { startAt: START }, "pat@example.test", id, "queued"],
      [START - 60 * MIN, `reminder:${id}:v2:${START}:60`, { startAt: START }, "pat@example.test", id, "queued"],
    ]);
  });

  it("skips an offset whose time has passed or is within five minutes", async () => {
    await setSetting("customerReminderOffsetsMin", [1440, 120, 60]);
    const id = await submit();
    setNow(START - 124 * MIN); // approved late: 1440 passed, 120 is 4 min away (too close), 60 is fine
    await approve(id);
    expect((await reminders()).map((j) => j.dedupe_key)).toEqual([`reminder:${id}:v2:${START}:60`]);
  });

  it("queues exactly at the five minute boundary", async () => {
    await setSetting("customerReminderOffsetsMin", [60]);
    const id = await submit();
    setNow(START - 65 * MIN);
    await approve(id);
    expect((await reminders()).map((j) => j.send_after)).toEqual([clock.now() + 5 * MIN]);
  });

  it("queues nothing when no offsets are configured", async () => {
    await setSetting("customerReminderOffsetsMin", []);
    await confirmed();
    expect(await reminders()).toEqual([]);
    expect(await count("SELECT COUNT(*) AS n FROM email_jobs WHERE template = 'confirmed'")).toBe(1);
  });

  it("reminderStatements is pure on its inputs and uses the given reservation", () => {
    const stmts = reminderStatements(env.DB, { ...DEFAULT_SETTINGS, customerReminderOffsetsMin: [60, 30, 10] }, { id: "x", startAt: START, contactEmail: "a@example.test", version: 2 }, clock.now());
    expect(stmts.length).toBe(3);
  });
});

describe("sending", () => {
  it("sends at its time with the timezone label, the facts, the links and the call details", async () => {
    await setSetting("supportPhone", "+81 3-0000-0000");
    await setSetting("customerInstructions", "Close other remote tools first.");
    const id = await confirmed();
    await processOutbox(env, 50); // the confirmation only
    expect(await mailbox()).toEqual([]);

    setNow(START - 1440 * MIN);
    expect(await processOutbox(env, 50)).toMatchObject({ sent: 1 });
    const [m] = await mailbox();
    const ref = (await env.DB.prepare("SELECT ref FROM reservations WHERE id = ?").bind(id).first<{ ref: string }>())!.ref;
    expect(m!.subject).toMatch(/^Reminder: remote support on .*10:00/);
    expect(m!.subject.endsWith(` (${ref})`)).toBe(true);
    expect(m!.subject).toContain(TZ_LABEL);
    expect(m!.text).toContain("+81 3-1234-5678");
    expect(m!.text).toContain("TeamViewer");
    expect(m!.text).toContain("Close other remote tools first.");
    expect(m!.text).toContain("Pat Co");
    expect(m!.text).toContain(TZ_LABEL);
    const view = /(http\S*\/r#t=([A-Za-z0-9_-]+))/.exec(m!.text)!;
    expect(view).toBeTruthy();
    expect(m!.text).toContain(`${view[1]}&action=cancel`);
    expect(m!.text).toMatch(/Apple Calendar \/ Calendar file \(\.ics\): http\S*\/api\/cal\/[A-Za-z0-9_-]+\.ics/);
    // Not a login or technician mail: no technician name, nothing but the customer's own links.
    expect(m!.text).not.toContain("/staff/");
    expect((await reminders("sent")).length).toBe(1);
  });

  it("inside the cancellation cutoff shows the support phone instead of a cancel link", async () => {
    await setSetting("supportPhone", "+81 3-0000-0000");
    await confirmed();
    setNow(START - 1440 * MIN);
    await processOutbox(env, 50);
    setNow(START - 60 * MIN); // fires exactly at the cutoff: no longer cancellable online
    await processOutbox(env, 50);
    const mails = await mailbox();
    expect(mails.length).toBe(2);
    const [early, late] = mails;
    expect(early!.text).toContain("&action=cancel");
    expect(late!.text).not.toContain("&action=cancel");
    expect(late!.text).toContain("/api/cal/");
    expect(late!.text).toContain("+81 3-0000-0000");
  });

  it("cancelling before the send cancels the queued reminders and nothing is mailed", async () => {
    const id = await confirmed();
    const admin: StaffPrincipal = { id: team.admin, email: "admin@example.test", name: "Ada Admin", role: "admin" };
    await cancelReservation(env, { kind: "staff", staff: admin }, id, { reason: "Sorry", version: 2 });
    expect((await reminders("queued")).length).toBe(0);
    expect((await reminders("cancelled")).length).toBe(2);
    setNow(START - 30 * MIN);
    await processOutbox(env, 50);
    expect(await mailbox()).toEqual([]);
  });

  it("a moved appointment skips the stale reminder at send time", async () => {
    const id = await confirmed();
    await env.DB.prepare("UPDATE reservations SET start_at = start_at + ?, end_at = end_at + ? WHERE id = ?").bind(30 * MIN, 30 * MIN, id).run();
    setNow(START - 60 * MIN);
    await processOutbox(env, 50);
    expect(await mailbox()).toEqual([]);
    expect((await reminders("skipped")).length).toBe(2);
  });

  it("is skipped when the reservation is no longer confirmed", async () => {
    const id = await confirmed();
    await env.DB.prepare("UPDATE reservations SET status = 'completed' WHERE id = ?").bind(id).run();
    setNow(START - 60 * MIN);
    await processOutbox(env, 50);
    expect(await mailbox()).toEqual([]);
    expect((await reminders("skipped")).length).toBe(2);
  });
});
