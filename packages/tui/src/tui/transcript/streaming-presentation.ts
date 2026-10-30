/**
 * Paces how often a streaming transcript unit is presented again.
 *
 * A streaming assistant paragraph is re-rendered in full on every frame, and the
 * runtime delivers small provider chunks one event at a time. With tiny chunks the
 * terminal ends up drawing hundreds of frames for one paragraph, each costing more
 * as the paragraph grows. Between commits this keeps presenting the unit's last
 * rendered lines, at an interval derived from what that render cost, and schedules
 * one trailing render so the newest text always reaches the screen.
 *
 * Only presentation is paced: transcript state, other units, the editor and the
 * status line still render on every frame. A unit that is no longer streaming,
 * or whose width changed, always renders immediately.
 */

/** Never hold a unit for less than one engine frame; shorter holds save nothing. */
const MIN_INTERVAL_MS = 16;
/** Upper bound so a very expensive paragraph still visibly advances several times a second. */
const MAX_INTERVAL_MS = 250;
/** Spend at most about half of the wall time re-presenting one streaming unit. */
const COST_MULTIPLIER = 2;

export interface StreamingPresentationClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultClock: StreamingPresentationClock = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface PresentedUnit {
  width: number;
  lines: readonly string[];
  committedAtMs: number;
  intervalMs: number;
  timer?: unknown;
}

export class StreamingPresentationPacer {
  private readonly units = new Map<string, PresentedUnit>();
  private readonly clock: StreamingPresentationClock;

  constructor(
    private readonly requestRender: () => void,
    clock: StreamingPresentationClock = defaultClock,
  ) {
    this.clock = clock;
  }

  now(): number {
    return this.clock.now();
  }

  /**
   * Lines to present again instead of rendering `key`, or `undefined` when the
   * unit must render now. Holding schedules one trailing render per unit.
   */
  held(key: string, width: number): readonly string[] | undefined {
    const unit = this.units.get(key);
    if (!unit || unit.width !== width) return undefined;
    const dueInMs = unit.committedAtMs + unit.intervalMs - this.clock.now();
    if (dueInMs <= 0) return undefined;
    if (unit.timer === undefined) {
      unit.timer = this.clock.setTimeout(() => {
        unit.timer = undefined;
        this.requestRender();
      }, dueInMs);
    }
    return unit.lines;
  }

  /** Record freshly rendered streaming lines and what rendering them cost. */
  commit(key: string, width: number, lines: readonly string[], costMs: number): void {
    const previous = this.units.get(key);
    if (previous?.timer !== undefined) this.clock.clearTimeout(previous.timer);
    this.units.set(key, {
      width,
      lines,
      committedAtMs: this.clock.now(),
      intervalMs: Math.min(
        MAX_INTERVAL_MS,
        Math.max(MIN_INTERVAL_MS, Math.ceil(costMs * COST_MULTIPLIER)),
      ),
    });
  }

  /** Forget a unit that stopped streaming; its next render is final and immediate. */
  release(key: string): void {
    const unit = this.units.get(key);
    if (!unit) return;
    if (unit.timer !== undefined) this.clock.clearTimeout(unit.timer);
    this.units.delete(key);
  }

  /** Forget units that are no longer rendered. */
  retain(activeKeys: ReadonlySet<string>): void {
    for (const key of [...this.units.keys()]) {
      if (!activeKeys.has(key)) this.release(key);
    }
  }

  /** Forget everything, e.g. after a theme change or when the view is disposed. */
  reset(): void {
    for (const key of [...this.units.keys()]) this.release(key);
  }
}
