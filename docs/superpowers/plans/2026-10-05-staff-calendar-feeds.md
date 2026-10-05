# Staff Calendar Subscriptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each staff member can subscribe once, from the staff Calendar page, to two live calendars: "my appointments" and "team (everyone else)". Each holds confirmed appointments only and updates by itself.

**Architecture:** Each active staff member gets one row in a new `calendar_feeds` table (migration 0008). The row holds a random token, stored in plain text so the links can be shown again (spec §3). A public `GET /api/feed/<token>/{mine,team}.ics` serves a multi-event VCALENDAR built from the same staff event text as today's per-appointment `.ics`. A staff-session `POST /api/staff/calendar-feed` returns the two URLs, creating the token if missing. `POST /api/staff/calendar-feed/reset` replaces the token and writes an audit entry. A "Subscribe in your calendar app" card on `/staff/calendar` offers Add to Google Calendar, a `webcal://` link and Copy link for each calendar, plus Reset links.

**Tech Stack:** Cloudflare Workers + Hono, D1 (SQL migrations), React 19 + TanStack Query + Tailwind v4, Vitest 4 + `@cloudflare/vitest-pool-workers`, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-05-staff-calendar-feeds-design.md`

## Global Constraints

- Public, generic repo: only `example.com` / `example.test` in code and tests; nothing organisation-specific.
- Every user-facing string goes through `src/shared/i18n/en.ts` (`t(...)`).
- **No GET mutates state** (project rule). The spec's `GET /api/staff/calendar-feed` becomes `POST /api/staff/calendar-feed`, because the first call creates the token. The response is the same.
- Feeds hold **confirmed** reservations only, `end_at > now − 30 days`, no upper limit. **Mine** = `assigned_staff_id = me`; **Team** = `assigned_staff_id <> me`.
- Calendar names: `"{org} — my appointments"` and `"{org} — team"`. Titles: Mine `"{customer} ({ref})"`, Team `"{tech}: {customer} ({ref})"`, where `{tech}` is the first word of the technician's name.
- Feed properties: `REFRESH-INTERVAL;VALUE=DURATION:PT1H` and `X-PUBLISHED-TTL:PT1H`. UID `<ref>@<host>`, the same as the per-appointment `.ics`.
- Feed response headers: `Content-Type: text/calendar; charset=utf-8`, `Content-Disposition: inline; filename="<kind>.ics"`, `Cache-Control: no-store`. Rate limit `feed:ip:<ip>`, 120 requests per 15 minutes.
- An unknown or reset token, or a deactivated owner: `404` with a short **plain-text** body that names the app's home URL.
- Reset writes audit action `calendar_feed.reset` (actor kind `staff`, actor = staff id).
- The existing single-event `buildIcs` output stays **byte-identical**: all current `test/domain/ics.test.ts` and `test/worker/ics.test.ts` assertions must still pass unchanged.
- Never use port 5180 (the product owner's preview). `npx playwright test` resets this checkout's local D1: back up `.wrangler/state` before running it and restore the backup afterwards.
- Commits end with the attribution lines from the session's system reminder.

## Review Focus

1. **A staff member with no confirmed appointments** subscribes: the feed must still be a well-formed VCALENDAR (header, calendar name, no VEVENT) so calendar apps accept it and fill it later. Pinned in Task 2.
2. **Customer text with commas, semicolons, newlines, emoji or a 1,000-character issue** must not break the feed: escaped, and every line folded to 75 octets or fewer. Pinned in Task 2.
3. **Technician names that are one word, have extra spaces, or are empty** must give a sensible Team title prefix ("Madonna: …", no leading colon). Pinned in Task 2 (`firstName`).
4. **Two tabs opening the card at the same time** (first creation racing) must end with **one** token, with both tabs showing the same links. Pinned in Task 3.
5. **Calendar pollers sending `HEAD`**, or appending a query string, must get `200` like `GET`. Pinned in Task 2.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/domain/ics.ts` (modify) | add `buildCalendar` (many events, calendar name, refresh hints); share the VEVENT lines with `buildIcs` |
| `src/worker/reservations/ics.ts` (modify) | export `ICS_SELECT`, `IcsRow`, `staffEventFromRow` so many staff events come from one query |
| `migrations/0008_calendar_feeds.sql` (create) | the `calendar_feeds` table |
| `src/worker/calendar-feeds.ts` (create) | token storage and reset, feed rows and body, public feed routes, staff session routes |
| `src/worker/app.ts` (modify) | mount `/feed` and the staff feed routes |
| `scripts/seed-dev.mjs`, `scripts/seed-dev.test.mjs` (modify) | reset clears `calendar_feeds` |
| `src/web/pages/staff/calendar/SubscribeCard.tsx` (create) | the subscribe card |
| `src/web/pages/staff/Calendar.tsx` (modify) | render the card |
| `src/web/pages/staff/Activity.tsx` (modify) | describe `calendar_feed.reset` |
| `src/shared/i18n/en.ts` (modify) | all new strings |
| `README.md`, `docs/SETUP.md` (modify) | the feature, and the plain-text token note for operators |
| Tests | `test/domain/ics.test.ts`, `test/worker/calendar-feeds.test.ts` (create), `test/worker/schema.test.ts`, `e2e/lifecycle.spec.ts` |

---

### Task 1: Multi-event calendar in the domain layer

**Files:**
- Modify: `src/domain/ics.ts`
- Test: `test/domain/ics.test.ts`

**Interfaces:**
- Consumes: the existing `IcsEvent`, `escapeText`, `foldLine` and `formatUtc` in `src/domain/ics.ts`.
- Produces: `export function buildCalendar(c: { name: string; events: IcsEvent[] }): string`. Its `METHOD` is always `PUBLISH`; each event's own `method` field is ignored.

- [ ] **Step 1: Write the failing tests** (append to `test/domain/ics.test.ts`, which already defines `base`, `lines` and `unfold`)

```ts
import { buildCalendar } from "../../src/domain/ics";

describe("buildCalendar", () => {
  const second = { ...base, uid: "R-WXYZ-1234@booking.example.com", startAt: Date.parse("2026-10-06T01:30:00Z"), endAt: Date.parse("2026-10-06T02:00:00Z") };

  it("wraps several events in one VCALENDAR with the calendar name and refresh hints", () => {
    const ics = buildCalendar({ name: "Acme, Support — team", events: [base, second] });
    const l = lines(unfold(ics));
    expect(l[0]).toBe("BEGIN:VCALENDAR");
    expect(l).toContain("METHOD:PUBLISH");
    expect(l).toContain("NAME:Acme\\, Support — team");
    expect(l).toContain("X-WR-CALNAME:Acme\\, Support — team");
    expect(l).toContain("REFRESH-INTERVAL;VALUE=DURATION:PT1H");
    expect(l).toContain("X-PUBLISHED-TTL:PT1H");
    expect(l.filter((x) => x === "BEGIN:VEVENT")).toHaveLength(2);
    expect(l).toContain("UID:R-WXYZ-1234@booking.example.com");
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    for (const line of ics.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
  });

  it("is a well-formed calendar with no events", () => {
    const ics = buildCalendar({ name: "Mine", events: [] });
    expect(ics).toBe(
      ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Remote Support Booking//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "NAME:Mine", "X-WR-CALNAME:Mine", "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H", "END:VCALENDAR", ""].join("\r\n"),
    );
  });

  it("leaves the single-event buildIcs output unchanged", () => {
    const one = buildIcs(base);
    expect(one).not.toContain("X-WR-CALNAME");
    expect(lines(one).slice(0, 6)).toEqual(["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Remote Support Booking//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "BEGIN:VEVENT"]);
  });
});
```

- [ ] **Step 2: Run the tests to check they fail**

Run: `npx vitest run test/domain/ics.test.ts`
Expected: FAIL, because `buildCalendar` is not exported.

- [ ] **Step 3: Implement.** In `src/domain/ics.ts`, replace `buildIcs` with a shared VEVENT helper and two builders:

```ts
const header = (method: string) => ["BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:${PRODID}`, "CALSCALE:GREGORIAN", `METHOD:${method}`];

function veventLines(e: IcsEvent): string[] {
  return [
    "BEGIN:VEVENT",
    `UID:${escapeText(e.uid)}`,
    `DTSTAMP:${formatUtc(e.stamp)}`,
    `DTSTART:${formatUtc(e.startAt)}`,
    `DTEND:${formatUtc(e.endAt)}`,
    `SEQUENCE:${e.sequence}`,
    `STATUS:${e.status}`,
    `SUMMARY:${escapeText(e.summary)}`,
    `DESCRIPTION:${escapeText(e.description)}`,
    ...(e.location ? [`LOCATION:${escapeText(e.location)}`] : []),
    // URI value: no TEXT escaping, but never let a line break through.
    `URL:${e.url.replace(/[\r\n]/g, "")}`,
    "END:VEVENT",
  ];
}

const serialize = (content: string[]) => content.map(foldLine).join("\r\n") + "\r\n";

/** A VCALENDAR with one VEVENT. CRLF-terminated; no alarms. */
export function buildIcs(e: IcsEvent): string {
  return serialize([...header(e.method), ...veventLines(e), "END:VCALENDAR"]);
}

/**
 * A subscribable calendar: any number of events (none is fine), a display name (RFC 7986 NAME and the widely read
 * X-WR-CALNAME) and hints to poll hourly. Clients that ignore the hints (Google) refresh on their own schedule.
 */
export function buildCalendar(c: { name: string; events: IcsEvent[] }): string {
  return serialize([
    ...header("PUBLISH"),
    `NAME:${escapeText(c.name)}`,
    `X-WR-CALNAME:${escapeText(c.name)}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
    ...c.events.flatMap(veventLines),
    "END:VCALENDAR",
  ]);
}
```

- [ ] **Step 4: Run the domain and worker `.ics` tests**

Run: `npx vitest run test/domain/ics.test.ts test/worker/ics.test.ts test/worker/calendar-links.test.ts`
Expected: PASS, with every earlier assertion unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/domain/ics.ts test/domain/ics.test.ts
git commit -m "feat(ics): multi-event calendar with name and refresh hints"
```

---

### Task 2: Feed content and the public feed endpoint

**Files:**
- Modify: `src/worker/reservations/ics.ts`, `src/worker/app.ts`, `src/shared/i18n/en.ts`
- Create: `migrations/0008_calendar_feeds.sql`, `src/worker/calendar-feeds.ts`, `test/worker/calendar-feeds.test.ts`
- Modify: `test/worker/schema.test.ts`, `scripts/seed-dev.mjs`, `scripts/seed-dev.test.mjs`

**Interfaces:**
- Consumes: `buildCalendar` (Task 1); `rateLimit(db, key, limit, windowMs)` from `src/worker/lib/rate-limit.ts`; `clock.now()`; `t(...)`.
- Produces, in `src/worker/reservations/ics.ts`:
  - `export interface IcsRow` (already defined; export it)
  - `export const ICS_SELECT: string`: the existing `loadRow` SELECT without its `WHERE`
  - `export function staffEventFromRow(env: Env, r: IcsRow, summary?: string): IcsEvent`
- Produces, in `src/worker/calendar-feeds.ts`:
  - `export type FeedKind = "mine" | "team"`
  - `export const firstName = (name: string | null) => string`
  - `export async function feedCalendar(env: Env, staffId: number, kind: FeedKind, now: number): Promise<string>`
  - `export async function staffIdForFeedToken(db: D1Database, token: string): Promise<number | null>` (active staff only)
  - `export const feedRoutes: Hono<AppEnv>`, mounted at `/api/feed`
  - `export const feedUrl = (env: Env, token: string, kind: FeedKind) => string`
  - `export async function ensureFeedToken(db: D1Database, staffId: number): Promise<string>`
  - `export const staffFeedRoutes: Hono<AppEnv>`, mounted at `/api/staff`, with `POST /calendar-feed` → `{ mine: string; team: string }`

- [ ] **Step 1: Migration.** Create `migrations/0008_calendar_feeds.sql`:

```sql
-- Staff calendar subscriptions: one token per staff member, read by GET /api/feed/<token>/{mine,team}.ics. Stored in
-- plain text so the links can be shown again (a hash would force a reset, breaking calendars already subscribed); the
-- token only reads confirmed appointments, can be reset, and stops working when its owner is deactivated.
CREATE TABLE calendar_feeds (
  staff_id INTEGER PRIMARY KEY REFERENCES staff(id),
  token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
```

In `scripts/seed-dev.mjs`, add `DELETE FROM calendar_feeds;` to the reset statements **before** `DELETE FROM staff ...` (the second reset line, after `DELETE FROM sessions;`). In `scripts/seed-dev.test.mjs`, insert a row before the reset, `INSERT INTO calendar_feeds (staff_id, token, created_at) SELECT id, 'feed-tok', 0 FROM staff WHERE email = 'extra@example.test';`, and add `"calendar_feeds"` to the list of tables asserted to be empty. In `test/worker/schema.test.ts` nothing changes: the table has no extra index, because `token UNIQUE` is its index.

- [ ] **Step 2: Write the failing worker tests.** Create `test/worker/calendar-feeds.test.ts`:

```ts
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/worker/index";
import { api } from "../helpers";
import { loginCustomer, loginStaff, seedCustomer, seedTeam, seedWeekly, TZ } from "../fixtures";
import { setNow } from "../../src/worker/lib/clock";
import { wallToUtc } from "../../src/domain/time";
import { firstName } from "../../src/worker/calendar-feeds";

afterEach(() => setNow(null));

const THU = "2026-10-01";
const FRI = "2026-10-02";
const DAY = 86_400_000;
const at = (date: string, h: number, m = 0) => wallToUtc(date, h * 60 + m, TZ);

let team: Awaited<ReturnType<typeof seedTeam>>;
let pat: { id: number; cookie: string };
let adminCookie: string;
let techA: string;

beforeEach(async () => {
  setNow(at(THU, 8));
  team = await seedTeam();
  for (const [id, name] of [[team.admin, "Ada Admin"], [team.a, "Tim Tech"], [team.b, "Una Tech"]] as const) {
    await env.DB.prepare("UPDATE staff SET name = ? WHERE id = ?").bind(name, id).run();
  }
  await env.DB.prepare("INSERT INTO settings(key, value) VALUES ('orgName', '\"Acme Support\"'), ('maxActivePerAccount', '9')").run();
  pat = { id: await seedCustomer({ email: "pat@example.test", name: "Pat, Co; Ltd" }), cookie: "" };
  pat.cookie = await loginCustomer("pat@example.test");
  adminCookie = await loginStaff("admin@example.test");
  techA = await loginStaff("tech-a@example.test");
  await seedWeekly(5, 600, 720, [team.admin, team.a, team.b]);
});

const submit = async (startAt: number, issue = "Printer offline") => {
  const res = await api("POST", "/api/customer/reservations", {
    cookie: pat.cookie,
    body: { customerId: pat.id, startAt, contactName: "Pat Example", phone: "+81 3-1234-5678", issue, idempotencyKey: crypto.randomUUID() },
  });
  expect(res.status).toBe(201);
  return { id: res.json.reservation.id as string, ref: res.json.reservation.ref as string };
};
const confirmed = async (startAt: number, staffId: number, issue?: string) => {
  const r = await submit(startAt, issue);
  expect((await api("POST", `/api/staff/reservations/${r.id}/approve`, { cookie: adminCookie, body: { staffId, version: 1 } })).status).toBe(200);
  return r;
};
const urls = async (cookie: string) => {
  const res = await api("POST", "/api/staff/calendar-feed", { cookie, body: {} });
  expect(res.status).toBe(200);
  return res.json as { mine: string; team: string };
};
const raw = async (url: string, method = "GET", ip?: string) => {
  const ctx = createExecutionContext();
  const headers = new Headers();
  if (ip) headers.set("cf-connecting-ip", ip);
  const res = await worker.fetch!(new Request(url, { method, headers }) as any, env as any, ctx);
  await waitOnExecutionContext(ctx);
  const body = await res.text();
  // `body` as served (folded); `text` unfolded, for matching.
  return { status: res.status, headers: res.headers, body, text: body.replace(/\r\n /g, "") };
};
const summaries = (ics: string) => ics.split("\r\n").filter((l) => l.startsWith("SUMMARY:")).map((l) => l.slice(8).replace(/\\([,;\\])/g, "$1"));

describe("feed content", () => {
  it("Mine holds my confirmed appointments; Team holds everyone else's, titled with the technician's first name", async () => {
    const mine = await confirmed(at(FRI, 10), team.a);
    const theirs = await confirmed(at(FRI, 11), team.b);
    await submit(at(FRI, 10, 30)); // pending: in neither
    const { mine: mineUrl, team: teamUrl } = await urls(techA);
    const m = await raw(mineUrl);
    expect(m.status).toBe(200);
    expect(m.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(m.headers.get("content-disposition")).toBe('inline; filename="mine.ics"');
    expect(m.text).toContain("X-WR-CALNAME:Acme Support — my appointments");
    expect(summaries(m.text)).toEqual([`Pat, Co; Ltd (${mine.ref})`]);
    expect(m.text).toContain(`UID:${mine.ref}@localhost`);
    const tm = await raw(teamUrl);
    expect(tm.text).toContain("X-WR-CALNAME:Acme Support — team");
    expect(summaries(tm.text)).toEqual([`Una: Pat, Co; Ltd (${theirs.ref})`]);
    expect(tm.text).not.toContain(mine.ref);
  });

  it("leaves out cancelled appointments and those that ended more than 30 days ago", async () => {
    const gone = await confirmed(at(FRI, 10), team.a);
    expect((await api("POST", `/api/staff/reservations/${gone.id}/cancel`, { cookie: adminCookie, body: { reason: "x", version: 2 } })).status).toBe(200);
    const old = await confirmed(at(FRI, 11), team.a);
    const { mine } = await urls(techA);
    expect((await raw(mine)).text).toContain(old.ref);
    setNow(at(FRI, 11, 30) + 30 * DAY + 1);
    const later = (await raw(mine)).text;
    expect(later).not.toContain(old.ref);
    expect(later).not.toContain(gone.ref);
  });

  it("moves an appointment from Team to Mine when it is reassigned to me", async () => {
    const r = await confirmed(at(FRI, 10), team.b);
    const { mine, team: teamUrl } = await urls(techA);
    expect((await raw(teamUrl)).text).toContain(r.ref);
    expect((await api("POST", `/api/staff/reservations/${r.id}/reassign`, { cookie: adminCookie, body: { staffId: team.a, version: 2 } })).status).toBe(200);
    expect((await raw(mine)).text).toContain(r.ref);
    expect((await raw(teamUrl)).text).not.toContain(r.ref);
  });

  it("is a well-formed empty calendar when there is nothing to show", async () => {
    const { mine } = await urls(techA);
    const res = await raw(mine);
    expect(res.status).toBe(200);
    expect(res.text.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(res.text.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(res.text).not.toContain("BEGIN:VEVENT");
  });

  it("escapes and folds awkward customer text", async () => {
    const issue = `Line one; with, commas\nLine two 😀 ${"x".repeat(950)}`;
    await confirmed(at(FRI, 10), team.a, issue);
    const res = await raw((await urls(techA)).mine);
    for (const line of res.body.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(res.text).toContain("Line one\\; with\\, commas\\nLine two 😀");
  });

  it("answers HEAD and ignores a query string", async () => {
    const { mine } = await urls(techA);
    expect((await raw(mine, "HEAD")).status).toBe(200);
    expect((await raw(`${mine}?refresh=1`)).status).toBe(200);
  });
});

describe("feed access", () => {
  it("answers an unknown token or kind with a plain-text 404", async () => {
    const { mine } = await urls(techA);
    for (const url of [mine.replace(/\/feed\/[^/]+\//, `/feed/${"x".repeat(43)}/`), mine.replace("mine.ics", "all.ics"), mine.replace("mine.ics", "mine.txt")]) {
      const res = await raw(url);
      expect(res.status, url).toBe(404);
      expect(res.headers.get("content-type")?.toLowerCase()).toBe("text/plain; charset=utf-8");
      expect(res.text).toContain("http://localhost:5173/");
    }
  });

  it("stops serving a deactivated staff member's feeds", async () => {
    const { mine } = await urls(techA);
    await env.DB.prepare("UPDATE staff SET active = 0 WHERE id = ?").bind(team.a).run();
    expect((await raw(mine)).status).toBe(404);
  });

  it("is rate limited per IP", async () => {
    const { mine } = await urls(techA);
    let last = 0;
    for (let i = 0; i < 121; i++) last = (await raw(mine, "GET", "203.0.113.7")).status;
    expect(last).toBe(429);
    expect((await raw(mine, "GET", "203.0.113.8")).status).toBe(200);
  });
});

describe("firstName", () => {
  it("takes the first word, trimmed, and copes with one word or none", () => {
    expect(firstName("Tim Tech")).toBe("Tim");
    expect(firstName("  Una   Tech ")).toBe("Una");
    expect(firstName("Madonna")).toBe("Madonna");
    expect(firstName("")).toBe("—");
    expect(firstName(null)).toBe("—");
  });
});
```

(These tests call `POST /api/staff/calendar-feed`, which Task 3 adds. In this task, Step 3 adds a minimal version of that route so the tests can run; Task 3 adds its own tests, the reset route and the audit entry.)

- [ ] **Step 3: Run the tests to check they fail**

Run: `npx vitest run test/worker/calendar-feeds.test.ts`
Expected: FAIL (module `src/worker/calendar-feeds` not found).

- [ ] **Step 4: Refactor `src/worker/reservations/ics.ts`** so staff events come from rows:

```ts
export interface IcsRow { /* unchanged fields */ }

/** The row every calendar event is built from; callers append their own WHERE (reservation aliased `r`). */
export const ICS_SELECT = `SELECT r.id, r.ref, r.status, r.version, r.start_at, r.end_at, r.confirmed_at, r.phone, r.issue,
        r.contact_name, r.contact_email, c.name AS customer_name, asg.name AS assigned_name
 FROM reservations r
 JOIN customers c ON c.id = r.customer_id
 LEFT JOIN staff asg ON asg.id = r.assigned_staff_id`;

async function loadRow(db: D1Database, id: string): Promise<IcsRow> {
  const row = await db.prepare(`${ICS_SELECT} WHERE r.id = ?`).bind(id).first<IcsRow>();
  if (!row) throw new HttpError(404, "not_found");
  return row;
}

/** The staff event for a row: customer, contact, phone, issue and technician. `summary` overrides the title (feeds). */
export function staffEventFromRow(env: Env, r: IcsRow, summary?: string): IcsEvent {
  const status = eventStatus(r);
  const url = `${baseUrl(env)}/staff/r/${encodeURIComponent(r.id)}`;
  const description = [
    t("ics.reference", { ref: r.ref }),
    t("ics.contact", { name: r.contact_name, email: r.contact_email }),
    t("ics.phone", { phone: r.phone }),
    t("ics.issue", { issue: r.issue }),
    t("ics.technician", { name: r.assigned_name ?? t("common.notSet") }),
    ...(status === "CANCELLED" ? [t("ics.cancelled")] : []),
    t("ics.link", { url }),
  ].join("\n");
  return {
    uid: uidFor(env, r.ref),
    sequence: r.version,
    method: "PUBLISH",
    status,
    startAt: r.start_at,
    endAt: r.end_at,
    stamp: clock.now(),
    summary: summary ?? t("ics.staffSummary", { customer: r.customer_name, ref: r.ref }),
    description,
    url,
  };
}

async function staffEvent(env: Env, reservationId: string): Promise<{ ref: string; event: IcsEvent }> {
  const r = await loadRow(env.DB, reservationId);
  return { ref: r.ref, event: staffEventFromRow(env, r) };
}
```

(`staffEventFromRow` holds exactly the body the old `staffEvent` had, so its output is unchanged.)

- [ ] **Step 5: Add the i18n strings** to `src/shared/i18n/en.ts`, as a new top-level group next to `calendarLink`:

```ts
  /** Staff calendar subscriptions (feeds): calendar names, event titles and the plain-text page for a dead link. */
  calendarFeed: {
    mineName: "{org} — my appointments",
    teamName: "{org} — team",
    mineSummary: "{customer} ({ref})",
    teamSummary: "{tech}: {customer} ({ref})",
    invalid: "This calendar subscription link is not valid any more (it was reset, or its owner no longer has access). Get a new link from the Calendar page at {url}",
  },
```

- [ ] **Step 6: Create `src/worker/calendar-feeds.ts`** with the feed content, token lookup, public routes, and the minimal staff route the tests need:

```ts
import { Hono } from "hono";
import { buildCalendar } from "../domain/ics";
import { t } from "../shared/i18n/i18n";
import type { AppEnv, Env } from "./env";
import { clock } from "./lib/clock";
import { randomToken } from "./lib/crypto";
import { HttpError } from "./lib/http";
import { rateLimit } from "./lib/rate-limit";
import { requireStaff } from "./middleware/session";
import { getSettings } from "./repos/settings";
import { ICS_SELECT, staffEventFromRow, type IcsRow } from "./reservations/ics";

export type FeedKind = "mine" | "team";

const DAY = 86_400_000;
const WINDOW_MS = 15 * 60_000;
const IP_LIMIT = 120;
const TOKEN = /^[A-Za-z0-9_-]{20,200}$/;
const FILE = /^(mine|team)\.ics$/;

const baseUrl = (env: Env) => env.APP_BASE_URL.replace(/\/+$/, "");
export const feedUrl = (env: Env, token: string, kind: FeedKind) => `${baseUrl(env)}/api/feed/${token}/${kind}.ics`;

/** "Tim" from "Tim Tech": the Team calendar's title prefix. */
export const firstName = (name: string | null) => name?.trim().split(/\s+/)[0] || "—";

/** The staff member an active feed token belongs to; a reset token or a deactivated owner reads nothing. */
export async function staffIdForFeedToken(db: D1Database, token: string): Promise<number | null> {
  const row = await db
    .prepare("SELECT f.staff_id FROM calendar_feeds f JOIN staff s ON s.id = f.staff_id WHERE f.token = ? AND s.active = 1")
    .bind(token)
    .first<{ staff_id: number }>();
  return row?.staff_id ?? null;
}

/** Confirmed appointments from 30 days ago on: mine, or everyone else's, as one calendar. */
export async function feedCalendar(env: Env, staffId: number, kind: FeedKind, now: number): Promise<string> {
  const { results } = await env.DB.prepare(
    `${ICS_SELECT} WHERE r.status = 'confirmed' AND r.end_at > ?1 AND r.assigned_staff_id ${kind === "mine" ? "=" : "<>"} ?2 ORDER BY r.start_at, r.id`,
  )
    .bind(now - 30 * DAY, staffId)
    .all<IcsRow>();
  const s = await getSettings(env.DB, env);
  const events = results.map((r) =>
    staffEventFromRow(
      env,
      r,
      kind === "mine"
        ? t("calendarFeed.mineSummary", { customer: r.customer_name, ref: r.ref })
        : t("calendarFeed.teamSummary", { tech: firstName(r.assigned_name), customer: r.customer_name, ref: r.ref }),
    ),
  );
  return buildCalendar({ name: t(kind === "mine" ? "calendarFeed.mineName" : "calendarFeed.teamName", { org: s.orgName }), events });
}

/** `/api/feed/<token>/{mine,team}.ics`: polled by calendar apps, so failures are plain text for a person who opens one. */
export const feedRoutes = new Hono<AppEnv>();

feedRoutes.get("/:token/:file", async (c) => {
  const ip = c.req.header("cf-connecting-ip");
  if (ip && !(await rateLimit(c.env.DB, `feed:ip:${ip}`, IP_LIMIT, WINDOW_MS))) throw new HttpError(429, "rate_limited");
  const token = c.req.param("token");
  const kind = FILE.exec(c.req.param("file"))?.[1] as FeedKind | undefined;
  const staffId = kind && TOKEN.test(token) ? await staffIdForFeedToken(c.env.DB, token) : null;
  if (!kind || staffId === null) return c.text(t("calendarFeed.invalid", { url: `${baseUrl(c.env)}/` }), 404);
  return c.body(await feedCalendar(c.env, staffId, kind, clock.now()), 200, {
    "Content-Type": "text/calendar; charset=utf-8",
    "Content-Disposition": `inline; filename="${kind}.ics"`,
    "Cache-Control": "no-store",
  });
});

/** The caller's token, created on first use. INSERT OR IGNORE makes a race between two tabs end with one token. */
export async function ensureFeedToken(db: D1Database, staffId: number): Promise<string> {
  await db.prepare("INSERT OR IGNORE INTO calendar_feeds(staff_id, token, created_at) VALUES (?, ?, ?)").bind(staffId, randomToken(), clock.now()).run();
  const row = await db.prepare("SELECT token FROM calendar_feeds WHERE staff_id = ?").bind(staffId).first<{ token: string }>();
  return row!.token;
}

/** Staff session routes for the subscribe card (mounted under /api/staff). */
export const staffFeedRoutes = new Hono<AppEnv>();
staffFeedRoutes.use("*", requireStaff());

/** A POST, since the first call creates the token (no GET changes state). */
staffFeedRoutes.post("/calendar-feed", async (c) => {
  const token = await ensureFeedToken(c.env.DB, c.var.staff!.id);
  return c.json({ mine: feedUrl(c.env, token, "mine"), team: feedUrl(c.env, token, "team") });
});
```

Mount both in `src/worker/app.ts`: `import { feedRoutes, staffFeedRoutes } from "./calendar-feeds";`, then `app.route("/feed", feedRoutes);` after the `/cal` line and `app.route("/staff", staffFeedRoutes);` after `app.route("/staff", opsRoutes);`.

- [ ] **Step 7: Run the tests**

Run: `npm run typecheck && npx vitest run test/worker/calendar-feeds.test.ts test/worker/ics.test.ts test/domain/ics.test.ts && npm run test:scripts`
Expected: all PASS. If the HEAD case fails because Hono's GET doesn't answer HEAD in this version, add `feedRoutes.on("HEAD", "/:token/:file", …)` sharing the same handler (and the same check), returning the headers with an empty body.

- [ ] **Step 8: Commit**

```bash
git add migrations/0008_calendar_feeds.sql src/worker/calendar-feeds.ts src/worker/reservations/ics.ts src/worker/app.ts src/shared/i18n/en.ts scripts/seed-dev.mjs scripts/seed-dev.test.mjs test/worker/calendar-feeds.test.ts
git commit -m "feat(feeds): staff calendar subscriptions, mine and team (migration 0008)"
```

---

### Task 3: Feed links for the session, and reset

**Files:**
- Modify: `src/worker/calendar-feeds.ts`, `src/web/pages/staff/Activity.tsx`, `src/shared/i18n/en.ts`
- Test: `test/worker/calendar-feeds.test.ts` (append)

**Interfaces:**
- Consumes: `ensureFeedToken`, `feedUrl`, `staffFeedRoutes` (Task 2); `audit(db, {...})` from `src/worker/lib/db.ts`; `randomToken`.
- Produces: `POST /api/staff/calendar-feed/reset` → `{ mine: string; team: string }`, and audit action `calendar_feed.reset`.

- [ ] **Step 1: Write the failing tests** (append to `test/worker/calendar-feeds.test.ts`):

```ts
describe("subscription links for staff", () => {
  it("are created once and then stay the same, even when two tabs ask at once", async () => {
    const [a, b] = await Promise.all([urls(techA), urls(techA)]);
    expect(a).toEqual(b);
    expect(await urls(techA)).toEqual(a);
    expect(a.mine).toMatch(/^http:\/\/localhost:5173\/api\/feed\/[A-Za-z0-9_-]{43}\/mine\.ics$/);
    expect(a.team).toBe(a.mine.replace("mine.ics", "team.ics"));
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM calendar_feeds").first("n")).toBe(1);
  });

  it("differ per staff member", async () => {
    expect((await urls(techA)).mine).not.toBe((await urls(adminCookie)).mine);
  });

  it("reset gives new links, the old ones stop, and the reset is in the activity log", async () => {
    const before = await urls(techA);
    const res = await api("POST", "/api/staff/calendar-feed/reset", { cookie: techA, body: {} });
    expect(res.status).toBe(200);
    expect(res.json.mine).not.toBe(before.mine);
    expect((await raw(before.mine)).status).toBe(404);
    expect((await raw(res.json.mine)).status).toBe(200);
    expect(await urls(techA)).toEqual(res.json);
    const a = await env.DB.prepare("SELECT actor_kind, actor, action FROM audit_log WHERE action = 'calendar_feed.reset'").first();
    expect(a).toEqual({ actor_kind: "staff", actor: String(team.a), action: "calendar_feed.reset" });
  });

  it("reset works before any link was made", async () => {
    const res = await api("POST", "/api/staff/calendar-feed/reset", { cookie: techA, body: {} });
    expect(res.status).toBe(200);
    expect((await raw(res.json.mine)).status).toBe(200);
  });

  it("need a staff session and the CSRF header", async () => {
    expect((await api("POST", "/api/staff/calendar-feed", { body: {} })).status).toBe(401);
    expect((await api("POST", "/api/staff/calendar-feed", { cookie: pat.cookie, body: {} })).status).toBe(401);
    expect((await api("POST", "/api/staff/calendar-feed", { cookie: techA, body: {}, xrw: false })).status).toBe(403);
    expect((await api("POST", "/api/staff/calendar-feed/reset", { body: {} })).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the tests to check they fail**

Run: `npx vitest run test/worker/calendar-feeds.test.ts -t "subscription links"`
Expected: FAIL on the reset cases (404 `not_found`).

- [ ] **Step 3: Implement reset** in `src/worker/calendar-feeds.ts`, after the existing POST route. Add `import { audit } from "./lib/db";`:

```ts
/** New links; calendars subscribed with the old ones stop updating. Recorded in the activity log. */
staffFeedRoutes.post("/calendar-feed/reset", async (c) => {
  const staff = c.var.staff!;
  const token = randomToken();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO calendar_feeds(staff_id, token, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(staff_id) DO UPDATE SET token = ?2, created_at = ?3",
    ).bind(staff.id, token, clock.now()),
    audit(c.env.DB, { actorKind: "staff", actor: String(staff.id), action: "calendar_feed.reset" }),
  ]);
  return c.json({ mine: feedUrl(c.env, token, "mine"), team: feedUrl(c.env, token, "team") });
});
```

- [ ] **Step 4: Describe the audit entry in the Activity page.** In `src/web/pages/staff/Activity.tsx`, `describe()`, add next to `case "staff.create":`:

```ts
    case "calendar_feed.reset":
      return { key: "calendar_feed_reset", params: {} };
```

In `src/shared/i18n/en.ts`, under `web.staff.activity.events` (next to `staff_create`), add:

```ts
          calendar_feed_reset: "{actor} reset their calendar subscription links",
```

- [ ] **Step 5: Run the tests**

Run: `npm run typecheck && npx vitest run test/worker/calendar-feeds.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/worker/calendar-feeds.ts src/web/pages/staff/Activity.tsx src/shared/i18n/en.ts test/worker/calendar-feeds.test.ts
git commit -m "feat(feeds): reset subscription links, recorded in the activity log"
```

---

### Task 4: Subscribe card on the staff Calendar page, docs, end-to-end

**Files:**
- Create: `src/web/pages/staff/calendar/SubscribeCard.tsx`
- Modify: `src/web/pages/staff/Calendar.tsx`, `src/shared/i18n/en.ts`, `README.md`, `docs/SETUP.md`
- Test: `e2e/lifecycle.spec.ts` (append)

**Interfaces:**
- Consumes: `POST /api/staff/calendar-feed` and `POST /api/staff/calendar-feed/reset` → `{ mine, team }` (Tasks 2–3); `apiFetch`, `Button`, `Card`, `Notice`, `Dialog` from `src/web/components`.
- Produces: `export function SubscribeCard()`, rendered on `/staff/calendar` under the filters.

- [ ] **Step 1: Strings.** In `src/shared/i18n/en.ts`, under `web.staff.calendar`, add:

```ts
        subscribe: {
          heading: "Subscribe in your calendar app",
          lead: "Two calendars that keep themselves up to date: your own appointments, and the rest of the team's. Confirmed appointments only.",
          mine: "My appointments",
          team: "Team (everyone else)",
          google: "Add to Google Calendar",
          webcal: "Open in Apple Calendar / Outlook",
          copy: "Copy link",
          copied: "Link copied.",
          copyFailed: "Couldn't copy. Select the link and copy it yourself:",
          note: "Google Calendar refreshes subscriptions on its own schedule, which can take several hours; Apple Calendar and Outlook usually update within an hour. The app and emails are always current. Once subscribed, you no longer need the per-appointment \"Add to calendar\" downloads.",
          privacy: "The links include customer contact details: keep them to yourself.",
          reset: "Reset links",
          resetTitle: "Reset your subscription links?",
          resetBody: "Your current links stop working. Calendars subscribed with them stop updating; subscribe again with the new links.",
          resetConfirm: "Reset links",
          cancel: "Cancel",
          resetDone: "New links are ready. Subscribe again with them.",
          loading: "Getting your links…",
        },
```

- [ ] **Step 2: Create `src/web/pages/staff/calendar/SubscribeCard.tsx`:**

```tsx
import { useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../../../api";
import { Button } from "../../../components/Button";
import { Card, Notice } from "../../../components/Card";
import { Dialog } from "../../../components/Dialog";
import { Skeleton } from "../../../components/Spinner";
import { t } from "../../../i18n";

type FeedUrls = { mine: string; team: string };
const k = (key: string) => t(`web.staff.calendar.subscribe.${key}`);
const KEY = ["staff", "calendar-feed"] as const;
const SEEN = "calendar-subscribe-seen";

const webcal = (url: string) => url.replace(/^https?:/, "webcal:");
const google = (url: string) => `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal(url))}`;

function seenBefore(): boolean {
  try {
    return localStorage.getItem(SEEN) === "1";
  } catch {
    return false;
  }
}

/** Open on the first visit, collapsed afterwards; the links are fetched (and created) only once it is opened. */
export function SubscribeCard() {
  const [open, setOpen] = useState(() => !seenBefore());
  const remember = (next: boolean) => {
    setOpen(next);
    try {
      localStorage.setItem(SEEN, "1");
    } catch {
      // Private mode: the card simply opens again next time.
    }
  };
  const q = useQuery({ queryKey: KEY, queryFn: () => apiFetch<FeedUrls>("/api/staff/calendar-feed", { method: "POST", body: {} }), enabled: open, staleTime: Infinity });
  return (
    <Card className="space-y-4">
      <details open={open} onToggle={(e) => remember((e.target as HTMLDetailsElement).open)}>
        <summary className="flex min-h-11 cursor-pointer items-center text-lg font-semibold">{k("heading")}</summary>
        <div className="mt-3 space-y-4">
          <p className="text-slate-600 dark:text-slate-400">{k("lead")}</p>
          {q.isPending ? (
            <div aria-busy="true" className="space-y-3">
              <span className="sr-only">{k("loading")}</span>
              <Skeleton className="h-24" />
              <Skeleton className="h-24" />
            </div>
          ) : q.isError ? (
            <Notice tone="error" className="flex flex-wrap items-center justify-between gap-3">
              {t("web.errors.generic")}
              <Button variant="secondary" onClick={() => void q.refetch()}>
                {t("web.common.retry")}
              </Button>
            </Notice>
          ) : (
            <>
              <FeedRow label={k("mine")} url={q.data.mine} />
              <FeedRow label={k("team")} url={q.data.team} />
              <p className="text-sm text-slate-600 dark:text-slate-400">{k("note")}</p>
              <p className="text-sm font-medium">{k("privacy")}</p>
              <ResetLinks />
            </>
          )}
        </div>
      </details>
    </Card>
  );
}

function FeedRow({ label, url }: { label: string; url: string }) {
  const [copy, setCopy] = useState<"idle" | "done" | "failed">("idle");
  const inputId = useId();
  const doCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopy("done");
    } catch {
      setCopy("failed");
    }
  };
  return (
    <section className="space-y-2 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
      <h3 className="font-semibold">{label}</h3>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <a href={google(url)} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center justify-center rounded-xl bg-blue-700 px-4 font-semibold text-white hover:bg-blue-800 dark:bg-blue-600">
          {k("google")}
        </a>
        <a href={webcal(url)} className="inline-flex min-h-11 items-center justify-center rounded-xl border border-slate-300 bg-white px-4 font-semibold hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-900 dark:hover:bg-slate-800">
          {k("webcal")}
        </a>
        <Button variant="secondary" onClick={() => void doCopy()}>
          {k("copy")}
        </Button>
      </div>
      <div aria-live="polite">
        {copy === "done" && <p className="text-sm text-green-800 dark:text-green-300">{k("copied")}</p>}
        {copy === "failed" && (
          <div className="space-y-1">
            <label htmlFor={inputId} className="text-sm">{k("copyFailed")}</label>
            <input id={inputId} readOnly value={url} onFocus={(e) => e.target.select()} className="block w-full rounded-lg border border-slate-300 px-2 py-1 font-mono text-xs dark:border-slate-600 dark:bg-slate-900" />
          </div>
        )}
      </div>
    </section>
  );
}

function ResetLinks() {
  const qc = useQueryClient();
  const [asking, setAsking] = useState(false);
  const titleId = useId();
  const bodyId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const reset = useMutation({
    mutationFn: () => apiFetch<FeedUrls>("/api/staff/calendar-feed/reset", { method: "POST", body: {} }),
    onSuccess: (urls) => {
      qc.setQueryData(KEY, urls);
      setAsking(false);
    },
  });
  return (
    <div className="space-y-2">
      <Button variant="ghost" className="-ml-3" onClick={() => setAsking(true)}>
        {k("reset")}
      </Button>
      <div aria-live="polite">{reset.isSuccess && <Notice tone="success">{k("resetDone")}</Notice>}</div>
      <Dialog open={asking} onClose={() => setAsking(false)} closable={!reset.isPending} labelledBy={titleId} describedBy={bodyId} initialFocus={cancelRef}>
        <div className="space-y-4">
          <h2 id={titleId} className="text-lg font-semibold">{k("resetTitle")}</h2>
          <p id={bodyId}>{k("resetBody")}</p>
          {reset.isError && <Notice tone="error">{t("web.errors.generic")}</Notice>}
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button ref={cancelRef} variant="secondary" onClick={() => setAsking(false)} disabled={reset.isPending}>
              {k("cancel")}
            </Button>
            <Button variant="danger" loading={reset.isPending} onClick={() => reset.mutate()}>
              {k("resetConfirm")}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
```

- [ ] **Step 3: Render the card** in `src/web/pages/staff/Calendar.tsx`, directly after the filter grid's closing `</div>` (the grid with the Technician select and the Show fieldset):

```tsx
import { SubscribeCard } from "./calendar/SubscribeCard";
// …
        <SubscribeCard />
```

- [ ] **Step 4: Write the end-to-end test** (append to `e2e/lifecycle.spec.ts`, which uses the admin session):

```ts
test("staff subscribe to their calendars from the Calendar page, and reset the links", async ({ page }) => {
  await page.goto("/staff/calendar");
  // Open on the first visit, collapsed afterwards: open it if needed.
  if (!(await page.getByRole("link", { name: "Add to Google Calendar" }).first().isVisible())) await page.getByText("Subscribe in your calendar app").click();
  const google = page.getByRole("link", { name: "Add to Google Calendar" });
  await expect(google).toHaveCount(2);
  await expect(google.first()).toHaveAttribute("href", /^https:\/\/calendar\.google\.com\/calendar\/r\?cid=webcal%3A%2F%2F/);
  const webcalHref = await page.getByRole("link", { name: "Open in Apple Calendar / Outlook" }).first().getAttribute("href");
  expect(webcalHref).toMatch(/^webcal:\/\/.+\/api\/feed\/[A-Za-z0-9_-]+\/mine\.ics$/);
  const mineUrl = webcalHref!.replace(/^webcal:/, "http:");
  const feed = await page.request.get(mineUrl);
  expect(feed.status()).toBe(200);
  expect(await feed.text()).toContain("— my appointments");

  await page.getByRole("button", { name: "Reset links" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Reset links" }).click();
  await expect(page.getByText("New links are ready. Subscribe again with them.")).toBeVisible();
  const newHref = await page.getByRole("link", { name: "Open in Apple Calendar / Outlook" }).first().getAttribute("href");
  expect(newHref).not.toBe(webcalHref);
  expect((await page.request.get(mineUrl)).status()).toBe(404);
});
```

- [ ] **Step 5: Docs.**
  - `README.md`, "Implemented now": add the line `- Staff calendar subscriptions: each staff member subscribes once (Google, Apple Calendar, Outlook) to two live calendars, their own appointments and the rest of the team's (confirmed appointments only).`
  - Remove "calendar subscriptions" from the README's "Out of scope" sentence and replace it with "customer calendar subscriptions".
  - `docs/SETUP.md`, after the paragraph about "Add to calendar": add a paragraph on staff subscriptions. It explains the Calendar page card; Google's slow refresh; that the links carry customer contact details; that **Reset links** (or deactivating the person) stops a leaked link; and that feed tokens are stored in plain text by design so links can be shown again.

- [ ] **Step 6: Verify everything**

Run:
```bash
npm run typecheck && npm test && npm run test:scripts && npm run build
SP=/tmp/claude-1000/-home-askar-code-booking-app/73c26db3-792f-441f-8db2-459abb8206a2/scratchpad   # the session scratchpad
cp -a .wrangler/state $SP/wrangler-state-backup-feeds
npx playwright test
rm -rf .wrangler/state && cp -a $SP/wrangler-state-backup-feeds .wrangler/state
```
Expected: all green, including the new e2e on desktop and mobile. Then look at the card in a screenshot (a temporary Playwright script, as earlier in this project) on desktop and mobile widths, and delete the script.

- [ ] **Step 7: Commit**

```bash
git add src/web/pages/staff/calendar/SubscribeCard.tsx src/web/pages/staff/Calendar.tsx src/shared/i18n/en.ts README.md docs/SETUP.md e2e/lifecycle.spec.ts
git commit -m "feat(web): subscribe card on the staff calendar; docs"
```
