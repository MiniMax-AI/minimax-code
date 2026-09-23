import { describe, expect, it, vi } from 'vitest';
import { TuiBashFlow } from '../../src/tui/controller/product/bash-flow.js';
import { TuiTurnProjection } from '../../src/tui/controller/projection/turn-projection.js';
import type { TuiMessage } from '../../src/runtime/port.js';
import { TranscriptStore } from '../../src/tui/transcript/store.js';
import { TranscriptView } from '../../src/tui/transcript/view.js';
import { renderShellBlock } from '../../src/tui/transcript/shell-block.js';
import { createTranscriptCell } from '../../src/tui/transcript/model.js';
import { presentTranscriptCell } from '../../src/tui/transcript/presentation/content.js';
import { stripAnsi, visibleWidth } from '../../src/tui/rendering/text.js';

function shellCell() {
  return createTranscriptCell({
    id: 'shell-1',
    kind: 'shell',
    status: 'succeeded',
    title: '! printf output',
    content: 'first line\n  second line\n',
    detail: 'Exit code: 0',
    createdAtMs: 1,
  });
}

describe('Shell transcript block', () => {
  it.each(['succeeded', 'cancelled'] as const)(
    'dismisses the previous %s turn duration when the next turn starts',
    (status) => {
      const transcript = new TranscriptStore();
      const view = new TranscriptView(transcript);
      const onChange = vi.fn();
      const projection = new TuiTurnProjection({ transcript, now: () => 10, onChange });
      projection.recordTerminalDuration('previous-turn', status, 12_000);
      const label = status === 'cancelled' ? 'Interrupted after 12s' : 'Completed in 12s';
      expect(stripAnsi(view.render(80).join('\n'))).toContain(label);

      transcript.replaceDurableProjection(() => projection.hydrateHistory([]));
      expect(stripAnsi(view.render(80).join('\n'))).toContain(label);

      onChange.mockClear();
      projection.beginTurn('next-turn', 20);
      expect(transcript.get('turn-duration:previous-turn')).toBeUndefined();
      expect(stripAnsi(view.render(80).join('\n'))).not.toContain(label);
      expect(onChange).toHaveBeenCalledOnce();

      projection.recordTerminalDuration('next-turn', 'succeeded', 3_000);
      expect(stripAnsi(view.render(80).join('\n'))).toContain('Completed in 3s');
    },
  );

  it.each([
    { exitCode: 0, cancelled: false, status: 'succeeded' },
    { exitCode: 7, cancelled: false, status: 'failed' },
    { exitCode: undefined, cancelled: true, status: 'cancelled' },
  ] as const)(
    'dismisses $status shell results when the next turn starts without replaying them',
    async ({ exitCode, cancelled, status }) => {
      const transcript = new TranscriptStore();
      const view = new TranscriptView(transcript);
      const onChange = vi.fn();
      const projection = new TuiTurnProjection({ transcript, now: () => 10, onChange });
      const flow = new TuiBashFlow({
        transcript,
        onChanged: vi.fn(),
        execute: async ({ onOutput }) => {
          onOutput('shell output');
          return { exitCode, cancelled };
        },
      });
      for (const excludeFromContext of [false, true]) {
        await flow.run({ command: 'pwd', excludeFromContext }, '/workspace', 'session');
      }
      expect(transcript.snapshot()).toHaveLength(2);
      expect(transcript.snapshot().every((cell) => cell.status === status)).toBe(true);
      transcript.replaceDurableProjection(() => projection.hydrateHistory([]));
      expect(stripAnsi(view.render(80).join('\n'))).toContain('shell output');

      const messages: TuiMessage[] = [];
      for (const turnId of ['next-turn', 'later-turn']) {
        onChange.mockClear();
        projection.beginTurn(turnId, 10);
        expect(stripAnsi(view.render(80).join('\n'))).not.toContain('shell output');
        if (turnId === 'next-turn') expect(onChange).toHaveBeenCalled();
        const message: TuiMessage = {
          id: `answer:${turnId}`,
          role: 'assistant',
          content: `Answer for ${turnId}`,
          turnId,
        };
        projection.applyStreamEvent(turnId, { type: 'message', message });
        projection.markTurn(turnId, 'succeeded', 10);
        messages.push(message);
        transcript.replaceDurableProjection(() => projection.hydrateHistory(messages));
        const rendered = stripAnsi(view.render(80).join('\n'));
        expect(rendered).toContain(message.content);
        expect(rendered).not.toContain('shell output');
        expect(transcript.snapshot().some((cell) => cell.kind === 'shell')).toBe(false);
      }
      expect(flow.takeContext('session')?.match(/shell output/gu)).toHaveLength(1);
      expect(flow.takeContext('session')).toBeUndefined();
    },
  );

  it('preserves running shells, durable shells and unrelated temporary content', () => {
    const retained = [
      { ...shellCell(), id: 'running', status: 'running' as const, ephemeral: true },
      { ...shellCell(), id: 'pending', status: 'pending' as const, ephemeral: true },
      { ...shellCell(), id: 'durable' },
      { ...shellCell(), id: 'notice', kind: 'final-summary' as const, ephemeral: true },
    ];
    const transcript = new TranscriptStore(retained);
    const projection = new TuiTurnProjection({ transcript, now: () => 10, onChange: vi.fn() });
    projection.beginTurn('next-turn', 10);
    expect(transcript.snapshot()).toEqual(retained);
  });

  it('separates the shell command, literal output and status from adjacent prose', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'before',
        kind: 'final-summary',
        status: 'succeeded',
        content: 'Before shell',
        createdAtMs: 0,
      }),
      shellCell(),
      createTranscriptCell({
        id: 'after',
        kind: 'assistant',
        status: 'succeeded',
        content: 'After shell',
        createdAtMs: 2,
      }),
    ]);
    const text = stripAnsi(view.render(80).join('\n'));
    expect(text).toContain('Shell');
    expect(text.indexOf('Before shell')).toBeLessThan(text.indexOf('! printf output'));
    expect(text.indexOf('! printf output')).toBeLessThan(text.indexOf('first line'));
    expect(text.indexOf('first line')).toBeLessThan(text.indexOf('Exit code: 0'));
    expect(text.indexOf('Exit code: 0')).toBeLessThan(text.indexOf('After shell'));
    expect(text).toContain('  second line');
  });

  it.each([0, 1, 2, 4, 5, 8, 12, 30, 80])(
    'keeps multiline Unicode output inside a %s-column terminal',
    (width) => {
      const cell = {
        ...shellCell(),
        title: '! echo 中文命令',
        content: `中文输出🙂\n${'a'.repeat(90)}`,
      };
      const lines = renderShellBlock(cell, width);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      if (width === 0) expect(lines).toEqual([]);
    },
  );

  it('retains shell identity, command and exit status in plain-text inspection and search', () => {
    const presentation = presentTranscriptCell(shellCell());
    expect(presentation.title).toBe('Shell');
    expect(presentation.summary).toBe('! printf output');
    expect(presentation.rawText).toContain('! printf output');
    expect(presentation.rawText).toContain('first line');
    expect(presentation.rawText).toContain('Exit code: 0');
    expect(presentation.searchText).toContain('printf output');
    expect(presentation.rawText).not.toContain('\u001b');
  });

  it('labels !! as local-only and keeps output as terminal text', () => {
    const text = stripAnsi(
      renderShellBlock(
        { ...shellCell(), title: '!! echo local', content: '\u001b[2J# heading\n**literal**' },
        60,
      ).join('\n'),
    );
    expect(text).toContain('Shell · Local only');
    expect(text).toContain('!! echo local');
    expect(text).toContain('# heading');
    expect(text).toContain('**literal**');
    expect(text).not.toContain('\u001b[2J');
  });

  it('updates the same block from streaming output to completed status', async () => {
    const transcript = new TranscriptStore();
    const view = new TranscriptView(transcript);
    let finish!: () => void;
    const flow = new TuiBashFlow({
      transcript,
      onChanged: vi.fn(),
      execute: async ({ onOutput }) => {
        onOutput('streamed output\n');
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { exitCode: 0, cancelled: false };
      },
    });
    const running = flow.run(
      { command: 'echo streamed output', excludeFromContext: false },
      '/workspace',
    );
    await vi.waitFor(() => expect(transcript.snapshot()[0]?.content).toContain('streamed output'));
    expect(transcript.snapshot()[0]).toMatchObject({
      kind: 'shell',
      title: '! echo streamed output',
    });
    expect(stripAnsi(view.render(80).join('\n'))).toContain('Running');
    finish();
    await running;
    const text = stripAnsi(view.render(80).join('\n'));
    expect(text).toContain('streamed output');
    expect(text).toContain('Exit code: 0');
    expect(text).not.toContain('Running');
    expect(transcript.snapshot()).toHaveLength(1);
    expect(flow.takeContext()).toContain('streamed output');
  });

  it.each([
    { exitCode: 7, cancelled: false, status: 'failed', detail: 'Exit code: 7' },
    { exitCode: undefined, cancelled: true, status: 'cancelled', detail: 'Command cancelled' },
  ])('shows $status with empty output', async ({ exitCode, cancelled, status, detail }) => {
    const transcript = new TranscriptStore();
    const flow = new TuiBashFlow({
      transcript,
      onChanged: vi.fn(),
      execute: async () => ({ exitCode, cancelled }),
    });
    await flow.run({ command: 'test', excludeFromContext: false }, '/workspace');
    const text = stripAnsi(new TranscriptView(transcript).render(80).join('\n'));
    expect(transcript.snapshot()[0]).toMatchObject({ kind: 'shell', status });
    expect(text).toContain('Shell');
    expect(text).toContain('No output');
    expect(text).toContain(detail);
  });

  it('distinguishes waiting for output from an empty completed command', () => {
    const text = stripAnsi(
      renderShellBlock(
        {
          ...shellCell(),
          status: 'running',
          content: '',
          detail: 'Running · Esc or Ctrl+C to cancel',
        },
        80,
      ).join('\n'),
    );
    expect(text).toContain('Waiting for output');
    expect(text).toContain('Esc or Ctrl+C to cancel');
    expect(text).not.toContain('No output');
  });

  it('keeps a launch error inside the shell block', async () => {
    const transcript = new TranscriptStore();
    const flow = new TuiBashFlow({
      transcript,
      onChanged: vi.fn(),
      execute: async () => {
        throw new Error('launch failed');
      },
    });
    await flow.run({ command: 'test', excludeFromContext: false }, '/workspace');
    expect(stripAnsi(new TranscriptView(transcript).render(80).join('\n'))).toContain(
      'Could not run command: launch failed',
    );
  });
});
