// Deadlines in Runtime tests scale with the machine that runs them. CI runners are shared and
// often overloaded, so a fixed deadline that holds on a quiet laptop fails on a busy runner.
// MAVIS_TEST_TIME_SCALE (default 1, set by the Runtime CI jobs) multiplies every test, hook, wait
// and abort deadline, the way Node.js core stretches its own test timeouts with
// common.platformTimeout(). Lint rejects fixed deadlines; see packages/local-runtime-v2/AGENTS.md.
// This module has no Vitest import so vitest.config.ts can use it too.

const MAX_SCALE = 10;

function parseScale(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 1;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1 || value > MAX_SCALE) {
    throw new Error(`MAVIS_TEST_TIME_SCALE must be a number from 1 to ${MAX_SCALE}, got "${raw}"`);
  }
  return value;
}

export const TEST_TIME_SCALE = parseScale(process.env.MAVIS_TEST_TIME_SCALE);

/** A test, hook, wait or abort deadline, stretched by MAVIS_TEST_TIME_SCALE. */
export function scaledTimeout(ms: number): number {
  return Math.ceil(ms * TEST_TIME_SCALE);
}
