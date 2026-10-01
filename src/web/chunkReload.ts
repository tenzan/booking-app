// After a deploy the hashed chunks of the previous build are gone, and their URLs return index.html: a page that was
// opened before the deploy cannot load its lazy (staff) pages any more. Reload once to pick up the new build; if that
// happened very recently (or the browser keeps no session storage), don't loop: the route error boundary shows a
// calm message with a Reload button instead.

const KEY = "app:chunk-reload-at";
/** A second failure this soon after an automatic reload is not a stale build: stop reloading. */
const QUIET_MS = 60_000;

let reloading = false;
/** True once an automatic reload has been started (the page is about to go away). */
export const isReloading = () => reloading;

/** Starts one automatic reload unless one ran within the last minute in this tab. True when it started. */
export function reloadOnceForNewBuild(): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY) ?? 0);
    if (Date.now() - last < QUIET_MS) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    return false; // no way to remember that we tried: never risk a reload loop
  }
  reloading = true;
  window.location.reload();
  return true;
}

/** Vite dispatches `vite:preloadError` when a dynamic import (or its preloads) fails; preventing it swallows the error. */
export function installChunkReload(): void {
  window.addEventListener("vite:preloadError", (e) => {
    if (reloadOnceForNewBuild()) e.preventDefault();
  });
}
