import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

import { TuiTranscriptPanel } from '../../../../src/tui/features/transcript/panel.js';
import { createTranscriptCell } from '../../../../src/tui/transcript/model.js';
import { TranscriptStore } from '../../../../src/tui/transcript/store.js';

function text(panel: TuiTranscriptPanel): string {
  return stripVTControlCharacters(panel.render(80).join('\n'));
}

describe('TuiTranscriptPanel expanded user text', () => {
  it('shows an expanded user prompt literally instead of as Markdown', () => {
    const store = new TranscriptStore([
      createTranscriptCell({
        id: 'user-literal',
        turnId: 'turn-1',
        kind: 'user',
        status: 'succeeded',
        content: 'delete __pycache__\n> keep this marker\nand 2 * 3',
        createdAtMs: 1,
      }),
    ]);
    const panel = new TuiTranscriptPanel({
      source: store,
      onCancel: vi.fn(),
      requestRender: vi.fn(),
    });

    panel.handleInput('\r');

    const rendered = text(panel);
    expect(rendered).toContain('│ delete __pycache__');
    expect(rendered).toContain('│ > keep this marker');
    expect(rendered).toContain('│ and 2 * 3');
  });
});
