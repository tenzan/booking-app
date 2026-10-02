import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyTurnstile } from "../../src/worker/lib/turnstile";

const SECRET = "test-secret-value";
const TOKEN = "token-value-123";
const cfg = { ...env, TURNSTILE_SECRET_KEY: SECRET } as any;

afterEach(() => vi.restoreAllMocks());

/** The one "turnstile verify failed" line, checked for leaks. */
function expectOneSafeWarning(warn: ReturnType<typeof vi.spyOn>) {
  expect(warn).toHaveBeenCalledOnce();
  const args = warn.mock.calls[0]!;
  expect(args[0]).toBe("turnstile verify failed");
  const line = args.map(String).join(" ");
  expect(line).not.toContain(SECRET);
  expect(line).not.toContain(TOKEN);
}

describe("verifyTurnstile", () => {
  it("is true when Turnstile is not configured, false without a token", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    expect(await verifyTurnstile({ ...env, TURNSTILE_SECRET_KEY: undefined } as any, undefined, null)).toBe(true);
    expect(await verifyTurnstile(cfg, undefined, null)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("passes on success, fails quietly on a plain rejection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, init) =>
      Response.json({ success: ((init as RequestInit).body as FormData).get("response") === TOKEN }),
    );
    expect(await verifyTurnstile(cfg, TOKEN, "203.0.113.9")).toBe(true);
    expect(await verifyTurnstile(cfg, "other", null)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("sends a timeout signal with the siteverify request (5 s by default)", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    let signal: AbortSignal | null | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, init) => {
      signal = (init as RequestInit).signal;
      return Response.json({ success: true });
    });
    expect(await verifyTurnstile(cfg, TOKEN, null)).toBe(true);
    expect(timeout).toHaveBeenCalledWith(5000);
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("gives up (false, one safe warning) when siteverify never answers", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Never resolves on its own; only the abort signal ends it, as a real fetch would.
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_u, init) =>
        new Promise((_resolve, reject) => {
          const signal = (init as RequestInit).signal!;
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    const started = Date.now();
    expect(await verifyTurnstile(cfg, TOKEN, null, { timeoutMs: 20 })).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
    expectOneSafeWarning(warn);
  });

  it("fails (false, one safe warning) on a network error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Network connection lost."));
    expect(await verifyTurnstile(cfg, TOKEN, null)).toBe(false);
    expectOneSafeWarning(warn);
    expect(warn.mock.calls[0]![1]).toBe("Network connection lost.");
  });

  it("fails (false, one safe warning) on a non-2xx answer, even one that claims success", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ success: true }, { status: 500 }));
    expect(await verifyTurnstile(cfg, TOKEN, null)).toBe(false);
    expectOneSafeWarning(warn);
  });

  it("fails (false, one safe warning) on a body that is not JSON", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>bad gateway</html>", { status: 200 }));
    expect(await verifyTurnstile(cfg, TOKEN, null)).toBe(false);
    expectOneSafeWarning(warn);
  });
});
