import { describe, expect, it } from "vitest";
import { safeRedirect } from "../../src/worker/lib/redirect";

describe("safeRedirect", () => {
  it("keeps same-origin absolute paths, with query and hash", () => {
    for (const ok of ["/", "/book", "/staff/schedule?week=2026-10-05#top", "/a/b%20c"]) expect(safeRedirect(ok)).toBe(ok);
  });

  it("drops everything else", () => {
    const bad: unknown[] = [
      "https://evil.example.com/",
      "//evil.example.com",
      "///evil.example.com",
      "/\\evil.example.com",
      "\\evil.example.com",
      "book",
      "",
      " /book",
      "/book\n",
      "/bo\tok",
      "/a\u0000b",
      "/a\u007fb",
      "javascript:alert(1)",
      null,
      undefined,
      42,
      {},
    ];
    for (const b of bad) expect(safeRedirect(b), String(b)).toBeNull();
  });
});
