import { formatTokensPerSecond } from '../rendering/output-rate.js';
import type { ChalkInstance } from 'chalk';
import { formatTuiDuration } from '../rendering/duration.js';
import type { Component } from '../rendering/component.js';
import { truncateToWidth, visibleWidth } from '../rendering/text.js';
import { tuiChalk, tuiColors as colors } from '../theme/runtime.js';
import { sanitizeTerminalText } from '../rendering/terminal-text.js';
import { formatTuiKeybinding, type TuiKeybindingRegistry } from './keybindings.js';

export type TuiActivityPhase =
  | 'idle'
  | 'loading'
  | 'running'
  | 'retrying'
  | 'reconnecting'
  | 'compacting'
  | 'stopping'
  | 'error';

/** Controls that act on the run the activity line is reporting, not on the composer draft. */
export type TuiActivityControl = 'guide' | 'details' | 'interrupt';

export interface TuiActivityLineState {
  phase: TuiActivityPhase;
  runId?: string;
  startedAtMs?: number;
  loadingTarget?: 'session';
  message?: string;
  outputTokensPerSecond?: number;
  outputTokensPerSecondEstimated?: boolean;
  /**
   * A failed turn whose error text is already rendered in the transcript, so the
   * status line must report the failure without repeating the message. It lets
   * automation distinguish a settled failure from an ordinary idle: the marker
   * still leads with `error`, followed by `failed`.
   */
  errorSettled?: boolean;
  controls?: readonly TuiActivityControl[];
  /**
   * What Enter does with the composer draft while this run is in flight. The activity line
   * absorbs the composer header row so the two never explain the same moment on two rows.
   */
  draftLabel?: string;
  /** Replaces the `Running` label while the run waits on one known step; other phases keep theirs. */
  label?: string;
  /**
   * Start of the step the clock times instead of the run, such as one advisor call. The run's own
   * start is kept, so the clock returns to the run once the step is gone from the state.
   */
  stepStartedAtMs?: number;
  /** Muted text after the elapsed time, for what only matters once a wait runs long. */
  note?: TuiActivityNote;
}

export interface TuiActivityNote {
  readonly text: string;
  /** Hidden until the line's own clock has run this long. */
  readonly afterMs: number;
}

export interface TuiActivityLineOptions {
  animate?: boolean;
  now?: () => number;
  requestRender?: () => void;
  chalk?: ChalkInstance;
  keybindings?: TuiKeybindingRegistry;
}

const ACTIVITY_ANIMATION_INTERVAL_MS = 80;
const ACTIVITY_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/** Elapsed time is noise before the user's natural patience starts to drain. */
const ELAPSED_REVEAL_AFTER_MS = 1_500;

/** Widest-first render order; interrupt is the last control to survive a narrow terminal. */
const CONTROL_ORDER = [
  'guide',
  'details',
  'interrupt',
] as const satisfies readonly TuiActivityControl[];

const CONTROL_KEYBINDINGS: Record<TuiActivityControl, string> = {
  guide: 'run.submit-guidance',
  details: 'composer.toggle-details',
  interrupt: 'app.interrupt',
};

/**
 * One verb per control. The row carries a shortcut, a draft label and three controls, so the
 * verbs stay short enough to keep the whole line inside a standard 80-column terminal.
 */
const CONTROL_VERBS: Record<TuiActivityControl, string> = {
  guide: 'steer',
  details: 'details',
  interrupt: 'stop',
};

export class TuiActivityLine implements Component {
  private state: TuiActivityLineState = { phase: 'idle' };
  private readonly animate: boolean;
  private readonly now: () => number;
  private readonly requestRender: () => void;
  private readonly chalk: ChalkInstance;
  private readonly keybindings?: TuiKeybindingRegistry;
  private frameIndex = 0;
  private activeStartedAtMs: number | undefined;
  private animationTimer: ReturnType<typeof setInterval> | undefined;
  private animationPaused = false;

  constructor(state: TuiActivityLineState, options: TuiActivityLineOptions = {}) {
    this.animate = options.animate ?? true;
    this.now = options.now ?? Date.now;
    this.requestRender = options.requestRender ?? (() => undefined);
    this.chalk = options.chalk ?? tuiChalk;
    this.keybindings = options.keybindings;
    this.setState(state);
  }

  setState(state: TuiActivityLineState): void {
    const wasActive = isTimedPhase(this.state.phase);
    const isActive = isTimedPhase(state.phase);
    const continuesRun = state.runId !== undefined && state.runId === this.state.runId;
    const activityChanged = activityKey(state) !== activityKey(this.state);
    const newRun =
      isActive && (!wasActive || (state.runId !== undefined && state.runId !== this.state.runId));

    this.state = state;
    if (activityChanged) this.frameIndex = 0;
    if (state.startedAtMs !== undefined) {
      this.activeStartedAtMs = state.startedAtMs;
    } else if (newRun && !continuesRun) {
      this.activeStartedAtMs = this.now();
      this.frameIndex = 0;
    } else if (!isActive && !continuesRun) {
      this.activeStartedAtMs = undefined;
      this.frameIndex = 0;
    }

    if (isActive && this.animate && !this.animationPaused) this.startAnimation();
    else this.stopAnimation();
  }

  setAnimationPaused(paused: boolean): void {
    if (this.animationPaused === paused) return;
    this.animationPaused = paused;
    if (paused) {
      this.stopAnimation();
      return;
    }
    if (this.animate && isTimedPhase(this.state.phase)) this.startAnimation();
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = normalizeWidth(width);
    if (safeWidth === 0 || this.state.phase === 'idle') return [];
    // Avoid repeating a failure already shown in the transcript.
    if (this.state.phase === 'error' && this.state.errorSettled && !this.state.message?.trim()) {
      return [];
    }

    const phase = renderPhase(this.state);
    const timed = isTimedPhase(this.state.phase);
    const glyph =
      this.animate && timed
        ? (ACTIVITY_SPINNER_FRAMES[this.frameIndex] ?? ACTIVITY_SPINNER_FRAMES[0])
        : phase.icon;
    const primary = `${this.chalk.hex(colors.dim)('  ')}${this.chalk.bold.hex(phase.color)(
      glyph,
    )} ${this.chalk.bold.hex(phase.color)(phase.label)}`;

    const clockStartedAtMs = this.state.stepStartedAtMs ?? this.activeStartedAtMs;
    const elapsedMs = timed ? this.now() - (clockStartedAtMs ?? this.now()) : 0;
    // Bound to the phase word rather than separated by a dot: the elapsed time qualifies the
    // phase, and the row needs the width for the draft label and controls that follow.
    const elapsed =
      timed && elapsedMs >= ELAPSED_REVEAL_AFTER_MS
        ? ` ${this.chalk.hex(colors.muted)(formatTuiDuration(elapsedMs / 1_000))}`
        : '';
    const note = timed ? formatNote(this.state.note, elapsedMs, this.chalk) : '';
    const draftLabel = this.state.draftLabel?.trim()
      ? `${this.chalk.hex(colors.dim)(' · ')}${this.chalk.hex(colors.muted)(
          oneLine(this.state.draftLabel),
        )}`
      : '';
    const outputRate = formatOutputRate(
      this.state.outputTokensPerSecond,
      this.state.outputTokensPerSecondEstimated === true,
      this.chalk,
    );

    const rendered = `${primary}${elapsed}${note}${outputRate}${draftLabel}`;
    return [
      truncateToWidth(
        this.fitControls(rendered, safeWidth),
        safeWidth,
        this.chalk.hex(colors.dim)('…'),
      ),
    ];
  }

  dispose(): void {
    this.stopAnimation();
  }

  /**
   * Run controls are the first thing to go when the line gets tight: the phase and elapsed
   * time describe what is happening, the controls only offer what you may do about it.
   */
  private fitControls(base: string, width: number): string {
    const controls = CONTROL_ORDER.filter((control) => this.state.controls?.includes(control));
    for (let start = 0; start < controls.length; start += 1) {
      const candidate = `${base}${this.renderControls(controls.slice(start))}`;
      if (visibleWidth(candidate) <= width) return candidate;
    }
    return base;
  }

  private renderControls(controls: readonly TuiActivityControl[]): string {
    return controls
      .map(
        (control) =>
          `${this.chalk.hex(colors.dim)(' · ')}${this.chalk.hex(colors.muted)(
            `${formatTuiKeybinding(CONTROL_KEYBINDINGS[control], this.keybindings)} ${CONTROL_VERBS[control]}`,
          )}`,
      )
      .join('');
  }

  private startAnimation(): void {
    if (this.animationTimer) return;
    this.animationTimer = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % ACTIVITY_SPINNER_FRAMES.length;
      this.requestRender();
    }, ACTIVITY_ANIMATION_INTERVAL_MS);
    this.animationTimer.unref();
  }

  private stopAnimation(): void {
    if (!this.animationTimer) return;
    clearInterval(this.animationTimer);
    this.animationTimer = undefined;
  }
}

function renderPhase(state: TuiActivityLineState): {
  icon: string;
  label: string;
  color: string;
} {
  if (state.phase === 'loading') {
    return {
      icon: '◇',
      label: state.loadingTarget === 'session' ? 'Loading session' : 'Loading',
      color: colors.signal,
    };
  }
  if (state.phase === 'running') {
    const label = state.label?.trim() ? oneLine(state.label) : 'Running';
    return { icon: '◇', label, color: colors.orbit };
  }
  if (state.phase === 'retrying') {
    return {
      icon: '◇',
      label: state.message ? oneLine(state.message) : 'Retrying model request',
      color: colors.orbit,
    };
  }
  if (state.phase === 'reconnecting') {
    return {
      icon: '◇',
      label: state.message ? `Reconnecting · ${oneLine(state.message)}` : 'Reconnecting',
      color: colors.signal,
    };
  }
  if (state.phase === 'compacting') {
    return { icon: '◇', label: 'Compacting context', color: colors.orbit };
  }
  if (state.phase === 'stopping') {
    return { icon: '!', label: 'Stopping response', color: colors.error };
  }
  return {
    icon: '×',
    label: state.message ? `Error · ${oneLine(state.message)}` : 'Runtime error',
    color: colors.error,
  };
}

export function resolveTuiActivityColor(state: TuiActivityLineState): string {
  if (state.phase === 'error' || state.phase === 'stopping') return colors.error;
  return state.phase === 'running' || state.phase === 'retrying' || state.phase === 'compacting'
    ? colors.orbit
    : colors.signal;
}

function isTimedPhase(phase: TuiActivityPhase): boolean {
  return phase !== 'idle' && phase !== 'error';
}

function formatOutputRate(
  value: number | undefined,
  estimated: boolean,
  chalk: ChalkInstance,
): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '';
  return `${chalk.hex(colors.dim)(' · ')}${chalk.bold.hex(colors.signal)(
    `⚡ ${estimated ? '~' : ''}${formatTokensPerSecond(value)} tok/s`,
  )}`;
}

function formatNote(
  note: TuiActivityNote | undefined,
  elapsedMs: number,
  chalk: ChalkInstance,
): string {
  if (!note?.text.trim() || elapsedMs < note.afterMs) return '';
  return `${chalk.hex(colors.dim)(' · ')}${chalk.hex(colors.muted)(oneLine(note.text))}`;
}

function activityKey(state: TuiActivityLineState): string {
  return `${state.phase}\u001F${state.loadingTarget ?? ''}\u001F${state.message ?? ''}`;
}

function oneLine(value: string): string {
  return sanitizeTerminalText(value).replace(/\s+/gu, ' ').trim();
}

function normalizeWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
}
