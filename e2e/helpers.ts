import { expect, type APIRequestContext, type Page } from "@playwright/test";

/** The dev server the e2e runs against (playwright.config.ts); API writes must come from this origin. */
export const BASE_URL = "http://localhost:5173";
/** Storage state with the sample administrator's session, written by e2e/global-setup.mjs. */
export const ADMIN_STATE = "test-results/.auth/admin.json";
const WRITE_HEADERS = { Origin: BASE_URL, "X-Requested-With": "fetch" };

/** Open the dev mailbox and the newest message to `to` whose subject matches; returns the email's preview frame. */
export async function openEmail(page: Page, to: string, subject: RegExp) {
  await page.goto("/dev/mail");
  await expect(page.getByText("Development mailbox — emails are not sent")).toBeVisible();
  const item = devMailMessages(page, to, subject).first();
  await expect(item).toBeVisible();
  await item.click();
  return page.frameLocator('iframe[title^="Email preview"]:visible');
}

/** Open the dev mailbox, pick the newest message to `to` whose subject matches, and click `linkName` inside the email. */
export async function followEmailLink(page: Page, to: string, subject: RegExp, linkName: string | RegExp) {
  const email = await openEmail(page, to, subject);
  await email.getByRole("link", { name: linkName }).click();
}

/** The dev mailbox's messages to `to` whose subject matches, newest first. */
export function devMailMessages(page: Page, to: string, subject: RegExp) {
  return page.getByRole("list", { name: "Messages" }).getByRole("button").filter({ hasText: to }).filter({ hasText: subject });
}

// ---- API helpers for arranging data. The behaviour under test is always driven through the UI. ------------------

/** JSON from a request that must succeed. */
async function ok<T>(res: Awaited<ReturnType<APIRequestContext["get"]>>): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

export const apiGet = async <T>(req: APIRequestContext, path: string): Promise<T> => ok<T>(await req.get(path));
export const apiPost = async <T>(req: APIRequestContext, path: string, data: unknown): Promise<T> =>
  ok<T>(await req.post(path, { data, headers: WRITE_HEADERS }));

interface DevMessage {
  id: number;
  to: string;
  subject: string;
  text: string;
}

/**
 * The dev mailbox's messages, newest first. The route returns only the newest 50 rows, so anything older is not seen:
 * counts made through this (countMail, countMailAnyone) are of those 50 only.
 */
const devMail = async (req: APIRequestContext) => (await apiGet<{ messages: DevMessage[] }>(req, "/api/dev/mail")).messages;

/** How many of the dev mailbox's (newest 50) messages are to `to` with a subject matching `subject`. */
export const countMail = async (req: APIRequestContext, to: string, subject: RegExp) =>
  (await devMail(req)).filter((m) => m.to === to && subject.test(m.subject)).length;

/** How many of the dev mailbox's (newest 50) messages have a subject matching `subject`, to anyone. */
export const countMailAnyone = async (req: APIRequestContext, subject: RegExp) => (await devMail(req)).filter((m) => subject.test(m.subject)).length;

/** Run the cron sweeps as of `now` (default: the real clock), then send what the outbox has due (dev-only route). */
export const runCron = async (req: APIRequestContext, now?: number) =>
  apiPost<{ counts: Record<string, number | null>; failed: string[] }>(req, "/api/dev/cron", now === undefined ? {} : { now });

/**
 * Sign `email` in through its emailed magic link, entirely over the API: the session cookie lands in `req`'s cookie
 * jar (for `page.request` that is the browser context, so the pages are signed in too).
 */
export async function signIn(req: APIRequestContext, kind: "customer" | "staff", email: string) {
  const after = (await devMail(req))[0]?.id ?? 0;
  await apiPost(req, `/api/auth/${kind}/request`, { email });
  let token: string | undefined;
  await expect
    .poll(
      async () => {
        const mail = (await devMail(req)).find((m) => m.id > after && m.to === email);
        token = mail?.text.match(/#t=([A-Za-z0-9_-]+)/)?.[1];
        return token;
      },
      { message: `sign-in link for ${email}`, timeout: 30_000 },
    )
    .toBeTruthy();
  await apiPost(req, "/api/auth/redeem", { token });
}

interface Slot {
  startAt: number;
  endAt: number;
}

/** The bookable slots of the next two weeks, earliest first, as the signed-in customer sees them. */
export async function availableSlots(req: APIRequestContext): Promise<{ timezone: string; slots: Slot[] }> {
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
  const { timezone, days } = await apiGet<{ timezone: string; days: Array<{ date: string; slots: Slot[] }> }>(
    req,
    `/api/customer/availability?from=${from}&to=${to}`,
  );
  return { timezone, slots: days.flatMap((d) => d.slots) };
}

/** Weekday (0 = Sunday) and minute of the day of `at` in `timezone`. */
export function wallTime(at: number, timezone: string): { weekday: number; minute: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday!);
  return { weekday, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

/** A customer account with one contact; returns nothing (the number and email identify it). */
export async function createCustomer(admin: APIRequestContext, customerNumber: string, name: string, email: string, contactName: string) {
  await apiPost(admin, "/api/staff/customers", { customerNumber, name, contacts: [{ email, name: contactName }] });
}

/**
 * The signed-in customer requests `slot` for their account numbered `customerNumber` (default: their first account).
 * Returns the reservation id and reference.
 */
export async function requestSlot(
  customer: APIRequestContext,
  startAt: number,
  contactName: string,
  customerNumber?: string,
): Promise<{ id: string; ref: string }> {
  const { accounts } = await apiGet<{ accounts: Array<{ id: number; customerNumber: string }> }>(customer, "/api/customer/accounts");
  const account = customerNumber === undefined ? accounts[0] : accounts.find((a) => a.customerNumber === customerNumber);
  expect(account, `the customer account ${customerNumber ?? ""}`).toBeTruthy();
  const { reservation } = await apiPost<{ reservation: { id: string; ref: string } }>(customer, "/api/customer/reservations", {
    customerId: account!.id,
    startAt,
    contactName,
    phone: "+1 555 0100",
    issue: "Set up by the end-to-end test.",
    idempotencyKey: crypto.randomUUID(),
  });
  return reservation;
}

export interface StaffReservation {
  id: string;
  ref: string;
  status: string;
  version: number;
  startAt: number;
  endAt: number;
  expiresAt: number | null;
  provisionalStaffId: number | null;
  closeReason: string | null;
  replacedById: string | null;
  proposal: {
    id: string;
    status: string;
    options: Array<{ id: string; startAt: number; endAt: number; staffId: number }>;
  } | null;
}

/** A reservation as staff see it (the API behind the request page). */
export const staffReservation = async (admin: APIRequestContext, id: string) =>
  (await apiGet<{ reservation: StaffReservation }>(admin, `/api/staff/reservations/${id}`)).reservation;

/** Approve a pending request with `staffId` (default: the technician it is provisionally held by). */
export async function approve(admin: APIRequestContext, id: string, staffId?: number) {
  const r = await staffReservation(admin, id);
  await apiPost(admin, `/api/staff/reservations/${id}/approve`, { staffId: staffId ?? r.provisionalStaffId, version: r.version });
}

/**
 * Cancel a reservation if it is still pending or confirmed (clean-up: a confirmed appointment left at the first bookable
 * time keeps its technician busy for the tests that follow, which book that time too). Open proposals go with it.
 */
export async function cancelIfOpen(admin: APIRequestContext, id: string) {
  const r = await staffReservation(admin, id);
  if (r.status === "pending" || r.status === "confirmed")
    await apiPost(admin, `/api/staff/reservations/${id}/cancel`, { reason: "End-to-end test clean-up.", version: r.version });
}

/**
 * Propose `count` other times for a reservation: the first time that can be proposed on each of the first `count`
 * days that have one (different days, so the times never overlap), each with its first free technician.
 */
export async function proposeTimes(admin: APIRequestContext, id: string, count: number) {
  const r = await staffReservation(admin, id);
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 13 * 86_400_000).toISOString().slice(0, 10);
  const { days } = await apiGet<{ days: Array<{ slots: Array<{ startAt: number; staff: Array<{ id: number }> }> }> }>(
    admin,
    `/api/staff/reservations/${id}/proposal-candidates?from=${from}&to=${to}`,
  );
  const options = days
    .filter((d) => d.slots.length > 0)
    .slice(0, count)
    .map((d) => ({ startAt: d.slots[0]!.startAt, staffId: d.slots[0]!.staff[0]!.id }));
  expect(options.length, `${count} days with times that can be proposed`).toBe(count);
  await apiPost(admin, `/api/staff/reservations/${id}/propose`, { options, version: r.version });
}

/** Turn online booking on (or off) if it isn't already. */
export async function setBookingEnabled(admin: APIRequestContext, enabled: boolean) {
  const me = await apiGet<{ bookingEnabled: boolean }>(admin, "/api/auth/me");
  if (me.bookingEnabled !== enabled) await apiPost(admin, "/api/staff/settings/booking", { enabled });
}
