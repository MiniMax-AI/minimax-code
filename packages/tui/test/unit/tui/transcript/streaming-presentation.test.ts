import { describe, expect, it, vi } from 'vitest';

import {
  StreamingPresentationPacer,
  type StreamingPresentationClock,
} from '../../../../src/tui/transcript/streaming-presentation.js';

function fakeClock(): StreamingPresentationClock & {
  advance(ms: number): void;
  pending(): number;
} {
  let nowMs = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => nowMs,
    setTimeout(callback, delayMs) {
      const id = nextId++;
      timers.set(id, { at: nowMs + delayMs, run: callback });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    advance(ms) {
      nowMs += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at > nowMs) continue;
        timers.delete(id);
        timer.run();
      }
    },
    pending: () => timers.size,
  };
}

describe('StreamingPresentationPacer', () => {
  it('re-presents the last lines until the cost-sized interval elapses', () => {
    const clock = fakeClock();
    const requestRender = vi.fn();
    const pacer = new StreamingPresentationPacer(requestRender, clock);

    pacer.commit('cell:a', 80, ['first frame'], 40);

    // Held: the unit is presented again without rendering, and one trailing
    // frame is scheduled so the newest text still reaches the screen.
    expect(pacer.held('cell:a', 80)).toEqual(['first frame']);
    expect(pacer.held('cell:a', 80)).toEqual(['first frame']);
    expect(clock.pending()).toBe(1);
    expect(requestRender).not.toHaveBeenCalled();

    clock.advance(80);
    expect(requestRender).toHaveBeenCalledOnce();
    expect(pacer.held('cell:a', 80)).toBeUndefined();
  });

  it('never holds longer than the maximum interval', () => {
    const clock = fakeClock();
    const pacer = new StreamingPresentationPacer(vi.fn(), clock);

    pacer.commit('cell:a', 80, ['lines'], 10_000);
    clock.advance(250);

    expect(pacer.held('cell:a', 80)).toBeUndefined();
  });

  it('always renders immediately when the width changed or the unit was released', () => {
    const clock = fakeClock();
    const pacer = new StreamingPresentationPacer(vi.fn(), clock);

    pacer.commit('cell:a', 80, ['lines'], 40);
    expect(pacer.held('cell:a', 100)).toBeUndefined();

    pacer.release('cell:a');
    expect(pacer.held('cell:a', 80)).toBeUndefined();
    expect(clock.pending()).toBe(0);
  });

  it('forgets units that are no longer rendered', () => {
    const clock = fakeClock();
    const pacer = new StreamingPresentationPacer(vi.fn(), clock);

    pacer.commit('cell:a', 80, ['a'], 40);
    pacer.commit('cell:b', 80, ['b'], 40);
    pacer.retain(new Set(['cell:b']));

    expect(pacer.held('cell:a', 80)).toBeUndefined();
    expect(pacer.held('cell:b', 80)).toEqual(['b']);

    pacer.reset();
    expect(pacer.held('cell:b', 80)).toBeUndefined();
    expect(clock.pending()).toBe(0);
  });
});
