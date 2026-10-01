import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../helpers";
import { loginCustomer, loginStaff, seedCustomer, seedTeam, seedWeekly, TZ, withBatchHook } from "../fixtures";
import worker from "../../src/worker/index";
import { setNow } from "../../src/worker/lib/clock";
import { wallToUtc } from "../../src/domain/time";
import { rangeBlocks } from "../../src/domain/slots";
import { enqueueEmail, processOutbox } from "../../src/worker/mail/outbox";
import { runSweeps } from "../../src/worker/cron";
import { cleanup } from "../../src/worker/cron/cleanup";

afterEach(() => {
  setNow(null);
  vi.restoreAllMocks();
});

const THU = "2026-10-01";
const FRI = "2026-10-02";
const at = (date: string, h: number, m = 0) => wallToUtc(date, h * 60 + m, TZ);
const TZ_LABEL = "Asia/Tokyo (GMT+9)";
const DAY = 86_400_000;
const MIN = 60_000;

let team: Awaited<ReturnType<typeof seedTeam>>;
let pat: { id: number; cookie: string };
let adminCookie: string;

beforeEach(async () => {
  setNow(at(THU, 8));
  team = await seedTeam();
  await env.DB.prepare("UPDATE staff SET name = 'Ada Admin' WHERE id = ?").bind(team.admin).run();
  await env.DB.prepare("UPDATE staff SET name = 'Tim Tech' WHERE id = ?").bind(team.a).run();
  // Technicians do not follow requests, so notify staff and admins are distinguishable.
  await env.DB.prepare("UPDATE staff SET notify = 0 WHERE role = 'technician'").run();
  pat = { id: await seedCustomer({ email: "pat@example.test", name: "Pat Co" }), cookie: "" };
  pat.cookie = await loginCustomer("pat@example.test");
  adminCookie = await loginStaff("admin@example.test");
  await seedWeekly(5, 600, 720, [team.admin, team.a]);
  await env.DB.prepare("INSERT INTO settings(key, value) VALUES ('maxActivePerAccount', '10')").run();
});

const submit = async (startAt: number, who = pat) => {
  const res = await api("POST", "/api/customer/reservations", {
    cookie: who.cookie,
    body: { customerId: who.id, startAt, contactName: "Pat Example", phone: "+81 3-1234-5678", issue: "Printer is offline", idempotencyKey: crypto.randomUUID() },
  });
  expect([res.status, res.json.error]).toEqual([201, undefined]);
  return res.json.reservation.id as string;
};
const approve = (id: string, staffId: number, version = 1) =>
  api("POST", `/api/staff/reservations/${id}/approve`, { cookie: adminCookie, body: { staffId, version } });
const setTimes = (id: string, t: { expires?: number | null; reminder?: number | null; escalation?: number | null }) =>
  env.DB.prepare(
    "UPDATE reservations SET expires_at = COALESCE(?, expires_at), approval_reminder_at = COALESCE(?, approval_reminder_at), escalation_at = COALESCE(?, escalation_at) WHERE id = ?",
  )
    .bind(t.expires ?? null, t.reminder ?? null, t.escalation ?? null, id)
    .run();
const count = async (sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;
const row = (id: string) => env.DB.prepare("SELECT * FROM reservations WHERE id = ?").bind(id).first<any>();
const blocks = () => count("SELECT COUNT(*) AS n FROM tech_blocks");
const jobs = async (template: string) =>
  (await env.DB.prepare("SELECT to_email, status, dedupe_key FROM email_jobs WHERE template = ? ORDER BY to_email").bind(template).all<{ to_email: string; status: string; dedupe_key: string }>()).results;
const mailsTo = async (email: string, subjectLike = "%") =>
  (await env.DB.prepare("SELECT subject, text FROM dev_mailbox WHERE to_email = ? AND subject LIKE ? ORDER BY id").bind(email, subjectLike).all<{ subject: string; text: string }>()).results;
const sweep = async (now: number) => {
  setNow(now);
  return runSweeps(env, now);
};

describe("pending expiry", () => {
  it("expires a due pending request: closed by the system, capacity freed, customer and team told", async () => {
    const id = await submit(at(FRI, 10));
    expect(await blocks()).toBeGreaterThan(0);
    const due = at(THU, 12);
    await setTimes(id, { expires: due });
    const r = await sweep(due);
    expect(r.counts.expiry).toBe(1);
    expect(await row(id)).toMatchObject({
      status: "expired",
      version: 2,
      closed_at: due,
      closed_by_kind: "system",
      closed_by: null,
      close_reason: "expired",
      provisional_staff_id: null,
    });
    expect(await blocks()).toBe(0);
    const a = await env.DB.prepare("SELECT * FROM audit_log WHERE action = 'reservation.expired'").first<any>();
    expect(a).toMatchObject({ actor_kind: "system", actor: null, reservation_id: id, customer_id: pat.id });
    const version = await env.DB.prepare("SELECT version FROM schedule_state").first<number>("version");
    expect(version).toBeGreaterThan(0);

    await processOutbox(env, 50);
    const [c] = await mailsTo("pat@example.test", "%couldn't confirm%in time%");
    expect(c!.text).toContain("couldn't confirm");
    expect(c!.text).toContain(TZ_LABEL);
    expect(c!.text).toContain(env.APP_BASE_URL);
    expect(c!.text).not.toContain("original appointment");
    for (const name of ["Tim Tech", "Ada Admin"]) expect(c!.text).not.toContain(name);
    const [tm] = await mailsTo("admin@example.test", "%expired%");
    expect(tm!.text).toContain("expired without approval");
    expect(tm!.text).toContain("Pat Co");
    expect(tm!.text).toContain(TZ_LABEL);
    // Technicians who do not follow requests are not told about a request that never became theirs.
    expect(await mailsTo("tech-a@example.test", "%expired%")).toHaveLength(0);
  });

  it("leaves requests that are not yet due and confirmed appointments alone", async () => {
    const early = await submit(at(FRI, 10));
    const confirmed = await submit(at(FRI, 11));
    expect((await approve(confirmed, team.a)).status).toBe(200);
    await setTimes(early, { expires: at(THU, 13) });
    await setTimes(confirmed, { expires: at(THU, 9) });
    const r = await sweep(at(THU, 12));
    expect(r.counts.expiry).toBe(0);
    expect((await row(early)).status).toBe("pending");
    expect((await row(confirmed)).status).toBe("confirmed");
  });

  it("withdraws an open proposal and frees its option holds", async () => {
    const id = await submit(at(FRI, 10));
    const optStart = at(FRI, 11);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO proposals(id, reservation_id, status, created_by, created_at, expires_at) VALUES ('p1', ?, 'open', ?, 0, ?)").bind(id, team.admin, at(FRI, 9)),
      env.DB.prepare("INSERT INTO proposal_options(id, proposal_id, start_at, end_at, staff_id, occ_start, occ_end) VALUES ('o1', 'p1', ?, ?, ?, ?, ?)").bind(optStart, optStart + 30 * MIN, team.d, optStart, optStart + 30 * MIN),
      env.DB.prepare("INSERT INTO tech_blocks(staff_id, block_start, owner_kind, owner_id) SELECT ?, value, 'option', 'o1' FROM json_each(?)").bind(
        team.d,
        JSON.stringify(rangeBlocks(optStart, optStart + 30 * MIN)),
      ),
    ]);
    expect(await count("SELECT COUNT(*) AS n FROM tech_blocks WHERE owner_kind = 'option'")).toBe(6);
    await setTimes(id, { expires: at(THU, 9) });
    await sweep(at(THU, 9));
    expect(await blocks()).toBe(0);
    expect(await env.DB.prepare("SELECT status, resolved_at FROM proposals WHERE id = 'p1'").first()).toEqual({ status: "withdrawn", resolved_at: at(THU, 9) });
    expect((await row(id)).status).toBe("expired");
  });

  it("cancels the request's queued mail that is wrong once it expired", async () => {
    const id = await submit(at(FRI, 10));
    // A reminder still waiting in the queue.
    await enqueueEmail(env.DB, { template: "approval_reminder", to: "admin@example.test", dedupeKey: "approval-reminder:x", reservationId: id, sendAfter: at(THU, 20) }).run();
    await setTimes(id, { expires: at(THU, 9) });
    await sweep(at(THU, 9));
    expect((await jobs("approval_reminder"))[0]!.status).toBe("cancelled");
  });

  it("a replacement request expiring leaves the original appointment untouched and says so", async () => {
    const original = await submit(at(FRI, 10));
    expect((await approve(original, team.a)).status).toBe(200);
    const replacement = await submit(at(FRI, 11));
    await env.DB.prepare("UPDATE reservations SET replaces_id = ? WHERE id = ?").bind(original, replacement).run();
    const originalBlocks = await count("SELECT COUNT(*) AS n FROM tech_blocks WHERE owner_id = ?", original);
    await setTimes(replacement, { expires: at(THU, 9) });
    await sweep(at(THU, 9));
    await processOutbox(env, 50);
    expect(await row(replacement)).toMatchObject({ status: "expired", close_reason: "expired" });
    expect(await row(original)).toMatchObject({ status: "confirmed", version: 2, assigned_staff_id: team.a });
    expect(await count("SELECT COUNT(*) AS n FROM tech_blocks WHERE owner_id = ?", original)).toBe(originalBlocks);
    const mails = await mailsTo("pat@example.test", "%couldn't confirm%in time%");
    expect(mails).toHaveLength(1);
    expect(mails[0]!.text).toContain("original appointment stays as it is");
  });

  it("only sends the expired notice while the reservation is expired (send-time precondition)", async () => {
    const id = await submit(at(FRI, 10));
    await enqueueEmail(env.DB, { template: "expired", to: "pat@example.test", dedupeKey: "expired:x", reservationId: id, payload: { audience: "customer" } }).run();
    const out = await processOutbox(env, 50);
    expect(out.skipped).toBeGreaterThanOrEqual(1);
    expect((await jobs("expired"))[0]!.status).toBe("skipped");
    expect(await mailsTo("pat@example.test", "%in time%")).toHaveLength(0);
  });
});

describe("approval reminders and escalation", () => {
  it("reminds notify staff once, at the reminder time, while the request is pending", async () => {
    const id = await submit(at(FRI, 10));
    await setTimes(id, { reminder: at(THU, 10), escalation: at(THU, 14), expires: at(THU, 18) });
    expect((await sweep(at(THU, 9, 59))).counts.reminders).toBe(0);
    expect(await jobs("approval_reminder")).toHaveLength(0);

    expect((await sweep(at(THU, 10))).counts.reminders).toBe(1);
    expect((await jobs("approval_reminder")).map((j) => [j.to_email, j.dedupe_key])).toEqual([
      ["admin@example.test", `approval-reminder:${id}:${team.admin}`],
    ]);
    await processOutbox(env, 50);
    const [m] = await mailsTo("admin@example.test", "Reminder%");
    expect(m!.subject).toContain("still needs approval");
    expect(m!.text).toContain("Pat Co");
    expect(m!.text).toContain(TZ_LABEL);
    expect(m!.text).toContain(`/staff/r/${id}`);
    // The approval deadline, with its zone.
    expect(m!.text).toMatch(/Approval deadline/);
    expect(m!.text).toMatch(/18:00/);
    expect(await jobs("approval_escalation")).toHaveLength(0);

    // Later runs do not remind again.
    await sweep(at(THU, 10, 1));
    await sweep(at(THU, 11));
    expect(await jobs("approval_reminder")).toHaveLength(1);
  });

  it("escalates to active admins only, with its own template, at the escalation time", async () => {
    const id = await submit(at(FRI, 10));
    const second = await (async () => {
      const row = await env.DB.prepare("INSERT INTO staff(email, name, role, notify, active, created_at, updated_at) VALUES ('boss@example.test', 'Bo Boss', 'admin', 0, 1, 0, 0) RETURNING id").first<{ id: number }>();
      await env.DB.prepare("INSERT INTO staff(email, name, role, notify, active, created_at, updated_at) VALUES ('gone@example.test', 'Gone Admin', 'admin', 1, 0, 0, 0)").run();
      return row!.id;
    })();
    await setTimes(id, { reminder: at(THU, 20), escalation: at(THU, 14), expires: at(THU, 18) });
    expect((await sweep(at(THU, 14))).counts.escalations).toBe(1);
    expect((await jobs("approval_escalation")).map((j) => j.dedupe_key).sort()).toEqual(
      [`approval-escalation:${id}:${team.admin}`, `approval-escalation:${id}:${second}`].sort(),
    );
    expect(await jobs("approval_reminder")).toHaveLength(0);
    await processOutbox(env, 50);
    const [m] = await mailsTo("boss@example.test", "Escalation%");
    expect(m!.text).toContain("Pat Co");
    expect(m!.text).toContain(TZ_LABEL);
    expect(await mailsTo("tech-a@example.test", "Escalation%")).toHaveLength(0);
    expect(await mailsTo("gone@example.test", "Escalation%")).toHaveLength(0);
    await sweep(at(THU, 15));
    expect(await jobs("approval_escalation")).toHaveLength(2);
  });

  it("skips pending requests with an open proposal (staff already acted)", async () => {
    const withProposal = await submit(at(FRI, 10));
    const plain = await submit(at(FRI, 11));
    for (const id of [withProposal, plain]) await setTimes(id, { reminder: at(THU, 9), escalation: at(THU, 9), expires: at(THU, 18) });
    await env.DB.prepare("INSERT INTO proposals(id, reservation_id, status, created_by, created_at, expires_at) VALUES ('p1', ?, 'open', ?, 0, ?)")
      .bind(withProposal, team.admin, at(THU, 18))
      .run();
    const r = await sweep(at(THU, 9));
    expect([r.counts.reminders, r.counts.escalations]).toEqual([1, 1]);
    for (const template of ["approval_reminder", "approval_escalation"]) {
      expect((await env.DB.prepare("SELECT DISTINCT reservation_id FROM email_jobs WHERE template = ?").bind(template).all()).results).toEqual([{ reservation_id: plain }]);
    }
    // Once the proposal is resolved and the request is still pending, the reminder is due again.
    await env.DB.prepare("UPDATE proposals SET status = 'withdrawn' WHERE id = 'p1'").run();
    expect((await sweep(at(THU, 9, 1))).counts.reminders).toBe(1);
  });

  it("does nothing for requests that are not pending or are already past their deadline", async () => {
    const confirmed = await submit(at(FRI, 10));
    expect((await approve(confirmed, team.a)).status).toBe(200);
    const late = await submit(at(FRI, 11));
    const declined = await submit(at(FRI, 11, 30));
    await api("POST", `/api/staff/reservations/${declined}/decline`, { cookie: adminCookie, body: { reason: "No", version: 1 } });
    for (const id of [confirmed, late, declined]) await setTimes(id, { reminder: at(THU, 9), escalation: at(THU, 9), expires: id === late ? at(THU, 10) : at(THU, 18) });
    // `late` is due for expiry at 10:00; sweeping at 10:00 expires it rather than reminding.
    const r = await sweep(at(THU, 10));
    expect(r.counts).toMatchObject({ reminders: 0, escalations: 0, expiry: 1 });
    expect(await jobs("approval_reminder")).toHaveLength(0);
    expect(await jobs("approval_escalation")).toHaveLength(0);
  });

  it("is not starved by earlier reminders: each run reaches new rows", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 55; i++) ids.push(await insertPending(i, { reminder: at(THU, 9), escalation: at(THU, 20), expires: at(THU, 18) }));
    expect((await sweep(at(THU, 10))).counts.reminders).toBe(50);
    expect((await sweep(at(THU, 10, 1))).counts.reminders).toBe(5);
    expect((await sweep(at(THU, 10, 2))).counts.reminders).toBe(0);
    expect(await jobs("approval_reminder")).toHaveLength(55);
  });

  it("only sends reminders and escalations while the reservation is pending (send-time precondition)", async () => {
    const id = await submit(at(FRI, 10));
    await setTimes(id, { reminder: at(THU, 9), escalation: at(THU, 9), expires: at(THU, 18) });
    await sweep(at(THU, 9));
    expect(await jobs("approval_reminder")).toHaveLength(1);
    expect((await approve(id, team.a)).status).toBe(200);
    // Approval does not cancel queued mail, so only the send-time check protects it.
    await processOutbox(env, 50);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM dev_mailbox WHERE subject LIKE 'Reminder%' OR subject LIKE 'Escalation%'").first<{ n: number }>())!.n).toBe(0);
    expect((await jobs("approval_reminder"))[0]!.status).toBe("skipped");
  });
});

describe("completion", () => {
  it("completes confirmed appointments that ended, frees their blocks and sends no mail", async () => {
    const done = await submit(at(FRI, 10));
    const upcoming = await submit(at(FRI, 11));
    expect((await approve(done, team.a)).status).toBe(200);
    expect((await approve(upcoming, team.a, 1)).status).toBe(200);
    const mailBefore = await count("SELECT COUNT(*) AS n FROM email_jobs");
    const endAt = (await row(done)).end_at as number;
    const r = await sweep(endAt);
    expect(r.counts.completion).toBe(1);
    expect(await row(done)).toMatchObject({ status: "completed", version: 3, closed_at: endAt, closed_by_kind: "system", closed_by: null });
    expect(await count("SELECT COUNT(*) AS n FROM tech_blocks WHERE owner_id = ?", done)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM tech_blocks WHERE owner_id = ?", upcoming)).toBeGreaterThan(0);
    expect((await row(upcoming)).status).toBe("confirmed");
    expect(await count("SELECT COUNT(*) AS n FROM email_jobs")).toBe(mailBefore);
    const a = await env.DB.prepare("SELECT * FROM audit_log WHERE action = 'reservation.completed'").first<any>();
    expect(a).toMatchObject({ actor_kind: "system", actor: null, reservation_id: done, customer_id: pat.id });
  });
});

describe("completion edge cases", () => {
  it("withdraws a leftover open proposal and frees its option blocks", async () => {
    const id = await submit(at(FRI, 10));
    expect((await approve(id, team.a)).status).toBe(200);
    const endAt = (await row(id)).end_at as number;
    const optStart = at(FRI, 11);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO proposals(id, reservation_id, status, created_by, created_at, expires_at) VALUES ('p1', ?, 'open', ?, 0, ?)").bind(id, team.admin, at(FRI, 9)),
      env.DB.prepare("INSERT INTO proposal_options(id, proposal_id, start_at, end_at, staff_id, occ_start, occ_end) VALUES ('o1', 'p1', ?, ?, ?, ?, ?)").bind(optStart, optStart + 30 * MIN, team.d, optStart, optStart + 30 * MIN),
      env.DB.prepare("INSERT INTO tech_blocks(staff_id, block_start, owner_kind, owner_id) SELECT ?, value, 'option', 'o1' FROM json_each(?)").bind(team.d, JSON.stringify(rangeBlocks(optStart, optStart + 30 * MIN))),
    ]);
    await sweep(endAt);
    expect((await row(id)).status).toBe("completed");
    expect(await blocks()).toBe(0);
    expect((await env.DB.prepare("SELECT status FROM proposals WHERE id = 'p1'").first<{ status: string }>())!.status).toBe("withdrawn");
  });

  it("a cancellation racing the completion sweep gives exactly one outcome: the cancellation wins", async () => {
    const id = await submit(at(FRI, 10));
    expect((await approve(id, team.a)).status).toBe(200);
    const endAt = (await row(id)).end_at as number;
    // The clock is a moment before the end (when staff may still cancel); the sweep's `now` is the end itself.
    setNow(endAt - 1000);
    let cancelled = false;
    const hooked = withBatchHook(async () => {
      const res = await api("POST", `/api/staff/reservations/${id}/cancel`, { cookie: adminCookie, body: { reason: "Customer asked", version: 2 } });
      expect(res.status).toBe(200);
      cancelled = true;
    });
    const r = await runSweeps(hooked.env, endAt);
    expect(cancelled).toBe(true);
    expect(r.counts.completion).toBe(0);
    expect(await row(id)).toMatchObject({ status: "cancelled", version: 3 });
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'reservation.completed'")).toBe(0);
  });
});

describe("cleanup", () => {
  const seedOld = async (now: number) => {
    const db = env.DB;
    const keep = now - 6 * DAY;
    const old = now - 8 * DAY;
    await db.batch([
      db.prepare("INSERT INTO auth_tokens(token_hash, kind, email, created_at, expires_at) VALUES ('t-old', 'customer', 'a@example.test', 0, ?)").bind(old),
      db.prepare("INSERT INTO auth_tokens(token_hash, kind, email, created_at, expires_at) VALUES ('t-new', 'customer', 'a@example.test', 0, ?)").bind(keep),
      db.prepare("INSERT INTO auth_tokens(token_hash, kind, email, created_at, expires_at) VALUES ('t-live', 'customer', 'a@example.test', 0, ?)").bind(now + 1000),
      db.prepare("INSERT INTO sessions(id_hash, kind, email, created_at, expires_at, last_seen_at) VALUES ('s-old', 'customer', 'a@example.test', 0, ?, 0)").bind(old),
      db.prepare("INSERT INTO sessions(id_hash, kind, email, created_at, expires_at, last_seen_at, revoked_at) VALUES ('s-revoked-old', 'customer', 'a@example.test', 0, ?, 0, ?)").bind(now + DAY, old),
      db.prepare("INSERT INTO sessions(id_hash, kind, email, created_at, expires_at, last_seen_at, revoked_at) VALUES ('s-revoked-new', 'customer', 'a@example.test', 0, ?, 0, ?)").bind(now + DAY, keep),
      db.prepare("INSERT INTO sessions(id_hash, kind, email, created_at, expires_at, last_seen_at) VALUES ('s-live', 'customer', 'a@example.test', 0, ?, 0)").bind(now + DAY),
      db.prepare("INSERT INTO rate_limits(key, window_start, count) VALUES ('rl-old', ?, 3)").bind(now - 2 * DAY),
      db.prepare("INSERT INTO rate_limits(key, window_start, count) VALUES ('rl-new', ?, 3)").bind(now - 2 * MIN),
      db.prepare("INSERT INTO dev_mailbox(to_email, subject, html, text, created_at) VALUES ('a@example.test', 'old', '', '', ?)").bind(old),
      db.prepare("INSERT INTO dev_mailbox(to_email, subject, html, text, created_at) VALUES ('a@example.test', 'new', '', '', ?)").bind(keep),
    ]);
    for (const [status, age, createdAt] of [
      ["sent", "old", now - 91 * DAY],
      ["skipped", "old", now - 91 * DAY],
      ["cancelled", "old", now - 91 * DAY],
      ["failed", "old", now - 91 * DAY],
      ["queued", "old", now - 91 * DAY],
      ["sent", "new", now - 89 * DAY],
    ] as const) {
      await db
        .prepare("INSERT INTO email_jobs(id, dedupe_key, template, to_email, payload, status, attempts, send_after, created_at) VALUES (?, ?, 'customer_login', 'a@example.test', '{}', ?, 0, ?, ?)")
        .bind(crypto.randomUUID(), `cj-${status}-${age}`, status, now + DAY, createdAt)
        .run();
    }
    // Access tokens need a reservation.
    const id = await submit(at(FRI, 10));
    await db.batch([
      db.prepare("INSERT INTO access_tokens(token_hash, reservation_id, created_at, expires_at) VALUES ('a-old', ?, 0, ?)").bind(id, old),
      db.prepare("INSERT INTO access_tokens(token_hash, reservation_id, created_at, expires_at) VALUES ('a-new', ?, 0, ?)").bind(id, keep),
    ]);
  };
  const names = async (sql: string) => (await env.DB.prepare(sql).all<{ k: string }>()).results.map((r) => r.k).sort();

  it("runs on the hour and removes only what is old enough", async () => {
    const hour = at(THU, 12);
    setNow(hour);
    await seedOld(hour);
    // Not on the hour: nothing is removed.
    expect((await sweep(hour + 5 * MIN)).counts.cleanup).toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM auth_tokens WHERE token_hash = 't-old'")).toBe(1);

    const r = await sweep(hour);
    expect(r.counts.cleanup).not.toBeNull();
    expect(await names("SELECT token_hash AS k FROM auth_tokens WHERE token_hash LIKE 't-%'")).toEqual(["t-live", "t-new"]);
    expect(await names("SELECT token_hash AS k FROM access_tokens WHERE token_hash LIKE 'a-%'")).toEqual(["a-new"]);
    expect(await names("SELECT id_hash AS k FROM sessions WHERE id_hash LIKE 's-%'")).toEqual(["s-live", "s-revoked-new"]);
    expect(await names("SELECT key AS k FROM rate_limits WHERE key LIKE 'rl-%'")).toEqual(["rl-new"]);
    expect(await names("SELECT subject AS k FROM dev_mailbox WHERE subject IN ('old','new')")).toEqual(["new"]);
    expect(await names("SELECT dedupe_key AS k FROM email_jobs WHERE dedupe_key LIKE 'cj-%'")).toEqual(["cj-failed-old", "cj-queued-old", "cj-sent-new"]);
  });
});

describe("cleanup cap", () => {
  it("removes at most `cap` rows per table per run and drains the backlog over runs", async () => {
    const now = at(THU, 12);
    setNow(now);
    const old = now - 8 * DAY;
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < 7; i++) {
      stmts.push(env.DB.prepare("INSERT INTO auth_tokens(token_hash, kind, email, created_at, expires_at) VALUES (?, 'customer', 'a@example.test', 0, ?)").bind(`cap-t-${i}`, old));
      stmts.push(env.DB.prepare("INSERT INTO dev_mailbox(to_email, subject, html, text, created_at) VALUES ('a@example.test', 'cap', '', '', ?)").bind(old));
    }
    await env.DB.batch(stmts);
    const left = () => count("SELECT COUNT(*) AS n FROM auth_tokens WHERE token_hash LIKE 'cap-t-%'");
    const mails = () => count("SELECT COUNT(*) AS n FROM dev_mailbox WHERE subject = 'cap'");
    expect(await cleanup(env, now, 3)).toBeGreaterThanOrEqual(6);
    expect([await left(), await mails()]).toEqual([4, 4]);
    await cleanup(env, now, 3);
    await cleanup(env, now, 3);
    expect([await left(), await mails()]).toEqual([0, 0]);
  });
});

describe("sweeps as a whole", () => {
  it("one failing row does not stop the rest of the same sweep", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < 3; i++) await insertPending(i, { expires: at(THU, 9), reminder: at(THU, 20), escalation: at(THU, 20) });
    // bulk-0 (swept first) cannot be expired: its update aborts the whole batch.
    await env.DB.prepare(
      "CREATE TRIGGER poison BEFORE UPDATE ON reservations WHEN NEW.id = 'bulk-0' AND NEW.status = 'expired' BEGIN SELECT RAISE(ABORT, 'poisoned row'); END",
    ).run();
    const r = await sweep(at(THU, 9));
    expect(r.counts.expiry).toBe(2);
    expect(r.failed).toEqual([]);
    expect(await row("bulk-0")).toMatchObject({ status: "pending", version: 1 });
    expect(await row("bulk-1")).toMatchObject({ status: "expired" });
    expect(await row("bulk-2")).toMatchObject({ status: "expired" });
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE reservation_id = 'bulk-0'")).toBe(0);
    expect(errors).toHaveBeenCalled();
  });

  it("processes at most 50 due rows per kind per run", async () => {
    for (let i = 0; i < 55; i++) await insertPending(i, { expires: at(THU, 9), reminder: at(THU, 20), escalation: at(THU, 20) });
    expect((await sweep(at(THU, 9))).counts.expiry).toBe(50);
    expect(await count("SELECT COUNT(*) AS n FROM reservations WHERE status = 'expired'")).toBe(50);
    expect((await sweep(at(THU, 9, 1))).counts.expiry).toBe(5);
    expect(await count("SELECT COUNT(*) AS n FROM reservations WHERE status = 'expired'")).toBe(55);
    expect((await sweep(at(THU, 9, 2))).counts.expiry).toBe(0);
  });

  it("running twice back-to-back gives the same outcome and no duplicate mail", async () => {
    const a = await submit(at(FRI, 10));
    const b = await submit(at(FRI, 11));
    const c = await submit(at(FRI, 11, 30));
    expect((await approve(c, team.a)).status).toBe(200);
    await setTimes(a, { expires: at(THU, 9) });
    await setTimes(b, { reminder: at(THU, 9), escalation: at(THU, 9), expires: at(THU, 18) });
    const endC = (await row(c)).end_at as number;
    await setTimes(c, { expires: at(THU, 8) });
    const first = await sweep(endC);
    // endC is on Friday, after `b`'s deadline: it expires too, then `c` completes.
    const snapshot = async () => ({
      reservations: (await env.DB.prepare("SELECT id, status, version FROM reservations ORDER BY id").all()).results,
      blocks: await blocks(),
      jobs: await count("SELECT COUNT(*) AS n FROM email_jobs"),
      audits: await count("SELECT COUNT(*) AS n FROM audit_log"),
      sched: await env.DB.prepare("SELECT version FROM schedule_state").first<number>("version"),
    });
    const afterFirst = await snapshot();
    const second = await sweep(endC);
    expect(second.counts).toMatchObject({ expiry: 0, reminders: 0, escalations: 0, completion: 0 });
    expect(await snapshot()).toEqual(afterFirst);
    expect(first.counts.expiry).toBe(2);
    expect(first.counts.completion).toBe(1);
    await processOutbox(env, 50);
    await processOutbox(env, 50);
    expect(await mailsTo("pat@example.test", "%in time%")).toHaveLength(2);
  });

  it("two overlapping runs expire a request exactly once", async () => {
    const id = await submit(at(FRI, 10));
    await setTimes(id, { expires: at(THU, 9) });
    setNow(at(THU, 9));
    const [x, y] = await Promise.all([runSweeps(env, at(THU, 9)), runSweeps(env, at(THU, 9))]);
    expect(x.counts.expiry + y.counts.expiry).toBe(1);
    expect(await row(id)).toMatchObject({ status: "expired", version: 2 });
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'reservation.expired'")).toBe(1);
    expect(await jobs("expired")).toHaveLength(2); // customer + one notify staff member (admin)
    await processOutbox(env, 50);
    expect(await mailsTo("pat@example.test", "%in time%")).toHaveLength(1);
  });

  it("an approval racing the expiry sweep gives exactly one outcome: the approval wins", async () => {
    const id = await submit(at(FRI, 10));
    await setTimes(id, { expires: at(THU, 9) });
    setNow(at(THU, 9));
    // The approval commits after the sweep read the reservation, right before the sweep's batch.
    let approved = false;
    const hooked = withBatchHook(async () => {
      expect((await approve(id, team.a)).status).toBe(200);
      approved = true;
    });
    const r = await runSweeps(hooked.env, at(THU, 9));
    // The sweep's batch aborted on the schedule-version guard; its retry saw a confirmed request and left it be.
    expect(approved).toBe(true);
    expect(r.counts.expiry).toBe(0);
    expect(await row(id)).toMatchObject({ status: "confirmed", version: 2, assigned_staff_id: team.a, close_reason: null });
    expect(await count("SELECT COUNT(*) AS n FROM tech_blocks WHERE owner_id = ?", id)).toBeGreaterThan(0);
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'reservation.expired'")).toBe(0);
    expect(await jobs("expired")).toHaveLength(0);
  });

  it("an approval that arrives after the expiry is refused as stale", async () => {
    const id = await submit(at(FRI, 10));
    await setTimes(id, { expires: at(THU, 9) });
    await sweep(at(THU, 9));
    const res = await approve(id, team.a);
    expect([res.status, res.json.error]).toEqual([409, "stale"]);
    expect((await row(id)).status).toBe("expired");
  });

  it("a failing sweep does not stop the others, and the failure is logged without detail", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const id = await submit(at(FRI, 10));
    await setTimes(id, { expires: at(THU, 18), reminder: at(THU, 9), escalation: at(THU, 20) });
    const real = env.DB;
    const broken = {
      prepare: (q: string) => {
        if (q.includes("expires_at <=")) throw new Error("boom https://secret.example.test/x");
        return real.prepare(q);
      },
      batch: (s: D1PreparedStatement[]) => real.batch(s),
    } as unknown as D1Database;
    setNow(at(THU, 9));
    const r = await runSweeps({ ...env, DB: broken }, at(THU, 9));
    expect(r.failed).toEqual(["expiry"]);
    expect(r.counts.reminders).toBe(1);
    expect(errors).toHaveBeenCalled();
    expect(JSON.stringify(errors.mock.calls)).not.toContain("secret.example.test");
  });

  it("scheduled() runs the sweeps and then delivers the outbox", async () => {
    const id = await submit(at(FRI, 10));
    await setTimes(id, { expires: at(THU, 9) });
    setNow(at(THU, 9));
    const ctx = createExecutionContext();
    await worker.scheduled!({ cron: "* * * * *", scheduledTime: at(THU, 9), type: "scheduled", noRetry() {} } as any, env as any, ctx);
    await waitOnExecutionContext(ctx);
    expect((await row(id)).status).toBe("expired");
    expect(await mailsTo("pat@example.test", "%in time%")).toHaveLength(1);
  });
});

/** A pending request inserted directly (cheap: no capacity or mail), for bounded-batch tests. */
async function insertPending(i: number, t: { expires: number; reminder: number; escalation: number }): Promise<string> {
  const id = `bulk-${i}`;
  const start = at(FRI, 10) + i * 60 * MIN;
  await env.DB.prepare(
    `INSERT INTO reservations(id, ref, customer_id, contact_email, contact_name, phone, issue, start_at, end_at, occ_start, occ_end, status,
       idempotency_key, approval_reminder_at, escalation_at, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, 'pat@example.test', 'Pat', '+81', 'x', ?, ?, ?, ?, 'pending', ?, ?, ?, ?, 0, 0)`,
  )
    .bind(id, `BK-${1000 + i}`, pat.id, start, start + 30 * MIN, start, start + 30 * MIN, `idem-${i}`, t.reminder, t.escalation, t.expires)
    .run();
  return id;
}
