import { stripAnsi, visibleWidth } from '../../src/tui/rendering/text.js';
import { describe, expect, it, vi } from 'vitest';
import {
  TuiActivityLine,
  resolveTuiActivityColor,
  type TuiActivityLineState,
} from '../../src/tui/shell/activity-line.js';
import { createTuiChalk, tuiColors } from '../../src/tui/theme/runtime.js';
import { formatTuiShortcut } from '../../src/tui/shell/shortcut-labels.js';
import { createDefaultTuiKeybindingRegistry } from '../../src/tui/shell/keybindings.js';

function render(state: TuiActivityLineState, width = 80): string {
  const component = new TuiActivityLine(state, {
    animate: false,
    now: () => 10_000,
  });
  return component.render(width).join('\n');
}

describe('TuiActivityLine', () => {
  it('renders a sanitized model retry counter as transient activity', () => {
    expect(
      render({
        phase: 'retrying',
        runId: 'turn-1',
        message: 'Retrying model request · 2/5',
      }),
    ).toContain('Retrying model request · 2/5');
  });

  it('stays out of the message stream while idle', () => {
    expect(render({ phase: 'idle' })).toBe('');
  });

  it.each([
    [{ phase: 'loading', runId: 'turn-1', startedAtMs: 8_000 }, 'Loading'],
    [{ phase: 'loading', loadingTarget: 'session', startedAtMs: 8_000 }, 'Loading session'],
    [{ phase: 'running', runId: 'turn-1', startedAtMs: 8_000 }, 'Running'],
    [{ phase: 'reconnecting', runId: 'turn-1', startedAtMs: 8_000 }, 'Reconnecting'],
    [{ phase: 'compacting', runId: 'turn-1', startedAtMs: 8_000 }, 'Compacting context'],
    [{ phase: 'stopping', runId: 'turn-1', startedAtMs: 8_000 }, 'Stopping response'],
  ] satisfies Array<[TuiActivityLineState, string]>)(
    '%s renders one aggregate label',
    (state, label) => {
      const output = render(state);

      expect(output).toContain(label);
      expect(output).toContain('2s');
      expect(output).not.toMatch(/Esc|waiting|Read ·|src\//u);
    },
  );

  it.each([
    [60_000, '1min0s'],
    [3_599_999, '59min59s'],
    [3_600_000, '1h0min0s'],
    [7_731_000, '2h8min51s'],
    [7_770_000, '2h9min30s'],
  ])('renders %s ms using compact hours, minutes, and seconds', (elapsedMs, expected) => {
    const state: TuiActivityLineState = {
      phase: 'loading',
      runId: 'turn-1',
      startedAtMs: 10_000 - elapsedMs,
      controls: ['guide', 'details', 'interrupt'],
    };
    expect(render(state, 120)).toContain(`Loading ${expected}`);
    for (const width of [16, 24, 40, 80]) {
      expect(visibleWidth(render(state, width))).toBeLessThanOrEqual(width);
    }
  });

  it('makes a stopping response read as a danger state instead of running', () => {
    const output = render({ phase: 'stopping', runId: 'turn-1', startedAtMs: 8_000 });

    expect(output).toContain('! Stopping response');
    expect(resolveTuiActivityColor({ phase: 'stopping' })).toBe(tuiColors.error);
    expect(resolveTuiActivityColor({ phase: 'running' })).toBe(tuiColors.orbit);
  });

  it('renders a bounded Runtime error without a spinner or elapsed timer', () => {
    const component = new TuiActivityLine(
      { phase: 'error', message: 'authentication expired\u001B[31m' },
      { animate: true, now: () => 10_000 },
    );

    const rendered = stripAnsi(component.render(80).join('\n'));
    expect(rendered).toContain('Error · authentication expired');
    expect(rendered).not.toContain('10s');
    expect(rendered).not.toContain('⠋');
    component.dispose();
  });

  it('suppresses the visible row for a settled failure already shown in the transcript', () => {
    // The generic "Runtime error" label would only repeat the transcript error. The machine
    // readback keeps the failure on the shell state (agentErrorSettled), independent of this row.
    expect(render({ phase: 'error', errorSettled: true })).toBe('');
    expect(render({ phase: 'error', errorSettled: true, runId: 'turn_boom' })).toBe('');
  });

  it('still renders an error row when the failure carries its own message', () => {
    const rendered = stripAnsi(
      render({ phase: 'error', errorSettled: true, message: 'boom' }),
    );
    expect(rendered).toContain('Error · boom');
  });

  it.each([80, 40, 28])(
    'fits the aggregate spinner, label, and elapsed time at %s columns',
    (width) => {
      const output = render({ phase: 'running', runId: 'turn-1', startedAtMs: 8_000 }, width);

      expect(output).toContain('◇');
      expect(output).toContain('Running');
      expect(output).toContain('2s');
      expect(visibleWidth(output)).toBeLessThanOrEqual(width);
    },
  );

  it('offers the run controls next to the run they act on', () => {
    const output = render({
      phase: 'running',
      runId: 'turn-1',
      startedAtMs: 8_000,
      controls: ['guide', 'interrupt'],
    });

    expect(output).toContain('Running 2s');
    expect(output).toContain(`${formatTuiShortcut('enter')} steer`);
    expect(output).toContain('Esc stop');
  });

  it('renders controls from the active host keybinding registry', () => {
    const keybindings = createDefaultTuiKeybindingRegistry().withOverrides({
      'run.submit-guidance': 'ctrl+y',
    });
    const component = new TuiActivityLine(
      {
        phase: 'running',
        runId: 'turn-1',
        controls: ['guide'],
      },
      { animate: false, keybindings },
    );

    expect(component.render(80).join('\n')).toContain('Ctrl+Y steer');
  });

  it('shows one-decimal provider output throughput while a run is active', () => {
    const output = render({
      phase: 'running',
      runId: 'turn-1',
      startedAtMs: 8_000,
      outputTokensPerSecond: 63,
    });

    expect(output).toContain('⚡ 63 tok/s');
  });

  it.each([undefined, 0, Number.NaN, Number.POSITIVE_INFINITY])(
    'hides unavailable output throughput (%s)',
    (outputTokensPerSecond) => {
      const output = render({
        phase: 'running',
        runId: 'turn-1',
        outputTokensPerSecond,
      });

      expect(output).not.toContain('tok/s');
    },
  );

  it('drops steer before interrupt when the line runs out of room', () => {
    const state: TuiActivityLineState = {
      phase: 'running',
      runId: 'turn-1',
      startedAtMs: 8_000,
      controls: ['guide', 'interrupt'],
    };
    const full = visibleWidth(render(state, 200));

    const withoutGuide = render(state, full - 1);
    expect(withoutGuide).not.toContain('steer');
    expect(withoutGuide).toContain('Esc stop');
    expect(visibleWidth(withoutGuide)).toBeLessThanOrEqual(full - 1);

    const bare = render(state, 20);
    expect(bare).toContain('Running');
    expect(bare).not.toContain('stop');
    expect(visibleWidth(bare)).toBeLessThanOrEqual(20);
  });

  it('reveals elapsed time after the initial 0s flash window', () => {
    let now = 1_000;
    const component = new TuiActivityLine(
      { phase: 'loading', runId: 'turn-1' },
      { animate: false, now: () => now },
    );

    now = 2_499;
    expect(component.render(80).join('\n')).toContain('Loading');
    expect(component.render(80).join('\n')).not.toContain('0s');
    now = 2_500;
    expect(component.render(80).join('\n')).toContain('Loading 1s');
  });

  it('keeps one turn clock across loading, running, reconnecting, and stopping', () => {
    let now = 1_000;
    const component = new TuiActivityLine(
      { phase: 'loading', runId: 'turn-1' },
      { animate: false, now: () => now },
    );

    now = 4_000;
    component.setState({ phase: 'running', runId: 'turn-1' });
    now = 7_000;
    component.setState({ phase: 'reconnecting', runId: 'turn-1' });
    now = 9_000;
    component.setState({ phase: 'stopping', runId: 'turn-1' });

    expect(component.render(80).join('\n')).toContain('8s');
  });

  it('preserves the turn clock while an interaction panel temporarily owns the status', () => {
    let now = 1_000;
    const component = new TuiActivityLine(
      { phase: 'running', runId: 'turn-1' },
      { animate: false, now: () => now },
    );

    now = 5_000;
    component.setState({ phase: 'idle', runId: 'turn-1' });
    expect(component.render(80)).toEqual([]);
    now = 9_000;
    component.setState({ phase: 'running', runId: 'turn-1' });

    expect(component.render(80).join('\n')).toContain('8s');
  });

  it('animates a Braille spinner without painting terminal backgrounds', () => {
    vi.useFakeTimers();
    try {
      const component = new TuiActivityLine(
        { phase: 'running', runId: 'turn-1', startedAtMs: 8_000 },
        {
          animate: true,
          now: () => 10_000,
          chalk: createTuiChalk({ isTTY: true, noColor: false }),
        },
      );

      const first = component.render(80).join('\n');
      vi.advanceTimersByTime(80);
      const second = component.render(80).join('\n');

      expect(stripAnsi(first)).toContain('⠋ Running 2s');
      expect(stripAnsi(second)).toContain('⠙ Running 2s');
      expect(first).not.toContain('\u001B[48;2;');
      component.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the animation timer when idle', () => {
    vi.useFakeTimers();
    try {
      const requestRender = vi.fn();
      const component = new TuiActivityLine(
        { phase: 'running', runId: 'turn-1' },
        { requestRender },
      );

      vi.advanceTimersByTime(240);
      expect(requestRender).toHaveBeenCalledTimes(3);
      component.setState({ phase: 'idle' });
      vi.advanceTimersByTime(240);
      expect(requestRender).toHaveBeenCalledTimes(3);
      component.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
