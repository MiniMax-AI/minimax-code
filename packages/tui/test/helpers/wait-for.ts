import { vi } from "vitest";

/**
 * `vi.waitFor` with a short polling interval. The default 50 ms interval makes every
 * wait idle for a full tick even when the awaited state settles within a few
 * event-loop turns; the timeout and assertion semantics are unchanged.
 */
export const waitFor: typeof vi.waitFor = (callback, options) =>
  vi.waitFor(callback, {
    interval: 5,
    ...(typeof options === "number" ? { timeout: options } : options),
  });
