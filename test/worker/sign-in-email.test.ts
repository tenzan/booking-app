import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api } from "../helpers";
import { seedCustomer } from "../fixtures";
import { processOutbox } from "../../src/worker/mail/outbox";

const VERIFY = "http://localhost:5173/auth/verify#t=";

/** Ask for a customer sign-in link (as the start page does) and return the email it produced. */
async function signInMail(redirectPath?: string) {
  await seedCustomer({ email: "pat@example.test" });
  const res = await api("POST", "/api/auth/customer/request", { body: { email: "pat@example.test", ...(redirectPath ? { redirectPath } : {}) } });
  expect(res.status).toBe(200);
  await processOutbox(env, 50);
  const m = await env.DB.prepare("SELECT subject, text, html FROM dev_mailbox WHERE to_email = 'pat@example.test' ORDER BY id DESC LIMIT 1").first<{
    subject: string;
    text: string;
    html: string;
  }>();
  expect(m).not.toBeNull();
  return m!;
}

/** `label: url` lines of the plain-text version that point at the verify page. */
const buttons = (text: string) =>
  text
    .split("\n")
    .filter((l) => l.includes(VERIFY))
    .map((l) => {
      const [label, url] = l.split(/: (?=http)/);
      return { label: label!, url: url! };
    });

const tokenOf = (url: string) => /#t=([A-Za-z0-9_-]+)/.exec(url)![1];

describe("customer sign-in email", () => {
  it("is about signing in, not only booking", async () => {
    const m = await signInMail();
    expect(m.subject).toMatch(/^Your sign-in link — /);
    expect(m.text).toContain("sign in");
    expect(m.text).toContain("expires in 15 minutes and can be used once");
    expect(m.text).toContain("If you didn't request this, you can ignore this email.");
    expect(m.text).toMatch(/entered this email address on the .* sign-in page/);
    expect(m.text).not.toContain("Book a remote support session");
  });

  it("from the start page: Book a session and My reservations, one link with a destination each", async () => {
    for (const redirectPath of [undefined, "/book"]) {
      const m = await signInMail(redirectPath);
      const b = buttons(m.text);
      expect(b.map((x) => x.label)).toEqual(["Book a session", "My reservations"]);
      expect(b[0]!.url).toMatch(/#t=[A-Za-z0-9_-]+&to=\/book$/);
      expect(b[1]!.url).toMatch(/#t=[A-Za-z0-9_-]+&to=\/my$/);
      // The same single-use link: whichever is opened first signs in.
      expect(tokenOf(b[0]!.url)).toBe(tokenOf(b[1]!.url));
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_tokens WHERE kind = 'customer'").first("n")).toBe(redirectPath ? 2 : 1);
      // In the HTML: the first is the primary button, the second a secondary link.
      expect(m.html).toMatch(/background:#1d4ed8[^>]*>Book a session<\/a>/);
      expect(m.html).toMatch(/text-decoration:underline[^>]*>My reservations<\/a>/);
    }
  });

  it("going to My reservations: one button that says so", async () => {
    const m = await signInMail("/my");
    expect(buttons(m.text)).toEqual([{ label: "View my reservations", url: expect.stringMatching(/#t=[A-Za-z0-9_-]+$/) }]);
    expect(m.text).not.toContain("Book a session");
  });

  it("choosing another time for a reservation: one button that says so", async () => {
    const m = await signInMail("/book?replaces=res-1");
    expect(buttons(m.text).map((x) => x.label)).toEqual(["Choose another time"]);
  });

  it("anywhere else: a plain Sign in button (the stored destination applies)", async () => {
    const m = await signInMail("/book/success/res-1");
    expect(buttons(m.text)).toEqual([{ label: "Sign in", url: expect.stringMatching(/#t=[A-Za-z0-9_-]+$/) }]);
  });
});

describe("staff sign-in email", () => {
  it("is unchanged: one Sign in button", async () => {
    await env.DB.prepare("INSERT INTO staff(email, name, role, created_at, updated_at) VALUES ('tom@example.test', 'Tom', 'technician', 0, 0)").run();
    expect((await api("POST", "/api/auth/staff/request", { body: { email: "tom@example.test" } })).status).toBe(200);
    await processOutbox(env, 50);
    const m = await env.DB.prepare("SELECT subject, text FROM dev_mailbox WHERE to_email = 'tom@example.test'").first<{ subject: string; text: string }>();
    expect(m!.subject).toMatch(/^Sign in to .* scheduling$/);
    expect(m!.text).toMatch(/^Sign in: http:\/\/localhost:5173\/staff\/auth\/verify#t=[A-Za-z0-9_-]+$/m);
  });
});
