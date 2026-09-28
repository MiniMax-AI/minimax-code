import {
  createTimer,
  toggle,
  tick,
  remaining,
  formatMMSS,
  POMODORO_MS,
  DEMO_MS,
  HOLD_MS,
  idleHold,
  beginHold,
  cancelHold,
  holdProgress,
  stepHold,
} from "./timer.mjs";

const demo = new URLSearchParams(location.search).get("demo") === "1";
const $ = (s) => document.querySelector(s);
const action = $("#action"),
  status = $("#status"),
  timerEl = $("#timer"),
  hint = $("#hint"),
  pet = $(".pet");

let state = createTimer(demo ? DEMO_MS : POMODORO_MS);
let hold = idleHold();
let raf = 0;
let swallowClick = false; // the click that follows a completed hold must not resume

if (demo) $("#demo-badge").hidden = false;

const copy = {
  idle: [
    "Ready to focus?",
    "Start",
    demo
      ? "DEMO MODE: a 10-second session. Click Start."
      : "Click Start for a 25-minute focus session.",
  ],
  running: [
    "Focusing… I’m right here.",
    "Hold to pause",
    `Press and hold (or hold Space/Enter) for ${HOLD_MS / 1000}s to pause.`,
  ],
  paused: [
    "Paused. Take a breath.",
    "Resume",
    "Click Resume to pick up where you left off.",
  ],
  done: ["Done! Nice work.", "Reset", "Click Reset for another session."],
};

function render(now = Date.now()) {
  const [s, label, h] = copy[state.status];
  status.textContent = s;
  action.textContent = label;
  hint.textContent = h;
  timerEl.textContent = formatMMSS(remaining(state, now));
  const p = holdProgress(hold, now);
  action.style.setProperty("--hold", p);
  action.classList.toggle("holding", hold.startedAt !== null);
  pet.dataset.mood = state.status;
  pet.setAttribute(
    "aria-label",
    state.status === "running"
      ? "A focused pixel pet"
      : state.status === "done"
        ? "A celebrating pixel pet"
        : "A friendly blinking pixel pet",
  );
  document.title =
    state.status === "running"
      ? `${timerEl.textContent} · Pocket Pet`
      : "Pocket Pet · MiniMax Code";
}

function loop() {
  const now = Date.now();
  const r = stepHold(state, hold, now);
  if (r.fired) swallowClick = true;
  if (hold.startedAt !== null || r.fired) ({ timer: state, hold } = r);
  state = tick(state, now);
  if (state.status !== "running") hold = idleHold();
  render(now);
  cancelAnimationFrame(raf);
  raf = state.status === "running" ? requestAnimationFrame(loop) : 0;
}

function startHold() {
  if (state.status !== "running" || hold.startedAt !== null) return;
  swallowClick = false;
  hold = beginHold(Date.now());
  loop();
}
function abortHold() {
  if (hold.startedAt === null) return;
  hold = cancelHold(hold);
  render();
}

// Start / resume / reset stay ordinary clicks. A click while running never pauses.
action.addEventListener("click", () => {
  if (swallowClick) {
    swallowClick = false;
    return;
  }
  if (state.status === "running") return;
  state = toggle(state, Date.now());
  loop();
});

action.addEventListener("pointerdown", (e) => {
  swallowClick = false; // fresh gesture; a stale swallow must not eat the next Resume
  if (e.button !== 0 || state.status !== "running") return;
  action.setPointerCapture(e.pointerId);
  startHold();
});
action.addEventListener("pointerup", abortHold);
action.addEventListener("pointercancel", abortHold);
action.addEventListener("lostpointercapture", abortHold);

const isActivate = (e) => e.key === " " || e.key === "Enter";
action.addEventListener("keydown", (e) => {
  if (!isActivate(e)) return;
  if (e.repeat) {
    e.preventDefault();
    return;
  } // auto-repeat must never resume after a hold-pause
  if (state.status !== "running") return;
  e.preventDefault(); // no synthetic click while running
  if (!e.repeat) startHold();
});
action.addEventListener("keyup", (e) => {
  if (!isActivate(e)) return;
  if (hold.startedAt !== null || swallowClick || state.status === "running") {
    e.preventDefault(); // stop Space's keyup click
    swallowClick = false;
    abortHold();
  }
});

window.addEventListener("blur", abortHold);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) abortHold();
  else loop();
});
// Low-frequency fallback so the title/completion updates in background tabs.
setInterval(() => {
  if (state.status === "running") loop();
}, 1000);

render();
