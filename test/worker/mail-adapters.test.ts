import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isHeaderRejection, mailerFor } from "../../src/worker/mail/adapters";

afterEach(() => vi.restoreAllMocks());

const cfEnv = (send: (m: any) => Promise<unknown>) => ({ ...env, MAIL_MODE: "cloudflare", EMAIL: { send } }) as any;
const withHeaders = { to: "a@example.test", subject: "s", html: "h", text: "t", replyTo: "r@example.test", headers: { "Auto-Submitted": "auto-generated" } };

describe("isHeaderRejection", () => {
  it.each([
    new Error("headers not allowed"),
    new Error("header 'X-Auto-Response-Suppress' is not allowed"),
    new Error("Header X-Foo not permitted"),
    new Error("invalid header: Auto-Submitted"),
    new Error("E_HEADER_NOT_ALLOWED: X-Auto-Response-Suppress"),
    Object.assign(new Error("send failed"), { code: "E_HEADER_NOT_ALLOWED" }),
  ])("recognises a header rejection: %s", (e) => expect(isHeaderRejection(e)).toBe(true));

  it.each([
    new Error("The operation was aborted due to timeout"),
    new Error("Internal error"),
    new Error("rate limit exceeded"),
    new Error("email to someone@example.test not allowed"),
    new Error("E_DELIVERY_FAILED"),
    Object.assign(new Error("send failed"), { code: "E_RATE_LIMIT_EXCEEDED" }),
    new TypeError("Network connection lost."),
    "headers",
    null,
    undefined,
  ])("does not treat other failures as a header rejection: %s", (e) => expect(isHeaderRejection(e)).toBe(false));
});

describe("cloudflare mailer", () => {
  it("retries once without the custom headers when the binding refuses them (exactly 2 calls)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls: any[] = [];
    const send = vi.fn(async (m: any) => {
      calls.push(m);
      if (m.headers) throw new Error("header 'Auto-Submitted' is not allowed");
    });
    await mailerFor(cfEnv(send)).send(withHeaders);
    expect(send).toHaveBeenCalledTimes(2);
    expect(calls[0].headers).toEqual({ "Auto-Submitted": "auto-generated" });
    expect(calls[1].headers).toBeUndefined();
    expect(calls[1]).toMatchObject({ to: "a@example.test", replyTo: "r@example.test", subject: "s" });
    expect(warn).toHaveBeenCalledOnce();
  });

  it.each([
    ["a timeout", new Error("The operation was aborted due to timeout")],
    ["a generic error", new Error("Internal error")],
    ["a recipient refusal", new Error("email to a@example.test not allowed")],
  ])("rethrows %s without a second send (exactly 1 call): the outbox's backoff handles it", async (_label, err) => {
    const send = vi.fn(async () => {
      throw err;
    });
    await expect(mailerFor(cfEnv(send)).send(withHeaders)).rejects.toBe(err);
    expect(send).toHaveBeenCalledOnce();
  });

  it("a failure of the header-less retry is thrown too", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const later = new Error("Internal error");
    const send = vi.fn(async (m: any) => {
      throw m.headers ? new Error("headers not allowed") : later;
    });
    await expect(mailerFor(cfEnv(send)).send(withHeaders)).rejects.toBe(later);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("mail without custom headers is sent once and its failures are thrown", async () => {
    const err = new Error("Internal error");
    const send = vi.fn(async () => {
      throw err;
    });
    await expect(mailerFor(cfEnv(send)).send({ to: "a@example.test", subject: "s", html: "h", text: "t" })).rejects.toBe(err);
    expect(send).toHaveBeenCalledOnce();
  });
});
