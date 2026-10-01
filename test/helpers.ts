import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/worker/index";
export const ORIGIN = "http://localhost:5173";
export interface ApiResult<T = any> { status: number; json: T; headers: Headers; setCookie: string[] }
export async function api<T = any>(method: string, path: string, opts: { body?: unknown; cookie?: string; origin?: string | null; xrw?: boolean } = {}): Promise<ApiResult<T>> {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.origin !== null) headers.set("origin", opts.origin ?? ORIGIN);
  if (opts.xrw !== false) headers.set("x-requested-with", "fetch");
  if (opts.cookie) headers.set("cookie", opts.cookie);
  const ctx = createExecutionContext();
  const res = await worker.fetch!(new Request(`${ORIGIN}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }) as any, env as any, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers, setCookie: res.headers.getSetCookie() };
}
export function cookieFrom(setCookie: string[]): string { return setCookie.map((c) => c.split(";")[0]).join("; "); }
