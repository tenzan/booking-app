import type { Context } from "hono";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(public status: number, public code: string, public details?: unknown) {
    super(code);
  }
}

export const errorHandler = (err: Error, c: Context): Response => {
  if (err instanceof HttpError) {
    return c.json({ error: err.code, details: err.details }, err.status as 400);
  }
  if (err instanceof ZodError) {
    return c.json({ error: "invalid", details: err.issues }, 400);
  }
  console.error("unhandled error:", err.message);
  return c.json({ error: "internal" }, 500);
};
