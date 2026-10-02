import { describe, expect, it } from "vitest";
import { devMailEnabled, devRoutesEnabled, isLocalBaseUrl } from "../../src/worker/lib/local";

describe("isLocalBaseUrl", () => {
  it.each(["http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173", "http://[0:0:0:0:0:0:0:1]/", "https://[::1]"])("%s is loopback", (url) => {
    expect(isLocalBaseUrl(url)).toBe(true);
  });

  it.each(["https://booking.example.com", "http://192.0.2.10:5173", "http://localhost.example.com", "http://[::2]:5173", "http://[::ffff:7f00:1]/", "not a url", ""])(
    "%s is not",
    (url) => {
      expect(isLocalBaseUrl(url)).toBe(false);
    },
  );
});

describe("devMailEnabled / devRoutesEnabled with IPv6 loopback", () => {
  const dev = { MAIL_MODE: "dev", APP_BASE_URL: "http://[::1]:5173" } as const;

  it("dev mail is on for an [::1] base URL in dev mode only", () => {
    expect(devMailEnabled(dev)).toBe(true);
    expect(devMailEnabled({ ...dev, MAIL_MODE: "cloudflare" })).toBe(false);
  });

  it("dev routes need the request on a loopback host too", () => {
    expect(devRoutesEnabled(dev, "http://[::1]:5173/api/dev/mail")).toBe(true);
    expect(devRoutesEnabled({ ...dev, APP_BASE_URL: "http://localhost:5173" }, "http://[::1]:5173/api/dev/mail")).toBe(true);
    expect(devRoutesEnabled(dev, "https://booking.example.com/api/dev/mail")).toBe(false);
    expect(devRoutesEnabled({ ...dev, APP_BASE_URL: "https://booking.example.com" }, "http://[::1]:5173/api/dev/mail")).toBe(false);
  });
});
