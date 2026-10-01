const real = () => Date.now();

/** All worker code reads time through this so tests can control it. */
export const clock: { now: () => number } = { now: real };

/** Pin the clock to `ms`; `null` restores real time. */
export function setNow(ms: number | null): void {
  clock.now = ms === null ? real : () => ms;
}
