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

  it('keeps run durations that later output follows in place across turns and history refreshes', () => {
    // Removing a note that settled output follows would change rows already in
    // native scrollback (#426); each such note stays after its own turn, once.
    const transcript = new TranscriptStore();
    const view = new TranscriptView(transcript);
    const projection = new TuiTurnProjection({ transcript, now: () => 10, onChange: vi.fn() });
    const messages: TuiMessage[] = [];
    const runTurn = (turnId: string, seconds: number) => {
      const prompt: TuiMessage = { id: `prompt:${turnId}`, role: 'user', content: `Prompt ${turnId}`, turnId };
      const answer: TuiMessage = { id: `answer:${turnId}`, role: 'assistant', content: `Answer ${turnId}`, turnId };
      projection.beginTurn(turnId, 10);
      projection.applyStreamEvent(turnId, { type: 'message', message: prompt });
      projection.applyStreamEvent(turnId, { type: 'message', message: answer });
      projection.markTurn(turnId, 'succeeded', seconds * 1_000);
      messages.push(prompt, answer);
    };
    const text = () => stripAnsi(view.render(80).join('\n'));

    runTurn('t1', 4);
    // A background task notice lands after the note before the next run starts.
    transcript.upsert({ id: 'local:1', kind: 'final-summary', status: 'succeeded', content: 'Background task finished', ephemeral: true, createdAtMs: 11 });
    runTurn('t2', 3);
    runTurn('t3', 2);
    const expectOrder = (rendered: string) => {
      const order = ['Answer t1', 'Completed in 4s', 'Background task finished', 'Answer t2', 'Answer t3', 'Completed in 2s'];
      const positions = order.map((label) => rendered.indexOf(label));
      expect(positions.every((position) => position >= 0)).toBe(true);
      expect([...positions].sort((left, right) => left - right)).toEqual(positions);
      expect(rendered.match(/Completed in 4s/g)).toHaveLength(1);
      expect(rendered.match(/Completed in 2s/g)).toHaveLength(1);
      // t2's note was still the live tail when t3 started, so it was dismissed.
      expect(rendered).not.toContain('Completed in 3s');
    };
    expectOrder(text());

    // History cells use different ids from live ones; notes stay after their turn.
    transcript.replaceDurableProjection(() => projection.hydrateHistory(messages));
    expectOrder(text());
  });

  it('drops kept one-time feedback of turns that an edit removed from history', () => {
    const transcript = new TranscriptStore();
    const view = new TranscriptView(transcript);
    const projection = new TuiTurnProjection({ transcript, now: () => 10, onChange: vi.fn() });
    const messagesFor = (turnId: string): TuiMessage[] => [
      { id: `prompt:${turnId}`, role: 'user', content: `Prompt ${turnId}`, turnId },
      { id: `answer:${turnId}`, role: 'assistant', content: `Answer ${turnId}`, turnId },
    ];
    const runTurn = (turnId: string, seconds: number) => {
      projection.beginTurn(turnId, 10);
      for (const message of messagesFor(turnId)) projection.applyStreamEvent(turnId, { type: 'message', message });
      projection.markTurn(turnId, 'succeeded', seconds * 1_000);
    };
    const notice = (id: string) =>
      transcript.upsert({ id, kind: 'final-summary', status: 'succeeded', content: id, ephemeral: true, createdAtMs: 11 });
    runTurn('t1', 4);
    notice('local:1');
    runTurn('t2', 3);
    transcript.upsert({ id: 'terminal-error:t2:1', kind: 'error', status: 'failed', content: 'Stale error t2', turnId: 't2', ephemeral: true, createdAtMs: 12 });
    notice('local:2');
    runTurn('t3', 2);
    expect(stripAnsi(view.render(80).join('\n'))).toContain('Completed in 3s');

    // Editing t2's prompt removes t2 and t3 from history and starts a new turn.
    transcript.replaceDurableProjection(() =>
      projection.hydrateHistory([...messagesFor('t1'), ...messagesFor('t2-edited')]),
    );
    const rendered = stripAnsi(view.render(80).join('\n'));
    expect(rendered.match(/Completed in 4s/g)).toHaveLength(1);
    expect(rendered.indexOf('Answer t1')).toBeLessThan(rendered.indexOf('Completed in 4s'));
    expect(rendered.indexOf('Completed in 4s')).toBeLessThan(rendered.indexOf('Answer t2-edited'));
    expect(rendered).not.toContain('Completed in 3s');
    expect(rendered).not.toContain('Completed in 2s');
    expect(rendered).not.toContain('Stale error t2');
    expect(transcript.snapshot().filter((cell) => cell.kind === 'turn-duration').map((cell) => cell.id)).toEqual([
      'turn-duration:t1',
    ]);
  });

  it('re-anchors a retained run duration after its turn when history ids and counts differ', () => {
    const cell = (id: string, turnId: string, ephemeral = false) =>
      createTranscriptCell({
        id,
        kind: id.startsWith('turn-duration') ? 'turn-duration' : 'assistant',
        status: 'succeeded',
        content: id,
        turnId,
        ...(ephemeral ? { ephemeral: true } : {}),
        createdAtMs: 1,
      });
    const transcript = new TranscriptStore([
      cell('live:a', 't1'),
      cell('turn-duration:t1', 't1', true),
      cell('live:b', 't2'),
      cell('turn-duration:t2', 't2', true),
    ]);
    transcript.replaceDurableProjection(() => {
      for (const [id, turnId] of [['history:a1', 't1'], ['history:a2', 't1'], ['history:a3', 't1'], ['history:b', 't2']]) {
        transcript.upsert(cell(id as string, turnId as string));
      }
    });
    expect(transcript.snapshot().map((entry) => entry.id)).toEqual([
      'history:a1',
      'history:a2',
      'history:a3',
      'turn-duration:t1',
      'history:b',
      'turn-duration:t2',
    ]);
  });

  it('keeps a finished shell block that settled output already follows', () => {
    const transcript = new TranscriptStore([
      { ...shellCell(), id: 'shell:done', ephemeral: true },
      createTranscriptCell({ id: 'answer', kind: 'assistant', status: 'succeeded', content: 'Answer', createdAtMs: 2 }),
      { ...shellCell(), id: 'shell:tail', ephemeral: true },
    ]);
    const projection = new TuiTurnProjection({ transcript, now: () => 10, onChange: vi.fn() });
    projection.beginTurn('next-turn', 10);
    expect(transcript.snapshot().map((cell) => cell.id)).toEqual(['shell:done', 'answer']);
  });

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
