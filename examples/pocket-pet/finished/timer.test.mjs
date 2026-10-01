import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTimer,
  start,
  pause,
  resume,
  tick,
  reset,
  toggle,
  remaining,
  formatMMSS,
  POMODORO_MS,
  DEMO_MS,
} from "./timer.mjs";

test("starts at 25:00 and counts down from a deadline", () => {
  const t0 = createTimer();
  assert.equal(formatMMSS(remaining(t0, 0)), "25:00");
  const t = start(t0, 1000);
  assert.equal(t.status, "running");
  assert.equal(t.deadline, 1000 + POMODORO_MS);
  assert.equal(formatMMSS(remaining(t, 1000 + 61_000)), "23:59");
});

test("pause freezes remaining time", () => {
  const p = pause(start(createTimer(), 0), 5 * 60_000);
  assert.equal(p.status, "paused");
  assert.equal(remaining(p, 999_999_999), 20 * 60_000);
});

test("resume continues from paused remaining time", () => {
  const p = pause(start(createTimer(), 0), 60_000);
  const r = resume(p, 500_000);
  assert.equal(r.status, "running");
  assert.equal(remaining(r, 500_000 + 30_000), POMODORO_MS - 60_000 - 30_000);
});

test("completes at the deadline even after a long gap (background tab)", () => {
  const t = start(createTimer(DEMO_MS), 0);
  assert.equal(tick(t, 9_999).status, "running");
  const done = tick(t, 3_600_000);
  assert.equal(done.status, "done");
  assert.equal(formatMMSS(remaining(done, 3_600_000)), "00:00");
});

test("reset returns to idle with full duration", () => {
  const done = tick(start(createTimer(DEMO_MS), 0), DEMO_MS);
  const r = reset(done);
  assert.deepEqual(r, createTimer(DEMO_MS));
  assert.deepEqual(toggle(done, 0), createTimer(DEMO_MS));
});

test("toggle cycles start -> pause -> resume", () => {
  let t = toggle(createTimer(), 0);
  assert.equal(t.status, "running");
  t = toggle(t, 1000);
  assert.equal(t.status, "paused");
  t = toggle(t, 2000);
  assert.equal(t.status, "running");
});
