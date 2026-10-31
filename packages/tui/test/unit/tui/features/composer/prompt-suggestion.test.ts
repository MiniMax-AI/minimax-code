import { describe, expect, it, vi } from 'vitest';

import {
  TuiPromptSuggestionStore,
  type TuiPromptSuggestionMetric,
} from '../../../../../src/tui/features/composer/prompt-suggestion.js';
import type { TuiRuntimeEvent } from '../../../../../src/types/runtime-events.js';

const generated = (turnId: string, suggestion = 'Run the tests'): TuiRuntimeEvent => ({
  type: 'turn.prompt_suggestion.generated',
  timestampMs: 1,
  source: 'runtime',
  sessionId: 'session-1',
  turnId,
  suggestion,
  promptVersion: 'task-next-action-v2',
  elapsedMs: 420,
});

const started = (turnId: string, sessionId = 'session-1'): TuiRuntimeEvent => ({
  type: 'session.start',
  timestampMs: 1,
  source: 'runtime',
  sessionId,
  turnId,
  queueItemIds: [],
});

function createStore() {
  const metrics: TuiPromptSuggestionMetric[] = [];
  const store = new TuiPromptSuggestionStore((metric) => metrics.push(metric));
  return { store, metrics };
}

describe('TuiPromptSuggestionStore', () => {
  it('offers a generated suggestion only in the Session that produced it', () => {
    const { store } = createStore();
    store.observe(started('turn-1'));

    expect(store.observe(generated('turn-1'))).toBe(true);

    expect(store.candidate('session-1')?.text).toBe('Run the tests');
    expect(store.candidate('session-2')).toBeUndefined();
    expect(store.candidate(undefined)).toBeUndefined();
  });

  it('retires the suggestion when a newer Turn starts and refuses its late result', () => {
    const { store } = createStore();
    store.observe(started('turn-1'));
    store.observe(generated('turn-1'));

    expect(store.observe(started('turn-2'))).toBe(true);
    expect(store.candidate('session-1')).toBeUndefined();
    expect(store.observe(generated('turn-1'))).toBe(false);
    expect(store.candidate('session-1')).toBeUndefined();
  });

  it('keeps each Session’s suggestion independent of the others', () => {
    const { store } = createStore();
    store.observe(generated('turn-1'));
    store.observe({ ...generated('turn-7', 'Open the PR'), sessionId: 'session-2' });

    expect(store.observe(started('turn-9', 'session-3'))).toBe(false);
    expect(store.candidate('session-1')?.text).toBe('Run the tests');
    expect(store.candidate('session-2')?.text).toBe('Open the PR');
  });

  it('stores terminal-safe text', () => {
    const { store } = createStore();

    store.observe(generated('turn-1', '  Run the \u001b[31mtests\u001b[0m\u0007  '));

    expect(store.candidate('session-1')?.text).toBe('Run the tests');
  });

  it('retires the suggestion when the conversation is rewound', () => {
    const { store } = createStore();
    store.observe(generated('turn-1'));

    store.observe({
      type: 'message.rewind',
      timestampMs: 1,
      source: 'runtime',
      sessionId: 'session-1',
    });

    expect(store.candidate('session-1')).toBeUndefined();
  });

  it('refuses a late result for the rewound Turn until a newer Turn starts', () => {
    const { store } = createStore();
    const rewind: TuiRuntimeEvent = {
      type: 'message.rewind',
      timestampMs: 1,
      source: 'runtime',
      sessionId: 'session-1',
    };
    store.observe(started('turn-1'));
    // Rewind lands while the suggestion for turn-1 is still generating.
    store.observe(rewind);

    expect(store.observe(generated('turn-1'))).toBe(false);
    expect(store.candidate('session-1')).toBeUndefined();

    store.observe(started('turn-2'));
    expect(store.observe(generated('turn-2', 'Commit the fix'))).toBe(true);
    expect(store.candidate('session-1')?.text).toBe('Commit the fix');
  });

  it('refuses a late result after a rewind even when the Turn start was never observed', () => {
    const { store } = createStore();
    store.observe({
      type: 'message.rewind',
      timestampMs: 1,
      source: 'runtime',
      sessionId: 'session-1',
    });

    expect(store.observe(generated('turn-1'))).toBe(false);
    expect(store.candidate('session-1')).toBeUndefined();
  });

  it('reports shown and accepted once, and sent with whether the user edited it', () => {
    const { store, metrics } = createStore();
    store.observe(generated('turn-1'));
    const suggestion = store.candidate('session-1')!;

    store.markShown(suggestion);
    store.markShown(suggestion);
    store.accept(suggestion);
    store.accept(suggestion);
    const reportSent = store.submitted('session-1', 'Run the tests and report failures');

    // The send retires the suggestion at once, but counts only after admission.
    expect(store.candidate('session-1')).toBeUndefined();
    expect(metrics.map((metric) => metric.action)).toEqual(['shown', 'accepted']);
    reportSent?.();
    reportSent?.();
    expect(metrics.map((metric) => metric.action)).toEqual(['shown', 'accepted', 'sent']);
    expect(metrics[2]).toMatchObject({ action: 'sent', edited: true });
  });

  it('does not report a suggestion again when switching between Sessions', () => {
    const { store, metrics } = createStore();
    store.observe(generated('turn-1'));
    store.observe({ ...generated('turn-7', 'Open the PR'), sessionId: 'session-2' });
    const first = store.candidate('session-1')!;
    const second = store.candidate('session-2')!;

    store.markShown(first);
    store.markShown(second);
    store.markShown(first);
    store.accept(first);
    store.accept(second);
    store.accept(first);

    expect(metrics.map((metric) => `${metric.action}:${metric.suggestion.sessionId}`)).toEqual([
      'shown:session-1',
      'shown:session-2',
      'accepted:session-1',
      'accepted:session-2',
    ]);
  });

  it('reports an unedited accepted send as not edited', () => {
    const { store, metrics } = createStore();
    store.observe(generated('turn-1'));
    store.accept(store.candidate('session-1')!);

    store.submitted('session-1', 'Run the tests')?.();

    expect(metrics.at(-1)).toMatchObject({ action: 'sent', edited: false });
  });

  it('still reports sent when a failed send of an accepted suggestion is resent', () => {
    const { store, metrics } = createStore();
    store.observe(started('turn-1'));
    store.observe(generated('turn-1'));
    store.accept(store.candidate('session-1')!);

    // The first send is never admitted, so its report is dropped.
    store.submitted('session-1', 'Run the tests');
    store.submitted('session-1', 'Run the tests')?.();

    expect(metrics.map((metric) => metric.action)).toEqual(['accepted', 'sent']);
    expect(metrics.at(-1)).toMatchObject({ action: 'sent', edited: false });
  });

  it('keeps an accepted suggestion while another Session sends', () => {
    const { store, metrics } = createStore();
    store.observe(generated('turn-1'));
    store.accept(store.candidate('session-1')!);

    expect(store.submitted('session-2', 'Open the PR')).toBeUndefined();
    store.submitted('session-1', 'Run the tests')?.();

    expect(metrics.map((metric) => `${metric.action}:${metric.suggestion.sessionId}`)).toEqual([
      'accepted:session-1',
      'sent:session-1',
    ]);
  });

  it('reports sent once per acceptance and forgets it once a newer Turn starts', () => {
    const { store, metrics } = createStore();
    store.observe(started('turn-1'));
    store.observe(generated('turn-1'));
    store.accept(store.candidate('session-1')!);
    store.submitted('session-1', 'Run the tests')?.();

    expect(store.submitted('session-1', 'Run the tests')).toBeUndefined();
    store.observe(started('turn-2'));
    expect(store.submitted('session-1', 'Run the tests')).toBeUndefined();
    expect(metrics.map((metric) => metric.action)).toEqual(['accepted', 'sent']);
  });

  it('retires a suggestion on any send, without a sent metric when it was not accepted', () => {
    const { store, metrics } = createStore();
    store.observe(generated('turn-1'));

    expect(store.submitted('session-1', 'Something else entirely')).toBeUndefined();

    expect(metrics).toEqual([]);
    expect(store.candidate('session-1')).toBeUndefined();
  });

  it('never lets a telemetry failure affect the composer', () => {
    const store = new TuiPromptSuggestionStore(
      vi.fn(() => {
        throw new Error('telemetry down');
      }),
    );
    store.observe(generated('turn-1'));
    const suggestion = store.candidate('session-1')!;

    expect(() => store.markShown(suggestion)).not.toThrow();
    expect(() => store.accept(suggestion)).not.toThrow();
    expect(() => store.submitted('session-1', 'Run the tests')?.()).not.toThrow();
  });
});
