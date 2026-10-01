import test from "node:test";
import assert from "node:assert/strict";
import { secretsFromEnv } from "./sync-secrets.mjs";

test("only runtime secrets with real values are synced", () => {
  assert.deepEqual(
    secretsFromEnv({ TURNSTILE_SECRET_KEY: "abc", BOOTSTRAP_ADMIN_EMAILS: "", CLOUDFLARE_API_TOKEN: "deploy-only", MAIL_FROM: "x@example.com" }),
    { TURNSTILE_SECRET_KEY: "abc" },
  );
});

test("placeholders are never pushed", () => {
  assert.deepEqual(secretsFromEnv({ TURNSTILE_SECRET_KEY: "SET_BY_x", BOOTSTRAP_ADMIN_EMAILS: "REPLACE_ME_y" }), {});
});
