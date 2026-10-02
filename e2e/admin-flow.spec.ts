import { expect, test } from "@playwright/test";
import {
  ADMIN_STATE,
  apiGet,
  apiPost,
  approve,
  availableSlots,
  cancelIfOpen,
  createCustomer,
  devMailMessages,
  followEmailLink,
  requestSlot,
  setBookingEnabled,
  signIn,
  wallTime,
} from "./helpers";

/**
 * Administrator flows. Each test arranges its own data over the API (customers, technicians and appointments named
 * after the project, so the desktop and phone runs never share anything) and then drives the behaviour through the UI.
 * Global setup resets the local database once per run.
 */

/** Every test starts signed in as the sample administrator (global setup signs in once per run). */
test.use({ storageState: ADMIN_STATE });

/** "Desktop" / "Mobile": makes names and addresses unique per project. */
const projectTag = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
/** The weekday's name as the app shows it ("Monday"; 0 = Sunday). 2026-10-04 is a Sunday. */
const weekdayName = (weekday: number) => new Intl.DateTimeFormat("en", { weekday: "long", timeZone: "UTC" }).format(Date.UTC(2026, 9, 4 + weekday));

interface Window {
  id: number;
  weekday: number;
  startMin: number;
  endMin: number;
  staffIds: number[];
}

test("admin takes a technician off weekly hours and reassigns their confirmed appointment", async ({ page }, testInfo) => {
  const tag = projectTag(testInfo.project.name);
  const api = page.request;
  const techName = `Rowan ${tag}`;
  const customerEmail = `reassign-${testInfo.project.name}@example.test`;

  // ---- arrange: a technician of this test's own, with one confirmed appointment inside a weekly window
  const { staff: tech } = await apiPost<{ staff: { id: number } }>(api, "/api/staff/team", {
    email: `rowan-${testInfo.project.name}@example.test`,
    name: techName,
    role: "technician",
    bookable: true,
    notify: false,
  });
  await createCustomer(api, `E2E-REASSIGN-${tag.toUpperCase()}`, `Reassign Clinic ${tag}`, customerEmail, "Robin Roe");
  await signIn(api, "customer", customerEmail);

  // The first bookable time: someone is free then, so once this test's technician joins its hours and takes it, someone
  // else is still free for the reassignment below.
  const { timezone, slots } = await availableSlots(api);
  const slot = slots[0];
  expect(slot, "a bookable time").toBeTruthy();
  const { weekday, minute } = wallTime(slot!.startAt, timezone);
  const { weekly } = await apiGet<{ weekly: Window[] }>(api, "/api/staff/schedule/windows");
  const win = weekly.find((w) => w.weekday === weekday && w.startMin <= minute && minute < w.endMin)!;
  expect(win, "the weekly window of that time").toBeTruthy();

  const change = {
    type: "window.update",
    id: win.id,
    window: { kind: "weekly", weekday, date: null, startMin: win.startMin, endMin: win.endMin, staffIds: [...win.staffIds, tech.id] },
  };
  const { version } = await apiPost<{ version: number }>(api, "/api/staff/schedule/preview", { change });
  await apiPost(api, "/api/staff/schedule/apply", { change, version });

  const reservation = await requestSlot(api, slot!.startAt, "Robin Roe");
  await approve(api, reservation.id, tech.id);

  try {
    // ---- act: remove the technician from those hours in the schedule editor
    const day = weekdayName(weekday);
    const range = `${hhmm(win.startMin)} – ${hhmm(win.endMin)}`;
    await page.goto("/staff/schedule");
    await expect(page.getByRole("heading", { name: "Schedule", level: 1 })).toBeVisible();
    await page.getByRole("button", { name: `Edit ${day} ${range}` }).click();
    const form = page.getByRole("form", { name: `Hours on ${day}` });
    // The checkbox is visually hidden inside its chip: click the chip, as a person would.
    await form.locator("label").filter({ hasText: techName }).click();
    await expect(form.getByRole("checkbox", { name: techName })).not.toBeChecked();
    await form.getByRole("button", { name: "Save", exact: true }).click();

    // ---- the impact review names the confirmed appointment that would lose its technician
    const dialog = page.getByRole("dialog", { name: "Check the impact before saving" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Needs a decision (1)" })).toBeVisible();
    const conflict = dialog.getByRole("article").filter({ hasText: reservation.ref });
    await expect(conflict.getByText(`${techName} would no longer be available at this time.`)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Save change" })).toBeDisabled();

    const reassign = conflict.getByRole("button", { name: /^Reassign to / }).first();
    const newTech = (await reassign.textContent())!.replace("Reassign to", "").trim();
    await reassign.click();
    // If that technician only becomes free by moving a pending request, the card asks first. Either way the
    // reassignment is only staged: it is saved together with the change.
    const done = dialog.getByText(`${reservation.ref} will be reassigned to ${newTech} when you save. The impact is updated.`);
    const ask = conflict.getByRole("group");
    await expect(done.or(ask)).toBeVisible();
    if (await ask.isVisible()) await ask.getByRole("button", { name: `Reassign to ${newTech}` }).click();
    await expect(done).toBeVisible();
    await expect(dialog.getByRole("heading", { name: /^Needs a decision/ })).toHaveCount(0);
    await expect(dialog.getByRole("heading", { name: "Reassigned when you save (1)" })).toBeVisible();
    await expect(conflict.getByText(`Will be reassigned to ${newTech} when you save`)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Save change" })).toBeEnabled();

    await dialog.getByRole("button", { name: "Save change" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("status").filter({ hasText: `Saved ${day} ${range}.` })).toBeVisible();

    // ---- the hours no longer list the technician, and the appointment has the new one
    const card = page.getByRole("button", { name: `Edit ${day} ${range}` }).locator("..");
    await expect(card.getByRole("list", { name: "Technicians" })).not.toContainText(techName);

    await page.goto(`/staff/r/${reservation.id}`);
    await expect(page.getByRole("heading", { name: `Request ${reservation.ref}` })).toBeVisible();
    await expect(page.getByText(`Technician: ${newTech}.`, { exact: false })).toBeVisible();
  } finally {
    // The appointment holds the first bookable time; its new technician must be free there for the tests that follow.
    await cancelIfOpen(api, reservation.id);
  }
});

test("admin swaps the only technician of an appointment's hours for another; the appointment moves with the save", async ({ page }, testInfo) => {
  const tag = projectTag(testInfo.project.name);
  const api = page.request;
  const fromName = `Sasha ${tag}`;
  const toName = `Jordan ${tag}`;
  const customerEmail = `swap-${testInfo.project.name}@example.test`;
  // Weekend hours nobody else has (the sample schedule is Mon–Fri), one weekday per project.
  const weekday = testInfo.project.name === "desktop" ? 6 : 0;
  const startMin = 7 * 60;
  const endMin = 9 * 60;

  // ---- arrange: two technicians of this test's own; hours staffed only by the first, holding a confirmed appointment
  const staff = async (name: string, email: string) =>
    (await apiPost<{ staff: { id: number } }>(api, "/api/staff/team", { email, name, role: "technician", bookable: true, notify: false })).staff.id;
  const from = await staff(fromName, `sasha-${testInfo.project.name}@example.test`);
  const to = await staff(toName, `jordan-${testInfo.project.name}@example.test`);
  const hours = (staffIds: number[]) => ({ kind: "weekly", weekday, date: null, startMin, endMin, staffIds });
  const create = { type: "window.create", window: hours([from]) };
  await apiPost(api, "/api/staff/schedule/apply", { change: create, version: (await apiPost<{ version: number }>(api, "/api/staff/schedule/preview", { change: create })).version });
  const { weekly } = await apiGet<{ weekly: Window[] }>(api, "/api/staff/schedule/windows");
  const win = weekly.find((w) => w.weekday === weekday && w.startMin === startMin && w.endMin === endMin)!;
  expect(win, "the new weekend hours").toBeTruthy();

  await createCustomer(api, `E2E-SWAP-${tag.toUpperCase()}`, `Swap Clinic ${tag}`, customerEmail, "Sam Swap");
  await signIn(api, "customer", customerEmail);
  const { timezone, slots } = await availableSlots(api);
  const slot = slots.find((s) => {
    const w = wallTime(s.startAt, timezone);
    return w.weekday === weekday && startMin <= w.minute && w.minute < endMin;
  });
  expect(slot, "a bookable time in the new hours").toBeTruthy();
  const reservation = await requestSlot(api, slot!.startAt, "Sam Swap");
  await approve(api, reservation.id, from);

  try {
    // ---- act: in the schedule editor, take the first technician off those hours and put the second on
    const day = weekdayName(weekday);
    const range = `${hhmm(startMin)} – ${hhmm(endMin)}`;
    await page.goto("/staff/schedule");
    await expect(page.getByRole("heading", { name: "Schedule", level: 1 })).toBeVisible();
    await page.getByRole("button", { name: `Edit ${day} ${range}` }).click();
    const form = page.getByRole("form", { name: `Hours on ${day}` });
    await form.locator("label").filter({ hasText: fromName }).click();
    await form.locator("label").filter({ hasText: toName }).click();
    await expect(form.getByRole("checkbox", { name: fromName })).not.toBeChecked();
    await expect(form.getByRole("checkbox", { name: toName })).toBeChecked();
    await form.getByRole("button", { name: "Save", exact: true }).click();

    // ---- the only way out is the technician who is on those hours AFTER the change: stage it
    const dialog = page.getByRole("dialog", { name: "Check the impact before saving" });
    await expect(dialog.getByRole("heading", { name: "Needs a decision (1)" })).toBeVisible();
    const card = dialog.getByRole("article").filter({ hasText: reservation.ref });
    await expect(card.getByText(`${fromName} would no longer be available at this time.`)).toBeVisible();
    await card.getByRole("button", { name: `Reassign to ${toName}` }).click();
    await expect(dialog.getByText(`${reservation.ref} will be reassigned to ${toName} when you save. The impact is updated.`)).toBeVisible();
    await expect(card.getByText(`Will be reassigned to ${toName} when you save`)).toBeVisible();

    // Undo puts it back to "Needs a decision"; staging again makes the change saveable.
    await card.getByRole("button", { name: `Undo reassigning ${reservation.ref} to ${toName}` }).click();
    await expect(dialog.getByRole("heading", { name: "Needs a decision (1)" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Save change" })).toBeDisabled();
    await card.getByRole("button", { name: `Reassign to ${toName}` }).click();
    await expect(dialog.getByRole("heading", { name: "Reassigned when you save (1)" })).toBeVisible();
    await expect(dialog.getByRole("heading", { name: /^Needs a decision/ })).toHaveCount(0);

    await dialog.getByRole("button", { name: "Save change" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("status").filter({ hasText: `Saved ${day} ${range}.` })).toBeVisible();

    // ---- one commit did both: the hours list only the second technician, and the appointment is theirs
    const hoursCard = page.getByRole("button", { name: `Edit ${day} ${range}` }).locator("..");
    await expect(hoursCard.getByRole("list", { name: "Technicians" })).toContainText(toName);
    await expect(hoursCard.getByRole("list", { name: "Technicians" })).not.toContainText(fromName);
    await page.goto(`/staff/r/${reservation.id}`);
    await expect(page.getByRole("heading", { name: `Request ${reservation.ref}` })).toBeVisible();
    await expect(page.getByText(`Technician: ${toName}.`, { exact: false })).toBeVisible();
  } finally {
    // Leave no weekend hours behind for the other tests' "first bookable time".
    await cancelIfOpen(api, reservation.id);
    const del = { type: "window.delete", id: win.id };
    await apiPost(api, "/api/staff/schedule/apply", { change: del, version: (await apiPost<{ version: number }>(api, "/api/staff/schedule/preview", { change: del })).version });
  }
});

test("admin imports a new customer from pasted CSV, and its contact can get a booking link", async ({ page }, testInfo) => {
  const tag = projectTag(testInfo.project.name);
  const number = `E2E-IMPORT-${tag.toUpperCase()}`;
  const email = `import-${testInfo.project.name}@example.test`;

  await page.goto("/staff/customers/import");
  await expect(page.getByRole("heading", { name: "Import customers", level: 1 })).toBeVisible();
  await page
    .getByLabel("Or paste the rows")
    .fill(`customer_number,name,phone,contact_email,contact_name,active\n${number},Imported Clinic ${tag},+1 555 0142,${email},Quinn Example,true\n`);
  await page.getByRole("button", { name: "Check the file" }).click();

  // ---- preview: exactly one new customer with one new contact, nothing else
  await expect(page.getByRole("heading", { name: "Check the changes" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Customers" }).getByRole("listitem")).toHaveText(["1 new", "0 updated", "0 unchanged"]);
  await expect(page.getByRole("list", { name: "Contacts" }).getByRole("listitem")).toHaveText(["1 new", "0 updated", "0 unchanged"]);
  await expect(page.getByText("Ready to import. Nothing is deleted.")).toBeVisible();

  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Import complete" })).toBeVisible();
  await expect(page.getByText("Customers created", { exact: true }).locator("xpath=following-sibling::dd[1]")).toHaveText("1");

  // ---- the new contact asks for a link on the public start page and signs in with it
  await page.goto("/");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Email me a link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();

  await followEmailLink(page, email, /Your link to book remote support/, "Book a remote support session");
  await expect(page).toHaveURL(/\/auth\/verify$/);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/book$/);
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
});

test("admin adds a customer with the form; the first contact's email is asked for up front", async ({ page }, testInfo) => {
  const request = page.request;
  const tag = projectTag(testInfo.project.name);
  const number = `E2E-FORM-${tag.toUpperCase()}`;
  const email = `form-${testInfo.project.name}@example.test`;

  await page.goto("/staff/customers/new");
  await expect(page.getByRole("heading", { name: "New customer", level: 1 })).toBeVisible();
  const form = page.getByRole("form", { name: "New customer" });
  await form.getByLabel("Customer number").fill(number);
  await form.getByLabel("Name", { exact: true }).first().fill(`Form Clinic ${tag}`);
  // No "Add a contact" click: the first contact's email field is already there.
  const contact = form.getByRole("group", { name: "Contact 1" });
  await expect(contact.getByLabel("Email")).toBeVisible();
  await contact.getByLabel("Email").fill(email);
  await contact.getByLabel(/^Name/).fill("Robin Example");
  await form.getByRole("button", { name: "Create customer" }).click();
  await expect(page.getByText(`Created Form Clinic ${tag} (${number}).`)).toBeVisible();

  const list = await apiGet<{ customers: { id: number; customerNumber: string }[] }>(request, `/api/staff/customers?query=${number}`);
  const created = list.customers.find((c) => c.customerNumber === number);
  expect(created).toBeDefined();
  const detail = await apiGet<{ contacts: { email: string }[] }>(request, `/api/staff/customers/${created!.id}`);
  expect(detail.contacts.map((c) => c.email)).toEqual([email]);
});

test("admin adds a customer and leaves the contact row empty; it is saved without contacts", async ({ page }, testInfo) => {
  const request = page.request;
  const tag = projectTag(testInfo.project.name);
  const number = `E2E-NOCONTACT-${tag.toUpperCase()}`;

  await page.goto("/staff/customers/new");
  const form = page.getByRole("form", { name: "New customer" });
  await form.getByLabel("Customer number").fill(number);
  await form.getByLabel("Name", { exact: true }).first().fill(`Quiet Clinic ${tag}`);
  await form.getByRole("button", { name: "Create customer" }).click();
  await expect(page.getByText(`Created Quiet Clinic ${tag} (${number}).`)).toBeVisible();

  const list = await apiGet<{ customers: { id: number; customerNumber: string }[] }>(request, `/api/staff/customers?query=${number}`);
  const created = list.customers.find((c) => c.customerNumber === number);
  const detail = await apiGet<{ contacts: unknown[] }>(request, `/api/staff/customers/${created!.id}`);
  expect(detail.contacts).toEqual([]);
});

test("staff cancel a confirmed appointment; the customer sees it cancelled and is emailed", async ({ page }, testInfo) => {
  const tag = projectTag(testInfo.project.name);
  const api = page.request;
  const email = `cancel-${testInfo.project.name}@example.test`;
  const reason = "Our technician is out that day; please book another time.";

  // ---- arrange: a confirmed appointment at the first bookable time
  await createCustomer(api, `E2E-CANCEL-${tag.toUpperCase()}`, `Cancel Clinic ${tag}`, email, "Morgan Moe");
  await signIn(api, "customer", email);
  const { slots } = await availableSlots(api);
  expect(slots.length, "a bookable time").toBeGreaterThan(0);
  const reservation = await requestSlot(api, slots[0]!.startAt, "Morgan Moe");
  await approve(api, reservation.id);

  // ---- act: cancel it with a reason from the request page
  await page.goto(`/staff/r/${reservation.id}`);
  await expect(page.getByRole("heading", { name: `Request ${reservation.ref}` })).toBeVisible();
  await page.getByRole("group", { name: "Actions" }).getByRole("button", { name: "Cancel reservation" }).click();
  await page.getByLabel("Reason", { exact: true }).fill(reason);
  await page.getByRole("button", { name: "Confirm cancellation" }).click();
  await expect(page.getByText("Cancelled. The customer has been emailed.")).toBeVisible();

  // ---- the customer sees it cancelled, with the reason, and got the cancellation email
  await page.goto("/my");
  const card = page.getByRole("listitem").filter({ hasText: reservation.ref });
  await expect(card.getByText("Cancelled", { exact: true })).toBeVisible();

  await page.goto("/dev/mail");
  await expect(page.getByText("Development mailbox — emails are not sent")).toBeVisible();
  await expect(devMailMessages(page, email, new RegExp(`Cancelled: remote support on .*\\(${reservation.ref}\\)`))).toHaveCount(1);
});

test("admin pauses online booking in Settings; the start page says so until it is resumed", async ({ page }) => {
  try {
    await page.goto("/staff/settings");
    await page.getByRole("button", { name: "Pause online booking" }).click();
    await page.getByRole("button", { name: "Yes, pause" }).click();
    await expect(page.getByText("Online booking is now paused.")).toBeVisible();

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Online booking is paused" })).toBeVisible();
    await expect(page.getByLabel("Email address")).toHaveCount(0);

    await page.goto("/staff/settings");
    await page.getByRole("button", { name: "Resume online booking" }).click();
    await page.getByRole("button", { name: "Yes, resume" }).click();
    await expect(page.getByText("Online booking is now on.")).toBeVisible();

    await page.goto("/");
    await expect(page.getByLabel("Email address")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Online booking is paused" })).toHaveCount(0);
  } finally {
    // Never leave booking paused for the tests that follow, whatever happened above.
    await setBookingEnabled(page.request, true);
  }
});
