import { HttpError } from "./http";

type Part = string | number;

/** Opaque, URL-safe keyset cursor: the sort key of the last row of a page. */
export const encodeCursor = (parts: Part[]): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(parts)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

/** Decodes a cursor made by `encodeCursor`; `kinds` is the expected type of each part. Anything else is 400 invalid_cursor. */
export function decodeCursor<K extends Array<"string" | "number">>(
  cursor: string,
  kinds: [...K],
): { [I in keyof K]: K[I] extends "string" ? string : number } {
  try {
    const b64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const v: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (
      Array.isArray(v) &&
      v.length === kinds.length &&
      v.every((p, i) => (kinds[i] === "number" ? Number.isInteger(p) : typeof p === "string"))
    ) {
      return v as never;
    }
  } catch {
    // fall through
  }
  throw new HttpError(400, "invalid_cursor");
}
