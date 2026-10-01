import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError, type z } from "zod";

export class HttpError extends Error {
  constructor(public status: number, public code: string, public details?: unknown) {
    super(code);
  }
}

export const errorHandler = (err: Error, c: Context): Response => {
  if (err instanceof HttpError) {
    return c.json({ error: err.code, details: err.details }, err.status as ContentfulStatusCode);
  }
  if (err instanceof ZodError) {
    return c.json({ error: "invalid", details: err.issues }, 400);
  }
  if (err instanceof HTTPException) {
    return c.json({ error: "http_error" }, err.status as ContentfulStatusCode);
  }
  console.error("unhandled error:", err.message);
  return c.json({ error: "internal" }, 500);
};

/** Parse the JSON body and validate it. Malformed JSON -> 400 invalid_json; schema mismatch -> 400 invalid. */
export async function readJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HttpError(400, "invalid_json");
  }
  return schema.parse(body);
}
