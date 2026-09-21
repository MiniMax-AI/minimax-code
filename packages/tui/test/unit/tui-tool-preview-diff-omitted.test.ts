import { describe, expect, it } from 'vitest';
import { TuiAcpUpdateProjector } from '../../src/acp/updates.js';
import { buildTuiToolPreview } from '../../src/runtime/tool-preview.js';

const PATH = '/tmp/subject.ts';

const INPUT = {
  file_path: PATH,
  old_string: 'oldToken',
  new_string: 'newToken',
  replace_all: true,
};

function editPreview(details: Record<string, unknown>) {
  return buildTuiToolPreview({
    toolName: 'edit',
    status: 'completed',
    input: INPUT,
    output: { details },
  });
}

function acpToolContent(details: Record<string, unknown>) {
  const update = new TuiAcpUpdateProjector().project({
    type: 'delta',
    toolCalls: [
      {
        id: 'tool-1',
        name: 'edit',
        status: 'completed',
        input: INPUT,
        output: { details },
        structuredPreview: editPreview(details),
      },
    ],
  })[0];
  if (update?.sessionUpdate !== 'tool_call') {
    throw new Error(`expected a tool_call update, got ${update?.sessionUpdate}`);
  }
  return update.content;
}

describe('buildTuiToolPreview edit diff bounds', () => {
  it('keeps a diff block with real counts when the edit tool returns a diff body', () => {
    const preview = editPreview({
      diff: ['-1 export const a = oldToken(1);', '+1 export const a = newToken(1);'].join('\n'),
      patch: 'irrelevant',
    });

    const block = preview?.blocks[0];
    if (block?.kind !== 'diff') throw new Error(`expected a diff block, got ${block?.kind}`);
    expect(block.addedLines).toBe(1);
    expect(block.removedLines).toBe(1);
    expect(block.path).toBe(PATH);
  });

  it('renders a summary block instead of a misleading +0 -0 diff when the diff is omitted', () => {
    const preview = editPreview({
      diff: '(diff omitted: more than 1000 lines changed)',
      diffOmitted: 'too_many_changes',
    });

    const block = preview?.blocks[0];
    if (block?.kind !== 'summary') throw new Error(`expected a summary block, got ${block?.kind}`);
    expect(block.reason).toBe('too-large');
    expect(block.message).toBe('(diff omitted: more than 1000 lines changed)');
    expect(block.path).toBe(PATH);
    expect(block).not.toHaveProperty('addedLines');
    expect(block).not.toHaveProperty('removedLines');
  });

  it('maps a timed-out diff to the unavailable summary reason', () => {
    const preview = editPreview({
      diff: '(diff omitted: computing it exceeded 5000 ms)',
      diffOmitted: 'timeout',
    });

    const block = preview?.blocks[0];
    if (block?.kind !== 'summary') throw new Error(`expected a summary block, got ${block?.kind}`);
    expect(block.reason).toBe('unavailable');
  });
});

describe('TuiAcpUpdateProjector edit diff bounds', () => {
  it('still projects a real diff body as an ACP diff block', () => {
    const content = acpToolContent({
      diff: ['-1 export const a = oldToken(1);', '+1 export const a = newToken(1);'].join('\n'),
    });

    expect(content?.[0]).toMatchObject({ type: 'diff', path: PATH });
  });

  it('projects an omitted diff as text instead of a diff block with a parsed-notice body', () => {
    const content = acpToolContent({
      diff: '(diff omitted: more than 1000 lines changed)',
      diffOmitted: 'too_many_changes',
    });

    expect(content).toEqual([
      {
        type: 'content',
        content: { type: 'text', text: '(diff omitted: more than 1000 lines changed)' },
      },
    ]);
  });
});
