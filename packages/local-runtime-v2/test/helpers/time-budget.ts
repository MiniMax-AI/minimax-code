import { vi } from 'vitest';
import { scaledTimeout } from './time-scale.js';

export { scaledTimeout, TEST_TIME_SCALE } from './time-scale.js';

// vi.waitFor and vi.waitUntil give up after one second unless told otherwise.
const VITEST_DEFAULT_WAIT_MS = 1_000;

type WaitOptions = number | { readonly timeout?: number; readonly interval?: number };

function scaledWait(options: WaitOptions | undefined): { timeout: number; interval?: number } {
  if (typeof options === 'number') return { timeout: scaledTimeout(options) };
  return { ...options, timeout: scaledTimeout(options?.timeout ?? VITEST_DEFAULT_WAIT_MS) };
}

/** vi.waitFor whose deadline is stretched by MAVIS_TEST_TIME_SCALE. */
export const waitFor: typeof vi.waitFor = (callback, options) =>
  vi.waitFor(callback, scaledWait(options));

/** vi.waitUntil whose deadline is stretched by MAVIS_TEST_TIME_SCALE. */
export const waitUntil: typeof vi.waitUntil = (callback, options) =>
  vi.waitUntil(callback, scaledWait(options));

/**
 * Lets queued callbacks, promise chains, due timers and finished I/O run: `turns` rounds of a
 * zero-delay timer, about 25 ms by default. setImmediate would not do: 20 rounds of it pass in about
 * 1 ms. To assert that something has not happened yet, hold the step that would make it happen behind
 * a gate, drain, check, then release. Under fake timers, advance the clock instead.
 */
export async function drainEventLoop(turns = 20): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Whether the promise has neither resolved nor rejected once the event loop has drained. */
export async function isStillPending(promise: Promise<unknown>, turns?: number): Promise<boolean> {
  let settled = false;
  const markSettled = () => {
    settled = true;
  };
  void promise.then(markSettled, markSettled);
  await drainEventLoop(turns);
  return !settled;
}
