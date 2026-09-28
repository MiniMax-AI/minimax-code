import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTimer,
  start,
  toggle,
  HOLD_MS,
  beginHold,
  cancelHold,
  holdProgress,
  stepHold,
  idleHold,
} from "./timer.mjs";

const running = () => start(createTimer(), 0);

test("hold threshold is 800 ms", () => assert.equal(HOLD_MS, 800));

test("holding under 800 ms does not pause", () => {
  const r = stepHold(running(), beginHold(1000), 1000 + 799);
  assert.equal(r.fired, false);
  assert.equal(r.timer.status, "running");
  assert.ok(holdProgress(r.hold, 1799) < 1);
});

test("holding for 800 ms pauses at the threshold", () => {
  const r = stepHold(running(), beginHold(1000), 1800);
  assert.equal(r.fired, true);
  assert.equal(r.timer.status, "paused");
  assert.equal(r.hold.startedAt, null);
});

test("a short click (released early) leaves the timer running", () => {
  let t = running(),
    h = beginHold(1000);
  ({ timer: t, hold: h } = stepHold(t, h, 1150));
  h = cancelHold(); // pointerup before threshold
  const later = stepHold(t, h, 99_999);
  assert.equal(later.fired, false);
  assert.equal(later.timer.status, "running");
});

test("cancellation (pointercancel / lost capture / blur) discards the pending hold", () => {
  const h = cancelHold(beginHold(0));
  assert.deepEqual(h, idleHold());
  assert.equal(holdProgress(h, 10_000), 0);
  assert.equal(stepHold(running(), h, 10_000).timer.status, "running");
});

test("a new hold after cancellation restarts from zero", () => {
  const h = beginHold(5000); // canceled one at 0 is gone
  assert.equal(stepHold(running(), h, 5500).fired, false);
  assert.equal(stepHold(running(), h, 5800).fired, true);
});

test("holds do nothing when the timer is not running", () => {
  const r = stepHold(createTimer(), beginHold(0), 5000);
  assert.equal(r.fired, false);
  assert.equal(r.timer.status, "idle");
  assert.equal(toggle(createTimer(), 0).status, "running"); // start stays a normal click
});
