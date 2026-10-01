import type { Env } from "../env";
import { safeError } from "../mail/outbox";
import { sendApprovalReminders, sendEscalations } from "./approval-reminders";
import { cleanup } from "./cleanup";
import { completeEnded } from "./completion";
import { expirePending } from "./expiry";

export interface SweepResult {
  /** Rows each sweep handled; `cleanup` is null when it was not its hour. */
  counts: { expiry: number; reminders: number; escalations: number; completion: number; cleanup: number | null };
  /** Sweeps that threw (logged, and the others still ran). */
  failed: string[];
}

/**
 * The per-minute lifecycle sweeps. Each is independent (one failing never stops the rest), bounded, and safe to run in
 * two overlapping invocations: state changes commit through guarded capacity batches, mail goes through dedupe keys.
 * Expiry runs first so a request past its deadline is expired rather than reminded.
 */
export async function runSweeps(env: Env, now: number): Promise<SweepResult> {
  const result: SweepResult = { counts: { expiry: 0, reminders: 0, escalations: 0, completion: 0, cleanup: null }, failed: [] };
  const step = async (name: keyof SweepResult["counts"], run: () => Promise<number>) => {
    try {
      result.counts[name] = await run();
    } catch (e) {
      result.failed.push(name);
      console.error("sweep", name, safeError(e));
    }
  };
  await step("expiry", () => expirePending(env, now));
  await step("reminders", () => sendApprovalReminders(env, now));
  await step("escalations", () => sendEscalations(env, now));
  // A proposal-expiry sweep belongs here, before completion.
  await step("completion", () => completeEnded(env, now));
  if (new Date(now).getUTCMinutes() === 0) await step("cleanup", () => cleanup(env, now));
  return result;
}
