import { expect, test } from "@playwright/test";
import { followEmailLink } from "./helpers";

/**
 * Seeded people per project. An account may have one open request, and global setup resets the database once,
 * so the desktop and phone runs book for different accounts and approve with different technicians.
 */
const people = {
  desktop: { customer: "frontdesk@example.test", contact: "Jamie Doe", account: "Example Dental Clinic", tech: "tech1@example.test", techName: "Blake Tech" },
  mobile: { customer: "office@example.test", contact: "Sam Poe", account: "Sample Eye Care", tech: "tech2@example.test", techName: "Casey Tech" },
} as const;

test("customer books, staff approves, customer sees it confirmed", async ({ page }, testInfo) => {
  const { customer: CUSTOMER, contact, account, tech: TECH, techName } = people[testInfo.project.name as keyof typeof people];

  // ---- customer asks for a link and follows it from the dev mailbox
  await page.goto("/");
  await page.getByLabel("Email address").fill(CUSTOMER);
  await page.getByRole("button", { name: "Email me a link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();

  await followEmailLink(page, CUSTOMER, /Your link to book remote support/, "Book a remote support session");
  await expect(page).toHaveURL(/\/auth\/verify$/);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/book$/);
  await expect(page.getByText(`Signed in as ${CUSTOMER}`)).toBeVisible();

  // ---- books the first available time (the first day with times is preselected, whatever today's weekday)
  const slots = page.getByRole("list", { name: /^Available times on/ });
  await slots.getByRole("button").first().click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Your name").fill(contact);
  await page.getByLabel("Callback phone").fill("+1 555 0100");
  await page.getByLabel("What do you need help with?").fill("Printer stopped working.\nIt shows error 42.");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Review your request" })).toBeVisible();
  await page.getByRole("button", { name: "Send request" }).click();
  await expect(page).toHaveURL(/\/book\/success\//);
  await expect(page.getByRole("heading", { name: /not yet confirmed/ })).toBeVisible();
  const ref = (await page.getByRole("definition").filter({ hasText: /^R-[A-Z0-9]{4}-[A-Z0-9]{4}$/ }).textContent())!.trim();
  expect(ref).toMatch(/^R-/);

  // ---- technician signs in (independent of the customer session in the same browser)
  await page.goto("/staff/login");
  await page.getByLabel("Work email").fill(TECH);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();

  await followEmailLink(page, TECH, /Sign in to /, "Sign in");
  await expect(page).toHaveURL(/\/staff\/auth\/verify$/);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/staff$/);
  await expect(page.getByText(`Signed in as ${TECH}`)).toBeVisible();

  // ---- opens the request from the dashboard and approves it with themselves
  const pending = page.getByRole("region", { name: /Waiting for approval/ });
  await pending.getByRole("link").filter({ hasText: ref }).filter({ hasText: account }).click();
  await expect(page.getByRole("heading", { name: `Request ${ref}` })).toBeVisible();
  await expect(page.getByText("Printer stopped working.\nIt shows error 42.")).toBeVisible();
  await expect(page.getByRole("link", { name: "+1 555 0100" })).toHaveAttribute("href", "tel:+15550100");

  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page.getByRole("radio", { name: new RegExp(`${techName} \\(you\\)`) }).check();
  await page.getByRole("button", { name: "Confirm approval" }).click();
  await expect(page.getByText(`Approved — ${techName} is assigned.`, { exact: false })).toBeVisible();
  await expect(page.getByText(`Technician: ${techName}.`, { exact: false })).toBeVisible();

  // ---- the customer sees it confirmed, and was emailed
  await page.goto("/my");
  const card = page.getByRole("listitem").filter({ hasText: ref });
  await expect(card.getByText("Confirmed", { exact: true })).toBeVisible();

  await page.goto("/dev/mail");
  await expect(
    page.getByRole("list", { name: "Messages" }).getByRole("button").filter({ hasText: CUSTOMER }).filter({ hasText: /Confirmed:/ }),
  ).toHaveCount(1);
});
