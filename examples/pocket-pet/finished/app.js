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

if (demo) {
  $("#demo-badge").hidden = false;
  $("#focus-mode").removeAttribute("aria-current");
  $("#quick-mode").setAttribute("aria-current", "page");
}
const progress = $(".session-track");
const power = $(".power");
let feedbackUntil = 0;
function setText(element, value) {
  if (element.textContent !== value) element.textContent = value;
}

const copy = {
  idle: ["Ready when you are.", "Start", "Tap Start. I’ll keep you company."],
  running: [
    "You’ve got this.",
    "Hold to pause",
    `Need a breather? Hold for ${HOLD_MS / 1000} seconds.`,
  ],
  paused: ["Take your time.", "Resume", "Tap Resume whenever you’re ready."],
  done: ["Look at you go!", "Reset", "One small win. Ready for another?"],
};

function render(now = Date.now()) {
  const [s, label, h] = copy[state.status];
  setText(status, s);
  setText(action, label);
  setText(
    hint,
    now < feedbackUntil && state.status === "running"
      ? "Still focused! Hold a little longer to pause."
      : h,
  );
  const left = remaining(state, now);
  setText(timerEl, formatMMSS(left));
  const fraction = 1 - left / state.durationMs;
  progress.style.setProperty("--progress", fraction);
  const percent = String(Math.round(fraction * 100));
  if (progress.getAttribute("aria-valuenow") !== percent)
    progress.setAttribute("aria-valuenow", percent);
  const powerLabel = {
    idle: "READY",
    running: "FOCUS",
    paused: "REST",
    done: "NICE!",
  }[state.status];
  if (power.lastChild.textContent !== " " + powerLabel)
    power.lastChild.textContent = " " + powerLabel;
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
  if (state.status === "running") {
    feedbackUntil = Date.now() + 1800;
    render();
    return;
  }
  feedbackUntil = 0;
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

action.addEventListener("blur", abortHold);
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
