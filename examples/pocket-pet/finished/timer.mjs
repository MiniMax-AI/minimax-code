// Pure Pomodoro timer logic. No DOM, no clocks: callers pass `now` (ms).
export const POMODORO_MS = 25 * 60 * 1000;
export const DEMO_MS = 10 * 1000;

export function createTimer(durationMs = POMODORO_MS) {
  return {
    status: "idle",
    durationMs,
    remainingMs: durationMs,
    deadline: null,
  };
}

export function remaining(state, now) {
  if (state.status !== "running") return state.remainingMs;
  return Math.max(0, state.deadline - now);
}

export function start(state, now) {
  if (state.status === "running" || state.status === "done") return state;
  return { ...state, status: "running", deadline: now + state.remainingMs };
}

export function pause(state, now) {
  if (state.status !== "running") return state;
  const left = remaining(state, now);
  if (left === 0)
    return { ...state, status: "done", remainingMs: 0, deadline: null };
  return { ...state, status: "paused", remainingMs: left, deadline: null };
}

export const resume = (state, now) =>
  state.status === "paused" ? start(state, now) : state;

export function tick(state, now) {
  if (state.status === "running" && remaining(state, now) === 0) {
    return { ...state, status: "done", remainingMs: 0, deadline: null };
  }
  return state;
}

export const reset = (state) => createTimer(state.durationMs);

export function toggle(state, now) {
  if (state.status === "running") return pause(state, now);
  if (state.status === "paused") return resume(state, now);
  if (state.status === "done") return reset(state);
  return start(state, now);
}

export function formatMMSS(ms) {
  const total = Math.ceil(Math.max(0, ms) / 1000);
  const m = Math.floor(total / 60),
    s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// Hold-to-pause: a pending hold only fires after HOLD_MS of continuous holding.
export const HOLD_MS = 800;
export const idleHold = () => ({ startedAt: null });
export const beginHold = (now) => ({ startedAt: now });
export const cancelHold = () => idleHold();
export function holdProgress(hold, now, thresholdMs = HOLD_MS) {
  if (hold.startedAt === null) return 0;
  return Math.min(1, Math.max(0, now - hold.startedAt) / thresholdMs);
}
// Advance a hold against the timer. Pauses only once the threshold is reached.
export function stepHold(timer, hold, now, thresholdMs = HOLD_MS) {
  if (timer.status !== "running" || hold.startedAt === null)
    return { timer, hold: idleHold(), fired: false };
  if (holdProgress(hold, now, thresholdMs) < 1)
    return { timer, hold, fired: false };
  return { timer: pause(timer, now), hold: idleHold(), fired: true };
}
