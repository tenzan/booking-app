import { expect, test, type Cookie, type Download, type Locator, type Page } from "@playwright/test";
import { fmtWhen } from "../src/web/format";
import {
  ADMIN_STATE,
  apiGet,
  approve,
  availableSlots,
  cancelIfOpen,
  countMail,
  countMailAnyone,
  createCustomer,
  devMailMessages,
  followEmailLink,
  openEmail,
  proposeTimes,
  requestSlot,
  runCron,
  signIn,
  staffReservation,
} from "./helpers";

/**
 * The reservation lifecycle after booking: the customer cancels, answers a proposal of other times, asks for another
 * time themselves, a request expires, and the calendar file. Each test arranges its own customer account and reservation
 * over the API (named after the test and the project, so the desktop and phone runs share nothing) and drives the
 * behaviour through the UI; assertions go by the test's own reservation references.
 * Staff steps use the sample administrator's session; the customer side uses the emailed links or a customer session
 * in the same browser.
 */
test.use({ storageState: ADMIN_STATE });

/** "Desktop" / "Mobile": makes names and addresses unique per project. */
const projectTag = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The reservations this test created; whatever is still open is cancelled after it (see `cancelIfOpen`). */
let created: string[] = [];
test.beforeEach(() => {
  created = [];
});
test.afterEach(async ({ page }) => {
  for (const id of created) await cancelIfOpen(page.request, id);
});

interface Arranged {
  id: string;
  ref: string;
  email: string;
}

/** The project's lifecycle contact: one address for all tests here, each with an account of its own. */
const contactEmail = (project: string) => `lifecycle-${project}@example.test`;
/** Its session cookie, per address: signed in once per worker (sign-in links are rate limited per address and per IP). */
const sessions = new Map<string, Cookie[]>();

/**
 * A customer account of this test's own, with the project's lifecycle contact signed in in this browser, and one
 * request for the first bookable time; approved (by its provisional technician) unless `pending`.
 */
async function arrange(page: Page, project: string, label: string, opts: { pending?: boolean; email?: string } = {}): Promise<Arranged> {
  const tag = projectTag(project);
  const api = page.request;
  // A contact of its own gets its own allowance of booking requests per hour (the shared one is near its limit).
  const email = opts.email ?? contactEmail(project);
  const contact = `Lee ${tag}`;
  const number = `E2E-${label.toUpperCase()}-${tag.toUpperCase()}`;
  await createCustomer(api, number, `${label} clinic ${tag}`, email, contact);
  const session = sessions.get(email);
  if (session) await page.context().addCookies(session);
  else {
    await signIn(api, "customer", email);
    sessions.set(email, (await page.context().cookies()).filter((c) => c.name === "__Host-cust"));
  }
  const { slots } = await availableSlots(api);
  expect(slots.length, "a bookable time").toBeGreaterThan(0);
  const { id, ref } = await requestSlot(api, slots[0]!.startAt, contact, number);
  created.push(id);
  if (!opts.pending) await approve(api, id);
  return { id, ref, email };
}

/**
 * A reservation's card on My reservations, found by the reference on its (always visible) expand button: a collapsed
 * card's details can mention other references.
 */
const myCard = (page: Page, ref: string, scope: Page | Locator = page) =>
  scope.getByRole("listitem").filter({ has: page.getByRole("button", { name: new RegExp(`${escapeRe(ref)}(?![\\w-])`) }) });

/** Save the download `click` starts; returns its file name and text. */
async function download(page: Page, click: () => Promise<void>): Promise<{ name: string; text: string }> {
  const [file] = await Promise.all([page.waitForEvent("download"), click()]);
  return { name: file.suggestedFilename(), text: await readDownload(file) };
}

async function readDownload(file: Download): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of (await file.createReadStream()) as AsyncIterable<Uint8Array>) text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

test("customer cancels from the email link; staff and team see it cancelled", async ({ page }, testInfo) => {
  const { id, ref, email } = await arrange(page, testInfo.project.name, "selfcancel");
  const reason = "The problem solved itself.";

  // ---- the confirmation email's "Cancel reservation" opens the cancel dialog on the link page
  await followEmailLink(page, email, new RegExp(`Confirmed: .*\\(${ref}\\)`), "Cancel reservation");
  // The token is taken out of the address bar as soon as the page has read it.
  await expect(page).toHaveURL(/\/r$/);
  const dialog = page.getByRole("dialog", { name: "Cancel this reservation?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(ref, { exact: true })).toBeVisible();
  await dialog.getByLabel("Reason (optional)").fill(reason);
  await dialog.getByRole("button", { name: "Yes, cancel it" }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByText("Your reservation has been cancelled. We've emailed you a confirmation.")).toBeVisible();
  await expect(page.getByText("Cancelled", { exact: true })).toBeVisible();
  await expect(page.getByText("This reservation was cancelled.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel reservation" })).toHaveCount(0);

  // ---- staff see it cancelled by the customer, with the reason
  await page.goto(`/staff/r/${id}`);
  await expect(page.getByRole("heading", { name: `Request ${ref}` })).toBeVisible();
  await expect(page.getByText(`Cancelled by the customer (${email}) on `)).toBeVisible();
  await expect(page.getByText(`“${reason}”`)).toBeVisible();
  await expect(page.getByRole("group", { name: "Actions" })).toHaveCount(0);

  // ---- the team was emailed, and so was the customer
  await page.goto("/dev/mail");
  await expect(page.getByText("Development mailbox — emails are not sent")).toBeVisible();
  const teamMail = page.getByRole("list", { name: "Messages" }).getByRole("button").filter({ hasText: new RegExp(`${ref} cancelled — `) });
  await expect(teamMail.first()).toBeVisible();
  await expect(devMailMessages(page, email, new RegExp(`Cancelled: remote support on .*\\(${ref}\\)`))).toHaveCount(1);
});

test("opening an emailed cancel, time or keep link changes nothing until the customer confirms", async ({ page }, testInfo) => {
  const { id, ref, email } = await arrange(page, testInfo.project.name, "noautopost");
  const api = page.request;
  await proposeTimes(api, id, 2);
  const before = await staffReservation(api, id);
  expect(before.status).toBe("confirmed");
  expect(before.proposal?.status).toBe("open");

  // Any answer the page sent by itself would be one of these POSTs.
  const answers: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && /\/(cancel|accept|reject)$/.test(new URL(req.url()).pathname)) answers.push(req.url());
  });
  const unchanged = async () => {
    const now = await staffReservation(api, id);
    expect(now.status).toBe(before.status);
    expect(now.version).toBe(before.version);
    expect(now.startAt).toBe(before.startAt);
    expect(now.proposal?.id).toBe(before.proposal!.id);
    expect(now.proposal?.status).toBe("open");
    expect(answers).toEqual([]);
  };

  // ---- cancel link: the dialog asks, nothing is cancelled
  await followEmailLink(page, email, new RegExp(`Confirmed: .*\\(${ref}\\)`), "Cancel reservation");
  await expect(page.getByRole("dialog", { name: "Cancel this reservation?" })).toBeVisible();
  await unchanged();

  // ---- a proposed time's link: the confirm step asks, the time is not taken
  const proposal = new RegExp(`Please choose a new time for your remote support \\(${ref}\\)`);
  await (await openEmail(page, email, proposal)).getByRole("link", { name: /^Choose (?!another time$)/ }).first().click();
  await expect(page.getByRole("heading", { name: "Confirm your new time" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm this time" })).toBeVisible();
  await unchanged();

  // ---- "keep my original time": the confirm step asks, the proposal stays open
  await followEmailLink(page, email, proposal, "Keep my original time");
  await expect(page.getByRole("heading", { name: "Keep your original time?" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Yes, keep my time" })).toBeVisible();
  await unchanged();
});

test("staff propose two times; the customer picks one from the email and it is confirmed", async ({ page }, testInfo) => {
  const { id, ref, email } = await arrange(page, testInfo.project.name, "accept");

  // ---- staff propose two times on different days from the request page
  await page.goto(`/staff/r/${id}`);
  await expect(page.getByRole("heading", { name: `Request ${ref}` })).toBeVisible();
  await page.getByRole("group", { name: "Actions" }).getByRole("button", { name: "Propose another time" }).click();
  await expect(page.getByRole("heading", { name: "Propose another time" })).toBeVisible();
  const daysWithTimes = page.getByRole("list", { name: "Dates to choose from" }).getByRole("button", { name: /, (\d+ times|1 time)/, disabled: false });
  const times = page.getByRole("region", { name: /^Times on / });
  await times.getByRole("button").first().click();
  await expect(page.getByRole("heading", { name: "Times to offer (1 of 3)" })).toBeVisible();
  await daysWithTimes.nth(1).click();
  await times.getByRole("button", { pressed: false }).first().click();
  await expect(page.getByRole("heading", { name: "Times to offer (2 of 3)" })).toBeVisible();
  await page.getByRole("button", { name: "Send proposal" }).click();
  await expect(page.getByText("Proposal sent. The customer has been emailed 2 times to choose from.")).toBeVisible();
  const card = page.getByRole("region", { name: "Proposed times" });
  await expect(card.getByText("Waiting for the customer")).toBeVisible();
  const proposed = await staffReservation(page.request, id);
  expect(proposed.proposal?.options).toHaveLength(2);

  // ---- the customer opens the first time from the email and confirms it
  const email1 = await openEmail(page, email, new RegExp(`Please choose a new time for your remote support \\(${ref}\\)`));
  const link = email1.getByRole("link", { name: /^Choose (?!another time$)/ }).first();
  const optionId = new URLSearchParams(new URL((await link.getAttribute("href"))!).hash.slice(1)).get("option");
  await link.click();
  await expect(page.getByRole("heading", { name: "Confirm your new time" })).toBeVisible();
  const option = proposed.proposal!.options.find((o) => o.id === optionId);
  expect(option, "the emailed time is one of the proposed ones").toBeTruthy();
  const body = (await page.getByText(/^Your appointment will be confirmed for /).textContent())!;
  const when = body.match(/^Your appointment will be confirmed for (.+)\. The other times we offered will be released\.$/)![1]!;
  await page.getByRole("button", { name: "Confirm this time" }).click();
  await expect(page.getByText(`Your new time is confirmed: ${when}.`)).toBeVisible();
  await expect(page.getByText("Confirmed", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Please choose a new time" })).toHaveCount(0);

  // ---- staff see the new time, and the proposal accepted with that time marked
  const after = await staffReservation(page.request, id);
  expect(after.status).toBe("confirmed");
  expect(after.startAt).toBe(option!.startAt);
  await page.goto(`/staff/r/${id}`);
  await expect(page.getByRole("heading", { name: `Request ${ref}` })).toBeVisible();
  await expect(card.getByText("The customer chose a new time")).toBeVisible();
  const chosen = card.getByRole("listitem").filter({ hasText: "Chosen" });
  await expect(chosen).toHaveCount(1);
  // The chosen time, as the staff pages write it (the customer's text is the same plus the zone label).
  const { timezone } = await apiGet<{ timezone: string }>(page.request, "/api/auth/me");
  const newTime = fmtWhen(option!.startAt, option!.endAt, timezone);
  expect(when.startsWith(`${newTime} `)).toBe(true);
  await expect(chosen.getByText(newTime, { exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "When", exact: true }).getByText(newTime, { exact: true })).toBeVisible();
});

test("customer chooses another time instead; approving it moves the appointment with one email", async ({ page }, testInfo) => {
  const { id, ref, email } = await arrange(page, testInfo.project.name, "replace");
  const api = page.request;
  await proposeTimes(api, id, 1);

  // ---- "Choose another time" from the proposal email, then book a new time in replacement mode
  await followEmailLink(page, email, new RegExp(`Please choose a new time for your remote support \\(${ref}\\)`), "Choose another time");
  await expect(page.getByRole("heading", { name: "Choose another time" })).toBeVisible();
  await page.getByRole("button", { name: "Continue to choose a time" }).click();
  await expect(page).toHaveURL(/\/book\?replaces=/);
  await expect(page.getByText(`Choosing a new time for ${ref}`)).toBeVisible();
  await page.getByRole("list", { name: /^Available times on/ }).getByRole("button").first().click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByLabel("Your name")).toHaveValue(`Lee ${projectTag(testInfo.project.name)}`);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Review your request" })).toBeVisible();
  await page.getByRole("button", { name: "Send request" }).click();
  await expect(page).toHaveURL(/\/book\/success\//);
  await expect(page.getByRole("heading", { name: "Change requested — not yet confirmed" })).toBeVisible();
  const newId = decodeURIComponent(new URL(page.url()).pathname.split("/").pop()!);
  created.push(newId);
  const newRef = (await page.getByRole("definition").filter({ hasText: /^R-[A-Z0-9]{4}-[A-Z0-9]{4}$/ }).textContent())!.trim();
  expect(newRef).toMatch(/^R-/);
  expect(newRef).not.toBe(ref);

  // ---- staff approve the change request
  await page.goto(`/staff/r/${newId}`);
  await expect(page.getByRole("heading", { name: `Request ${newRef}` })).toBeVisible();
  await expect(page.getByText(`The customer asked to move ${ref} to this time. Approving this request cancels ${ref}.`)).toBeVisible();
  await page.getByRole("group", { name: "Actions" }).getByRole("button", { name: "Approve", exact: true }).click();
  await page.getByRole("radio", { disabled: false }).first().check();
  await page.getByRole("button", { name: "Confirm approval" }).click();
  await expect(page.getByText(/^Approved — .+ is assigned\./)).toBeVisible();

  // ---- the original is cancelled as moved to the new time
  await page.goto(`/staff/r/${id}`);
  await expect(page.getByRole("heading", { name: `Request ${ref}` })).toBeVisible();
  await expect(page.getByText(new RegExp(`^Moved to a new time on .+: the customer's change request ${newRef} was approved\\.$`))).toBeVisible();
  const original = await staffReservation(api, id);
  expect(original.status).toBe("cancelled");
  expect(original.closeReason).toBe("rescheduled");
  expect(original.replacedById).toBe(newId);

  await page.goto("/my");
  const card = myCard(page, ref);
  await expect(card.getByText("Cancelled", { exact: true })).toBeVisible();
  await card.getByRole("button").first().click();
  await expect(card.getByText(`Moved to a new time: ${newRef}.`)).toBeVisible();
  await expect(myCard(page, newRef).getByText("Confirmed", { exact: true })).toBeVisible();

  // ---- exactly one email about the move: "Rescheduled" for the new time; no separate cancelled + confirmed pair
  await expect.poll(() => countMail(api, email, new RegExp(`^Rescheduled: .*\\(${newRef}\\)$`)), { timeout: 30_000 }).toBe(1);
  await runCron(api); // sends anything still queued, so the counts below are final
  expect(await countMail(api, email, new RegExp(`^Rescheduled: .*\\(${newRef}\\)$`))).toBe(1);
  expect(await countMail(api, email, new RegExp(`^Cancelled: .*\\(${ref}\\)$`))).toBe(0);
  expect(await countMail(api, email, new RegExp(`^Confirmed: .*\\(${newRef}\\)$`))).toBe(0);
});

test("a pending request expires at its deadline (dev cron); staff and customer see it expired", async ({ page }, testInfo) => {
  const { id, ref, email } = await arrange(page, testInfo.project.name, "expiry", { pending: true });
  const api = page.request;
  const pending = await staffReservation(api, id);
  expect(pending.status).toBe("pending");
  expect(pending.expiresAt).not.toBeNull();

  // ---- the cron runs as of one minute past the approval deadline
  // Serial only (workers: 1 in playwright.config.ts): a run as of a future time also expires or completes every other
  // test's rows that are due by then, so it must never overlap another test.
  const { counts, failed } = await runCron(api, pending.expiresAt! + 60_000);
  expect(failed).toEqual([]);
  expect(counts.expiry).toBeGreaterThanOrEqual(1);

  // ---- staff see it expired
  await page.goto(`/staff/r/${id}`);
  await expect(page.getByRole("heading", { name: `Request ${ref}` })).toBeVisible();
  await expect(page.getByText(/^Expired on .+ without approval\.$/)).toBeVisible();
  expect((await staffReservation(api, id)).status).toBe("expired");
  await expect(page.getByRole("group", { name: "Actions" })).toHaveCount(0);

  // ---- the customer sees it expired, among the closed ones
  await page.goto("/my");
  const past = page.getByRole("region", { name: "Past and closed" });
  const card = myCard(page, ref, past);
  await expect(card.getByText("Expired", { exact: true })).toBeVisible();
  await card.getByRole("button").first().click();
  await expect(card.getByText("Not confirmed in time")).toBeVisible();

  // ---- and was emailed that it expired
  await page.goto("/dev/mail");
  await expect(page.getByText("Development mailbox — emails are not sent")).toBeVisible();
  await expect(devMailMessages(page, email, new RegExp(`We couldn't confirm your request in time \\(${escapeRe(ref)}\\)`))).toHaveCount(1);
  expect(await countMailAnyone(api, new RegExp(`^${ref} expired — `))).toBeGreaterThanOrEqual(1);
});

test("customer adds the appointment to a calendar from the email link and from My reservations", async ({ page }, testInfo) => {
  const { id, ref, email } = await arrange(page, testInfo.project.name, "ics");
  const check = (file: { name: string; text: string }) => {
    expect(file.name).toBe(`${ref}.ics`);
    expect(file.text).toContain("BEGIN:VCALENDAR");
    expect(file.text).toContain(ref);
    expect(file.text).toMatch(/^STATUS:CONFIRMED\r?$/m);
  };
  /**
   * In `scope`: the main button adds in one click (Google on these non-Apple browsers), "More calendars" lists every
   * choice with what it does, and the .ics is downloaded through "Calendar file (.ics)". That choice is then remembered:
   * the main button offers it next time.
   */
  const addToCalendar = async (scope: Page | Locator, reload: () => Promise<Locator | Page>) => {
    const main = scope.getByRole("link", { name: "Add to Google Calendar" });
    await expect(main).toHaveAttribute("href", /^https:\/\/calendar\.google\.com\/calendar\/render\?/);
    await expect(main).toHaveAttribute("target", "_blank");
    const more = scope.getByRole("button", { name: "More calendars" });
    await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    const menu = scope.getByRole("menu", { name: "More calendars" });
    await expect(menu.getByRole("menuitem", { name: /^Google Calendar/ })).toHaveAttribute("href", /^https:\/\/calendar\.google\.com\//);
    await expect(menu.getByRole("menuitem", { name: /^Outlook \(work or school\)/ })).toHaveAttribute("href", /^https:\/\/outlook\.office\.com\//);
    await expect(menu.getByRole("menuitem", { name: /^Outlook\.com \(personal\)/ })).toHaveAttribute("href", /^https:\/\/outlook\.live\.com\//);
    await expect(menu.getByRole("menuitem", { name: /^Apple Calendar/ })).toHaveAttribute("href", /\/api\/cal\/[A-Za-z0-9_-]+\.ics$/);
    // Each choice says what will happen.
    await expect(menu.getByRole("menuitem", { name: /^Google Calendar/ })).toContainText("Opens Google Calendar to save it");
    // Escape closes the menu and gives focus back to its button.
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(more).toBeFocused();
    await more.click();
    check(await download(page, () => menu.getByRole("menuitem", { name: /^Calendar file \(\.ics\)/ }).click()));
    await expect(menu).toBeHidden();
    const again = await reload();
    await expect(again.getByRole("link", { name: "Download calendar file" })).toHaveAttribute("href", /\/api\/cal\/[A-Za-z0-9_-]+\.ics$/);
    check(await download(page, () => again.getByRole("link", { name: "Download calendar file" }).click()));
  };

  // ---- the link page: it works from the emailed link's token alone (this browser also has the customer's session from
  // arrange(), which the page does not use)
  await followEmailLink(page, email, new RegExp(`Confirmed: .*\\(${ref}\\)`), "View reservation");
  // The token is taken out of the address bar as soon as the page has read it.
  await expect(page).toHaveURL(/\/r$/);
  await expect(page.getByText("Confirmed", { exact: true })).toBeVisible();
  await page.evaluate(() => localStorage.removeItem("calendar-choice"));
  await addToCalendar(page, async () => page);

  // ---- My reservations (the customer's session)
  await page.goto("/my");
  await page.evaluate(() => localStorage.removeItem("calendar-choice"));
  const card = myCard(page, ref);
  await card.getByRole("button").first().click();
  await addToCalendar(card, async () => {
    await page.reload();
    await myCard(page, ref).getByRole("button").first().click();
    return myCard(page, ref);
  });
  expect((await staffReservation(page.request, id)).status).toBe("confirmed");
});

test("the confirmation email's calendar link serves the appointment's .ics", async ({ page }, testInfo) => {
  const { ref, email } = await arrange(page, testInfo.project.name, "ics-mail");
  const mail = await openEmail(page, email, new RegExp(`Confirmed: .*\\(${escapeRe(ref)}\\)`));
  await expect(mail.getByRole("link", { name: "Google Calendar" })).toHaveAttribute("href", /^https:\/\/calendar\.google\.com\//);
  const href = await mail.getByRole("link", { name: "Apple Calendar" }).getAttribute("href");
  expect(href).toMatch(/\/api\/cal\/[A-Za-z0-9_-]+\.ics$/);
  const res = await page.request.get(href!);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("text/calendar; charset=utf-8");
  const text = await res.text();
  expect(text).toContain(ref);
  expect(text).toMatch(/^STATUS:CONFIRMED\r?$/m);
});

test("the booking page shows the open reservation up front instead of refusing at the end", async ({ page }, testInfo) => {
  const { ref } = await arrange(page, testInfo.project.name, "limit");
  await page.goto("/book");
  // The contact gets an account per lifecycle test: with several, choose this test's (the picker stays, so another
  // account can still book). Run on its own, this account is the only one and is preselected.
  const accountChoice = page.getByRole("radio", { name: new RegExp(`^limit clinic ${projectTag(testInfo.project.name)}`) });
  const blocked = page.getByRole("heading", { name: "You already have an open reservation" });
  await expect(accountChoice.or(blocked).first()).toBeVisible();
  if (await accountChoice.count()) await accountChoice.check();
  await expect(page.getByRole("heading", { name: "You already have an open reservation" })).toBeVisible();
  await expect(page.getByText(ref)).toBeVisible();
  // No time can be picked: the steps that would be refused at the end aren't offered.
  await expect(page.getByRole("heading", { name: "Choose a time" })).toHaveCount(0);
  await expect(page.getByRole("list", { name: /^Available times on/ })).toHaveCount(0);
  // "Choose another time" goes to the change-of-time flow for that reservation.
  await page.getByRole("link", { name: "Choose another time" }).click();
  await expect(page).toHaveURL(/\/book\?replaces=/);
  await expect(page.getByText(new RegExp(`${escapeRe(ref)}`)).first()).toBeVisible();
  await expect(page.getByRole("list", { name: /^Available times on/ })).toBeVisible();
});

test("the staff calendar: technician chips and colours, (You), Week and Month views; the request page offers Add to calendar", async ({ page }, testInfo) => {
  const me = (await (await page.request.get("/api/auth/me")).json()) as { staff: { id: number; name: string } };
  // Arranged by hand: the sample administrator only works mornings (09:00–12:00), so the time must fall in those hours.
  const api = page.request;
  const tag = projectTag(testInfo.project.name);
  const email = contactEmail(testInfo.project.name);
  const number = `E2E-YOU-${tag.toUpperCase()}`;
  await createCustomer(api, number, `you clinic ${tag}`, email, `Lee ${tag}`);
  const session = sessions.get(email);
  if (session) await page.context().addCookies(session);
  else {
    await signIn(api, "customer", email);
    sessions.set(email, (await page.context().cookies()).filter((c) => c.name === "__Host-cust"));
  }
  const { timezone, slots } = await availableSlots(api);
  const hourOf = (ms: number) => Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: timezone }).format(ms));
  // The first morning time the administrator is free for (another test may hold them at some).
  let booked: { id: string; ref: string } | null = null;
  for (const slot of slots.filter((x) => hourOf(x.startAt) >= 9 && hourOf(x.startAt) < 12)) {
    const r = await requestSlot(api, slot.startAt, `Lee ${tag}`, number);
    created.push(r.id);
    const { techOptions } = await apiGet<{ techOptions: Array<{ id: number; assignable: boolean }> }>(api, `/api/staff/reservations/${r.id}`);
    if (techOptions.some((o) => o.id === me.staff.id && o.assignable)) {
      booked = r;
      break;
    }
    await cancelIfOpen(api, r.id);
  }
  expect(booked, "a morning time the administrator is free for").not.toBeNull();
  const { id, ref } = booked!;
  await approve(api, id, me.staff.id);
  const startAt = (await staffReservation(api, id)).startAt;
  const week = new Date(startAt).toISOString().slice(0, 10);
  await page.goto(`/staff/calendar?week=${week}`);
  // Technician chips instead of a dropdown: everyone at a glance, you first after Everyone. People click the chip (its
  // label); the radio inside is what records the choice.
  const pick = async (group: Locator, name: string) => {
    await group.locator("label").filter({ has: page.getByRole("radio", { name, exact: true }) }).click();
    await expect(group.getByRole("radio", { name, exact: true })).toBeChecked();
  };
  const chips = page.getByRole("radiogroup", { name: "Technician" });
  await expect(chips.getByRole("radio", { name: "Everyone" })).toBeChecked();
  await expect(chips.getByRole("radio").nth(1)).toHaveAccessibleName(`${me.staff.name} (You)`);
  const team = await apiGet<{ staff: Array<{ active: boolean }> }>(api, "/api/staff/team");
  await expect(chips.getByRole("radio")).toHaveCount(1 + team.staff.filter((s) => s.active).length);
  // The booking names its technician as "(You)" and wears that technician's colour, the one on their chip.
  const booking = page.getByRole("link").filter({ hasText: ref }).first();
  await expect(booking).toContainText(`${me.staff.name} (You)`);
  const myColour = await chips.locator(`[data-tech-color]`).nth(0).getAttribute("data-tech-color");
  expect(myColour).toMatch(/^\d+$/);
  await expect(booking).toHaveAttribute("data-tech-color", myColour!);
  await pick(chips, `${me.staff.name} (You)`);
  await expect(page).toHaveURL(new RegExp(`tech=${me.staff.id}`));
  await expect(page.getByText(`Showing ${me.staff.name}'s calendar.`)).toBeVisible();
  await pick(chips, "Everyone");
  await expect(page).not.toHaveURL(/tech=/);

  // Month view: the whole month, the booking in its technician's colour; the URL keeps the view.
  await pick(page.getByRole("radiogroup", { name: "View" }), "Month");
  await expect(page).toHaveURL(/view=month/);
  const monthName = new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(startAt);
  await expect(page.getByRole("heading", { name: monthName })).toBeVisible();
  if (testInfo.project.name === "mobile") {
    // Phones: a compact month with dots; tapping the day lists its bookings below.
    const day = new Intl.DateTimeFormat("en", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(startAt);
    await page.getByRole("button", { name: new RegExp(`^${escapeRe(day)}`) }).click();
  }
  const inMonth = page.getByRole("link").filter({ hasText: ref }).first();
  await expect(inMonth).toBeVisible();
  await expect(inMonth).toHaveAttribute("data-tech-color", myColour!);
  await page.reload();
  await expect(page.getByRole("heading", { name: monthName })).toBeVisible();
  await pick(page.getByRole("radiogroup", { name: "View" }), "Week");
  await expect(page).not.toHaveURL(/view=month/);

  // The request page offers Add to calendar in its actions box: one click, and "More calendars" for all five.
  await page.goto(`/staff/r/${id}`);
  const actions = page.getByRole("group", { name: "Actions" }).locator("..");
  await expect(actions.getByRole("link", { name: /^Add to (Google|Apple) Calendar$|^Download calendar file$|^Add to Outlook/ })).toBeVisible();
  await actions.getByRole("button", { name: "More calendars" }).click();
  await expect(actions.getByRole("menu", { name: "More calendars" }).getByRole("menuitem")).toHaveCount(5);
});

test("staff subscribe to their calendars from the Calendar page, and reset the links", async ({ page }) => {
  await page.goto("/staff/calendar");
  await page.getByRole("button", { name: "Subscribe" }).click();
  const dialog = page.getByRole("dialog", { name: "Subscribe in your calendar app" });
  await expect(dialog).toBeVisible();
  const google = dialog.getByRole("link", { name: "Add to Google" });
  await expect(google).toHaveCount(2);
  await expect(google.first()).toHaveAttribute("href", /^https:\/\/calendar\.google\.com\/calendar\/r\?cid=webcal%3A%2F%2F/);
  const webcalHref = await dialog.getByRole("link", { name: "Add to Apple / Outlook" }).first().getAttribute("href");
  expect(webcalHref).toMatch(/^webcal:\/\/.+\/api\/feed\/[A-Za-z0-9_-]+\/mine\.ics$/);
  const mineUrl = webcalHref!.replace(/^webcal:/, "http:");
  const feed = await page.request.get(mineUrl);
  expect(feed.status()).toBe(200);
  expect(await feed.text()).toContain("— my appointments");

  // A copy before the reset: its message (copied, or the select-it-yourself fallback) is about the old link.
  await dialog.getByRole("button", { name: "Copy link" }).first().click();
  await expect(dialog.getByText(/^Link copied\.$|^Couldn't copy\./).first()).toBeVisible();

  // Reset asks first, inside the same dialog.
  await dialog.getByRole("button", { name: "Reset links" }).click();
  await expect(dialog.getByText("Your current links stop working.", { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: "Yes, reset links" }).click();
  await expect(dialog.getByText("New links are ready. Subscribe again with them.")).toBeVisible();
  // The new links start afresh: nothing still claims the old link was copied.
  await expect(dialog.getByText(/^Link copied\.$|^Couldn't copy\./)).toHaveCount(0);
  const newHref = await dialog.getByRole("link", { name: "Add to Apple / Outlook" }).first().getAttribute("href");
  expect(newHref).not.toBe(webcalHref);
  expect((await page.request.get(mineUrl)).status()).toBe(404);

  // Closing gives the calendar back; the Subscribe button is where it was.
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Subscribe" })).toBeFocused();
});

test.describe("on an iPhone", () => {
  test.use({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" });
  test("the one-click button adds to Apple Calendar", async ({ page }, testInfo) => {
    const { ref } = await arrange(page, testInfo.project.name, "ios-cal", { email: `ios-${testInfo.project.name}@example.test` });
    await page.goto("/my");
    await page.evaluate(() => localStorage.removeItem("calendar-choice"));
    await page.reload();
    const card = myCard(page, ref);
    await card.getByRole("button").first().click();
    await expect(card.getByRole("link", { name: "Add to Apple Calendar" })).toHaveAttribute("href", /\/api\/cal\/[A-Za-z0-9_-]+\.ics$/);
  });
});
