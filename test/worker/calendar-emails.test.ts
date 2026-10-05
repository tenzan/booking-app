import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/worker/index";
import { api } from "../helpers";
import { loginCustomer, loginStaff, seedCustomer, seedTeam, seedWeekly, TZ } from "../fixtures";
import { setNow } from "../../src/worker/lib/clock";
import { sha256Hex } from "../../src/worker/lib/crypto";
import { processOutbox } from "../../src/worker/mail/outbox";
import { MIN, wallToUtc } from "../../src/domain/time";

afterEach(() => setNow(null));

const THU = "2026-10-01";
const FRI = "2026-10-02";
const at = (date: string, h: number, m = 0) => wallToUtc(date, h * 60 + m, TZ);
const START = at(FRI, 10);
const DAY = 86_400_000;

let team: Awaited<ReturnType<typeof seedTeam>>;
let pat: { id: number; cookie: string };
let adminCookie: string;

beforeEach(async () => {
  setNow(at(THU, 8));
  team = await seedTeam();
  await env.DB.prepare("UPDATE staff SET name = 'Tim Tech' WHERE id = ?").bind(team.a).run();
  await env.DB.prepare("UPDATE staff SET name = 'Una Tech' WHERE id = ?").bind(team.b).run();
  pat = { id: await seedCustomer({ email: "pat@example.test", name: "Pat Co" }), cookie: "" };
  pat.cookie = await loginCustomer("pat@example.test");
  adminCookie = await loginStaff("admin@example.test");
  await seedWeekly(5, 600, 720, [team.admin, team.a, team.b]);
});

const mailsTo = async (email: string, subjectLike = "%") =>
  (await env.DB.prepare("SELECT subject, text, html FROM dev_mailbox WHERE to_email = ? AND subject LIKE ? ORDER BY id").bind(email, subjectLike).all<{
    subject: string;
    text: string;
    html: string;
  }>()).results;

const submit = async () => {
  const res = await api("POST", "/api/customer/reservations", {
    cookie: pat.cookie,
    body: { customerId: pat.id, startAt: START, contactName: "Pat Example", phone: "+81 3-1234-5678", issue: "Printer offline", idempotencyKey: crypto.randomUUID() },
  });
  expect(res.status).toBe(201);
  return { id: res.json.reservation.id as string, ref: res.json.reservation.ref as string };
};
const confirmed = async (staffId = team.a) => {
  const r = await submit();
  expect((await api("POST", `/api/staff/reservations/${r.id}/approve`, { cookie: adminCookie, body: { staffId, version: 1 } })).status).toBe(200);
  return r;
};

const CAL_LINK = /http:\/\/localhost:5173\/api\/cal\/([A-Za-z0-9_-]{43})\.ics/;
const fetchFile = async (url: string) => {
  const ctx = createExecutionContext();
  const res = await worker.fetch!(new Request(url) as any, env as any, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, text: (await res.text()).replace(/\r\n /g, "") };
};

/** The calendar section of a mail: its file link and the three web calendar links, from both the text and the HTML. */
const expectCalendar = (m: { text: string; html: string }) => {
  expect(m.text).toContain("Add to calendar");
  const file = CAL_LINK.exec(m.text)![0];
  // In the text version the file link is listed once, for Apple Calendar and other calendars alike.
  expect(m.text).toContain(`Apple Calendar / Other calendar (.ics): ${file}`);
  expect(m.text).toMatch(/Google Calendar: https:\/\/calendar\.google\.com\/calendar\/render\?\S+/);
  expect(m.text).toMatch(/Outlook\.com: https:\/\/outlook\.live\.com\/calendar\/0\/action\/compose\?\S+/);
  expect(m.text).toMatch(/Microsoft 365: https:\/\/outlook\.office\.com\/calendar\/0\/action\/compose\?\S+/);
  // In the HTML all five are shown, the file link twice (Apple, Other).
  for (const label of ["Apple Calendar", "Google Calendar", "Outlook.com", "Microsoft 365", "Other calendar (.ics)"]) expect(m.html).toContain(`>${label}</a>`);
  expect(m.html.split(`href="${file}"`).length - 1).toBe(2);
  return file;
};
const expectNoCalendar = (m: { text: string; html: string }) => {
  expect(m.text).not.toContain("Add to calendar");
  expect(m.text).not.toMatch(CAL_LINK);
  expect(m.text).not.toContain("calendar.google.com");
};

describe("calendar links in customer emails", () => {
  it("the confirmation carries them; the file link opens the customer event and lasts until 14 days after the end", async () => {
    const { ref } = await confirmed();
    await processOutbox(env, 50);
    const [m] = await mailsTo("pat@example.test", "Confirmed:%");
    const file = expectCalendar(m!);
    const google = new URL(/https:\/\/calendar\.google\.com\S+/.exec(m!.text)![0]);
    expect(google.searchParams.get("details")).toContain(ref);
    expect(google.searchParams.get("details")).not.toContain("Tim Tech");

    const res = await fetchFile(file);
    expect(res.status).toBe(200);
    expect(res.text).toContain(`UID:${ref}@localhost`);
    expect(res.text).not.toContain("Tim Tech");
    const row = await env.DB.prepare("SELECT audience, expires_at FROM calendar_tokens WHERE token_hash = ?").bind(await sha256Hex(CAL_LINK.exec(file)![1]!)).first();
    expect(row).toEqual({ audience: "customer", expires_at: START + 30 * MIN + 14 * DAY });
  });

  it("the request-received mail (no confirmed time yet) has none", async () => {
    await submit();
    await processOutbox(env, 50);
    const mails = await mailsTo("pat@example.test", "Request received%");
    expect(mails).toHaveLength(1);
    expectNoCalendar(mails[0]!);
  });

  it("the reminder carries them", async () => {
    await confirmed();
    await processOutbox(env, 50);
    setNow(START - 1440 * MIN);
    await processOutbox(env, 50);
    const [m] = await mailsTo("pat@example.test", "Reminder:%");
    expectCalendar(m!);
    expect(m!.text).not.toContain("&action=ics");
  });

  it("the cancelled mail asks to remove a confirmed appointment from the calendar, but not a request that was never confirmed", async () => {
    const c = await confirmed();
    expect((await api("POST", `/api/customer/reservations/${c.id}/cancel`, { cookie: pat.cookie, body: { version: 2 } })).status).toBe(200);
    await processOutbox(env, 50);
    const [cancelled] = await mailsTo("pat@example.test", "Cancelled:%");
    expect(cancelled!.text).toContain("If you added this appointment to your calendar, please delete it");
    expectNoCalendar(cancelled!);

    const p = await submit();
    expect((await api("POST", `/api/customer/reservations/${p.id}/cancel`, { cookie: pat.cookie, body: { version: 1 } })).status).toBe(200);
    await processOutbox(env, 50);
    const mails = await mailsTo("pat@example.test", "Cancelled:%");
    expect(mails).toHaveLength(2);
    expect(mails[1]!.text).not.toContain("your calendar");
  });
});

describe("calendar links in technician emails", () => {
  it("the assigned technician's copy carries the staff event; the rest of the team's copies don't", async () => {
    const { id, ref } = await confirmed(team.a);
    await processOutbox(env, 50);
    const [mine] = await mailsTo("tech-a@example.test", "% confirmed — assigned to %");
    const file = expectCalendar(mine!);
    const res = await fetchFile(file);
    expect(res.status).toBe(200);
    expect(res.text).toContain(`URL:http://localhost:5173/staff/r/${id}`);
    expect(res.text).toContain("Tim Tech");
    const google = new URL(/https:\/\/calendar\.google\.com\S+/.exec(mine!.text)![0]);
    expect(google.searchParams.get("text")).toBe(`Remote support — Pat Co (${ref})`);
    for (const other of ["tech-b@example.test", "admin@example.test"]) {
      const mails = await mailsTo(other);
      expect(mails.length).toBeGreaterThan(0);
      for (const m of mails) expectNoCalendar(m);
    }
  });

  it("after a reassignment, only the new technician's notice carries them", async () => {
    const { id } = await confirmed(team.a);
    await processOutbox(env, 50);
    await env.DB.prepare("DELETE FROM dev_mailbox").run();
    expect((await api("POST", `/api/staff/reservations/${id}/reassign`, { cookie: adminCookie, body: { staffId: team.b, version: 2 } })).status).toBe(200);
    await processOutbox(env, 50);
    const [mine] = await mailsTo("tech-b@example.test", "% reassigned to %");
    const res = await fetchFile(expectCalendar(mine!));
    expect(res.text).toContain("Una Tech");
    for (const m of await mailsTo("tech-a@example.test")) expectNoCalendar(m);
  });
});
