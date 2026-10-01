/** Post-login redirects: same-origin absolute paths only. Anything else is dropped (never an error). */
export function safeRedirect(p: unknown): string | null {
  return typeof p === "string" && p.startsWith("/") && !p.startsWith("//") && !p.includes("\\") && !/[\u0000-\u001f\u007f]/.test(p) ? p : null;
}
