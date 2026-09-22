import { describe, expect, it } from 'vitest';
import { presentTranscriptCell } from '../../src/tui/transcript/presentation/content.js';
import { createTranscriptCell } from '../../src/tui/transcript/model.js';
import { TranscriptPresentationController } from '../../src/tui/transcript/presentation/state.js';

describe('TranscriptPresentationController', () => {
  it('uses the run timer format in duration summaries and search text', () => {
    const presentation = presentTranscriptCell(
      createTranscriptCell({
        id: 'long-run',
        kind: 'turn-duration',
        status: 'succeeded',
        content: '',
        durationMs: 7_770_999,
        createdAtMs: 1,
      }),
    );
    expect(presentation.summary).toBe('2h9min30s');
    expect(presentation.searchText).toContain('2h9min30s');
  });

  it('previews only live Thinking and collapses settled Thinking in compact mode', () => {
    const running = createTranscriptCell({
      id: 'thinking-running',
      kind: 'thinking',
      status: 'running',
      content: 'Inspecting',
      createdAtMs: 1,
    });
    const settled = (['succeeded', 'failed', 'cancelled'] as const).map((status) =>
      createTranscriptCell({
        id: `thinking-${status}`,
        kind: 'thinking',
        status,
        content: `${status} detail`,
        createdAtMs: 1,
      }),
    );
    const presentation = new TranscriptPresentationController();

    expect(presentation.resolveMainDisplayMode(running)).toBe('preview');
    expect(settled.map((cell) => presentation.resolveMainDisplayMode(cell))).toEqual([
      'collapsed',
      'collapsed',
      'collapsed',
    ]);
    expect(presentation.toggleMainMode()).toBe('detailed');
    expect([running, ...settled].map((cell) => presentation.resolveMainDisplayMode(cell))).toEqual([
      'expanded',
      'expanded',
      'expanded',
      'expanded',
    ]);
    expect(
      [running, ...settled].every(
        (cell) => cell.displayMode === undefined && cell.expanded === undefined,
      ),
    ).toBe(true);
  });

  it('collapses Tool details for every lifecycle state until detailed mode is requested', () => {
    const tools = (['running', 'succeeded', 'failed'] as const).map((status) =>
      createTranscriptCell({
        id: `tool-${status}`,
        kind: 'tool',
        status,
        title: 'bash',
        content: '{"command":"pnpm test"}',
        detail: `${status} output`,
        createdAtMs: 1,
      }),
    );
    const presentation = new TranscriptPresentationController();

    expect(tools.map((cell) => presentation.resolveMainDisplayMode(cell))).toEqual([
      'collapsed',
      'collapsed',
      'collapsed',
    ]);
    presentation.setMainMode('detailed');
    expect(tools.map((cell) => presentation.resolveMainDisplayMode(cell))).toEqual([
      'expanded',
      'expanded',
      'expanded',
    ]);
    expect(presentation.revision).toBe(1);
  });

  it('keeps completed Tool results and structured changes collapsed', () => {
    const completedTool = createTranscriptCell({
      id: 'tool-completed',
      kind: 'tool',
      status: 'succeeded',
      title: 'bash',
      content: '{"command":"pnpm test"}',
      detail: '114 passed',
      createdAtMs: 1,
    });
    const structuredTool = createTranscriptCell({
      id: 'tool-structured',
      kind: 'tool',
      status: 'succeeded',
      title: 'edit',
      content: '{"path":"src/app.ts"}',
      structuredPreview: {
        schemaVersion: 1,
        state: 'applied',
        blocks: [
          {
            kind: 'diff',
            path: 'src/app.ts',
            diff: '- old\n+ new',
            addedLines: 1,
            removedLines: 1,
            truncated: false,
          },
        ],
      },
      createdAtMs: 2,
    });
    const presentation = new TranscriptPresentationController();

    expect(presentation.resolveMainDisplayMode(completedTool)).toBe('collapsed');
    expect(presentation.resolveMainDisplayMode(structuredTool)).toBe('collapsed');
  });
});
