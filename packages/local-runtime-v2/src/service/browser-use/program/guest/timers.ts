import type { QuickJSContext, QuickJSDeferredPromise } from 'quickjs-emscripten';

/**
 * Timers of a Browser program guest. The Browser program Worker loads this
 * module from app.asar.unpacked in packaged Electron, so it uses only Node
 * built-ins and quickjs-emscripten types.
 */

/**
 * Longest single setTimeout/sleep, the same order as the longest Browser
 * wait. The program wall clock still bounds the sum.
 */
const GUEST_TIMER_MAX_DELAY_MS = 30_000;

/** setTimeout/sleep waits in flight: the Node timer and the guest promise it settles. */
export type HostSleeps = Map<NodeJS.Timeout, QuickJSDeferredPromise>;

/**
 * `__programSleep(ms)`: a guest promise settled by a timer on this thread, so
 * the guest waits without running and without spending its compute budget.
 * The guest setup checks the delay (0..GUEST_TIMER_MAX_DELAY_MS) and hides
 * this function behind setTimeout/sleep; the clamp only guards the host. A
 * stopped program is never resumed.
 */
export function installHostSleep(
  context: QuickJSContext,
  sleeps: HostSleeps,
  isStopped: () => boolean,
  resume: () => void,
): void {
  const sleep = context.newFunction('__programSleep', (msHandle) => {
    const deferred = context.newPromise();
    const requested = context.getNumber(msHandle);
    const ms = Number.isFinite(requested)
      ? Math.min(Math.max(requested, 0), GUEST_TIMER_MAX_DELAY_MS)
      : 0;
    const timer = setTimeout(() => {
      sleeps.delete(timer);
      if (isStopped() || !deferred.alive) return;
      deferred.resolve(context.undefined);
      deferred.dispose();
      queueMicrotask(resume);
    }, ms);
    sleeps.set(timer, deferred);
    return deferred.handle;
  });
  context.setProp(context.global, '__programSleep', sleep);
  sleep.dispose();
}

/** Stops every pending wait; the guest promises are disposed by their owner. */
export function clearHostSleeps(sleeps: HostSleeps): void {
  for (const timer of sleeps.keys()) clearTimeout(timer);
  sleeps.clear();
}

const WHERE = 'a Browser program';
const INSTEAD =
  'Wait for what you expect instead: locator.waitFor(), page.waitFor({ text }) or page.waitForURL().';

/**
 * Guest timers, run before the Browser library. A delay is a plain number of
 * ms up to GUEST_TIMER_MAX_DELAY_MS; a longer one throws at once instead of
 * being cut short, so the program never acts earlier than it asked to. The
 * wait counts against the program's wall clock and not its compute budget. A
 * cleared or still pending timer is dropped when the program returns. Needs
 * `installHostSleep` on the host side.
 */
export const GUEST_TIMERS_SETUP = `
const __programSleepHost = globalThis.__programSleep;
delete globalThis.__programSleep;
const __programClearedTimers = new Set();
let __programTimerSeq = 0;
const __programDelay = (name, ms) => {
  const delay = ms === undefined ? 0 : Number(ms);
  if (!Number.isFinite(delay) || delay < 0) throw new RangeError(name + " needs a delay of 0 to ${GUEST_TIMER_MAX_DELAY_MS} ms.");
  if (delay > ${GUEST_TIMER_MAX_DELAY_MS}) throw new RangeError(name + " waits at most ${GUEST_TIMER_MAX_DELAY_MS} ms in ${WHERE}; nothing waited. ${INSTEAD}");
  return delay;
};
globalThis.setTimeout = function (callback, ms, ...args) {
  if (typeof callback !== "function") throw new TypeError("setTimeout in ${WHERE} needs a function callback.");
  const delay = __programDelay("setTimeout", ms);
  const id = ++__programTimerSeq;
  __programSleepHost(delay).then(() => {
    if (__programClearedTimers.delete(id)) return;
    try {
      callback(...args);
    } catch (error) {
      console.error("Uncaught error in setTimeout callback: " + String(error));
    }
  });
  return id;
};
globalThis.clearTimeout = (id) => { if (typeof id === "number" && id > 0 && id <= __programTimerSeq) __programClearedTimers.add(id); };
globalThis.sleep = (ms) => __programSleepHost(__programDelay("sleep", ms));
`;
