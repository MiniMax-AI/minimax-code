import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { visibleWidth } from '../../src/tui/rendering/text.js';
import { getCapabilities, setCapabilities } from '../../src/tui/engine/public.js';
import { describe, expect, it } from 'vitest';
import { TranscriptView, resolveTuiDecisionColor } from '../../src/tui/transcript/view.js';
import { createTranscriptCell } from '../../src/tui/transcript/model.js';
import { TranscriptStore } from '../../src/tui/transcript/store.js';
import { sanitizeTerminalText } from '../../src/tui/rendering/terminal-text.js';
import {
  applyTuiRenderTheme,
  createTuiChalk,
  getTuiThemeSnapshot,
  tuiColors,
} from '../../src/tui/theme/runtime.js';
import { MINIMAX_CODE_DARK_THEME, MINIMAX_CODE_LIGHT_THEME } from '../../src/tui/theme/palettes.js';

const previewDisplayModes = {
  revision: 0,
  resolveMainDisplayMode: () => 'preview' as const,
};

describe('TranscriptView', () => {
  it.each(['assistant', 'assistant-preamble', 'thinking'] as const)(
    'removes control strings from %s content without changing stored model output',
    (kind) => {
      const control = '\x1b]52;c;U1lOVEhFVElD\x07';
      const content = `**Visible**\n\n\`\`\`text\n${control}\x1b[8mSafe code\x1b[0m\n\`\`\``;
      const cell = createTranscriptCell({
        id: 'untrusted-markdown',
        kind,
        status: 'running',
        content,
        createdAtMs: 1,
      });
      const view = new TranscriptView(() => [cell], {
        displayModes: { revision: 0, resolveMainDisplayMode: () => 'expanded' },
      });
      const rendered = view.render(100).join('\n');
      expect(rendered).not.toContain(control);
      expect(rendered).not.toContain('\x1b[8m');
      expect(stripVTControlCharacters(rendered)).toContain('Safe code');
      expect(cell.content).toBe(content);
    },
  );

  it('safely renders every streaming prefix including C1 and unterminated control strings', () => {
    const content = 'Visible\x9d52;c;U1lOVEhFVElD\x9c\x1bPprivate payload\x1b\\\x1b[8mtext\x1b[0m';
    for (let end = 1; end <= content.length; end++) {
      const text = sanitizeTerminalText(content.slice(0, end));
      expect(text).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u);
      expect(text).not.toContain('private payload');
      expect(text).not.toContain('U1lOVEhFVElD');
    }
    expect(sanitizeTerminalText('中文🙂\ttext\r\nnext\rother')).toBe('中文🙂\ttext\nnext other');
  });
  it.each(['running', 'succeeded'] as const)(
    'does not emit model terminal controls from a %s assistant cell',
    (status) => {
      const controls = ['\x1b]52;c;U1lOVEhFVElD\x07', '\x1b]2;FORGED_TITLE\x07', '\x1b[8m'];
      const view = new TranscriptView(() => [
        createTranscriptCell({
          id: 'untrusted-controls',
          kind: 'assistant',
          status,
          content: `Visible ${controls.join('')}model text\x1b[0m`,
          createdAtMs: 1,
        }),
      ]);
      const rendered = view.render(100).join('\n');
      for (const control of controls) expect(rendered).not.toContain(control);
      expect(stripVTControlCharacters(rendered)).toContain('Visible model text');
    },
  );
  it('renders a Markdown question receipt (Plan Review) as formatted prose', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'question:plan-review-view',
        kind: 'question',
        status: 'blocked',
        title: 'Plan Review',
        content: '# Implementation plan\n\n1. Add Runtime projection\n2. Add TUI controls',
        contentFormat: 'markdown',
        ephemeral: true,
        createdAtMs: 1,
      }),
    ]);

    const rendered = view.render(80).join('\n');
    // Heading marker + title, and the plan body rendered (heading hash stripped by Markdown).
    expect(rendered).toContain('Plan Review');
    expect(rendered).toContain('Implementation plan');
    expect(rendered).toContain('Add Runtime projection');
    expect(rendered).not.toContain('# Implementation plan');
  });

  it('renders a resolved Markdown question receipt with the decision detail', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'question:plan-review-resolved-view',
        kind: 'question',
        status: 'resolved',
        title: 'Plan Review',
        content: '# Plan\n\nShip it.',
        contentFormat: 'markdown',
        detail: 'Approved · implementation queued',
        ephemeral: true,
        createdAtMs: 1,
      }),
    ]);

    const rendered = view.render(80).join('\n');
    expect(rendered).toContain('Ship it.');
    expect(rendered).toContain('Approved · implementation queued');
  });

  it('marks user and Assistant blocks as semantic terminal zones', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'user-semantic-zone',
        kind: 'user',
        status: 'succeeded',
        content: 'Inspect the renderer',
        createdAtMs: 1,
      }),
      createTranscriptCell({
        id: 'assistant-semantic-zone',
        kind: 'assistant',
        status: 'succeeded',
        content: 'The renderer is stable.',
        createdAtMs: 2,
      }),
    ]);

    const lines = view.render(60);

    expect(lines.filter((line) => line.startsWith('\x1b]133;A\x07'))).toHaveLength(2);
    expect(lines.filter((line) => line.includes('\x1b]133;B\x07\x1b]133;C\x07'))).toHaveLength(2);
  });

  it('attaches a pending steer to the active flow as the next instruction', () => {
    const width = 60;
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'active-tool',
        kind: 'tool',
        status: 'running',
        title: 'bash',
        content: JSON.stringify({ command: 'pnpm test' }),
        turnId: 'turn-active',
        createdAtMs: 1,
      }),
      createTranscriptCell({
        id: 'pending-steer',
        kind: 'user',
        status: 'pending',
        content: 'Only inspect the login flow',
        userPresentation: 'pending-steer',
        turnId: 'turn-active',
        createdAtMs: 2,
      }),
    ]);

    const lines = view.render(width).map((line) => stripVTControlCharacters(line).trimEnd());
    const toolIndex = lines.findIndex((line) => line.includes('pnpm test'));
    const steerIndex = lines.findIndex((line) => line.includes('Only inspect the login flow'));

    expect(lines[steerIndex]).toBe('  ↳ Next · Only inspect the login flow');
    expect(steerIndex).toBe(toolIndex + 1);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
  });

  it.each([0, 1, 2, 3, 4, 7])(
    'keeps the pending steer annotation within a %i-column viewport',
    (width) => {
      const view = new TranscriptView(() => [
        createTranscriptCell({
          id: 'pending-steer-narrow',
          kind: 'user',
          status: 'pending',
          content: 'Steer',
          userPresentation: 'pending-steer',
          createdAtMs: 1,
        }),
      ]);

      const lines = view.render(width).map(stripVTControlCharacters);

      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    },
  );

  it('aligns wrapped pending steer content beneath the instruction text', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'pending-steer-wrapped',
        kind: 'user',
        status: 'pending',
        content: 'Compare this implementation with the other repositories before changing it',
        userPresentation: 'pending-steer',
        createdAtMs: 1,
      }),
    ]);

    const lines = view.render(32).map((line) => stripVTControlCharacters(line).trimEnd());

    expect(lines[0]).toMatch(/^ {2}↳ Next · /u);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.slice(1).every((line) => line.startsWith(' '.repeat(11)))).toBe(true);
    expect(lines.every((line) => visibleWidth(line) <= 32)).toBe(true);
  });

  it.each([
    ['succeeded', 'Not applied'],
    ['blocked', 'Not applied'],
    ['cancelled', 'Not applied'],
    ['failed', 'May not have applied'],
  ] as const)('settles an unconsumed %s steer annotation', (status, label) => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: `pending-steer-${status}`,
        kind: 'user',
        status,
        content: 'Steer',
        userPresentation: 'pending-steer',
        createdAtMs: 1,
      }),
    ]);

    const rendered = view.render(60).map(stripVTControlCharacters).join('\n');

    expect(rendered).toContain(label);
    expect(rendered).not.toContain('Next ·');
  });

  it.each([
    [25_400, '25s'],
    [60_000, '1min0s'],
    [7_770_000, '2h9min30s'],
  ])('renders completed Run duration of %s ms as %s', (durationMs, expected) => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'turn-duration-1',
        kind: 'turn-duration',
        status: 'succeeded',
        content: '',
        durationMs,
        createdAtMs: 1,
      }),
    ]);

    expect(view.render(60).join('\n')).toContain(`└ Completed in ${expected}`);
  });

  it('distinguishes an interrupted Run from a completed response', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'turn-duration-cancelled',
        kind: 'turn-duration',
        status: 'cancelled',
        content: '',
        durationMs: 1_250,
        createdAtMs: 1,
      }),
    ]);

    expect(view.render(60).join('\n')).toContain('└ Interrupted after 1s');
  });

  it.each([
    ['running', 'Compacting context', '•'],
    ['succeeded', 'Context compacted', '•'],
    ['failed', 'Context compaction failed', '×'],
  ] as const)(
    'renders Runtime-owned compaction %s as a title-only state row',
    (status, title, marker) => {
      const view = new TranscriptView(() => [
        createTranscriptCell({
          id: 'compaction-1',
          kind: 'compaction',
          status,
          title,
          content: 'summary must stay hidden',
          createdAtMs: 1,
        }),
      ]);

      const rendered = view.render(60).join('\n');
      expect(rendered).toContain(marker);
      expect(rendered).toContain(title);
      expect(rendered).not.toContain('summary must stay hidden');
    },
  );

  it('renders a completed compaction as one compact token-delta row', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'compaction-1',
        kind: 'compaction',
        status: 'succeeded',
        content: '',
        tokensBefore: 14_200,
        tokensAfter: 5_100,
        createdAtMs: 1,
      }),
    ]);

    expect(view.render(60).join('\n')).toContain('• Context compacted · 14.2k → 5.1k tokens');
  });

  it('reuses an unchanged transcript frame and invalidates it when a cell changes', () => {
    let cells = [
      createTranscriptCell({
        id: 'assistant-1',
        kind: 'assistant',
        status: 'succeeded',
        content: 'Stable answer',
        createdAtMs: 1,
      }),
    ];
    const view = new TranscriptView(() => cells);

    const first = view.render(50);
    expect(view.render(50)).toBe(first);

    const original = cells[0];
    if (!original) throw new Error('missing transcript fixture');
    cells = [{ ...original, content: 'Updated answer', updatedAtMs: 2 }];
    const updated = view.render(50);

    expect(updated).not.toBe(first);
    expect(updated.join('\n')).toContain('Updated answer');
  });

  it('renders rich delivery markup as a compact terminal file receipt', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'assistant-assets',
        kind: 'assistant',
        status: 'succeeded',
        content: [
          'Done.',
          '<deliver-assets>',
          '<media src="/workspace/chart.png" caption="Chart" />',
          '</deliver-assets>',
        ].join('\n'),
        createdAtMs: 1,
      }),
    ]);

    const rendered = stripVTControlCharacters(view.render(80).join('\n'));

    expect(rendered).toContain('Created  chart.png ↗  ·  Chart');
    expect(rendered).not.toContain('/workspace/chart.png');
    expect(rendered).not.toContain('Chart · /workspace/chart.png');
    expect(rendered).not.toContain('<deliver-assets>');
    expect(rendered).not.toContain('<media');
  });

  it('keeps leaked caption text and absolute paths out of the compact receipt', () => {
    const path = '/Users/example/workspace/sample-project/output/mavis-architecture.html';
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'assistant-long-asset',
        kind: 'assistant',
        status: 'succeeded',
        content: [
          'Done.',
          '<deliver-assets>',
          `<media src="${path}" caption="Mavis architecture overview · ${path}RunTurnInput leaked text" />`,
          '</deliver-assets>',
        ].join('\n'),
        createdAtMs: 1,
      }),
    ]);

    const lines = view.render(36).map((line) => stripVTControlCharacters(line).trimEnd());
    const receiptLine = lines.findIndex((line) => line.includes('mavis-architecture.html ↗'));
    const normalized = lines.join(' ').replace(/\s+/gu, ' ');

    expect(receiptLine).toBeGreaterThan(-1);
    expect(normalized).toContain('Mavis architecture overview');
    expect(normalized).not.toContain('leaked text');
    expect(normalized).not.toContain('/Users/example');
  });

  it('makes the generated file label a highlighted OSC 8 file link when supported', () => {
    const originalCapabilities = getCapabilities();
    const originalTheme = getTuiThemeSnapshot();
    const palette =
      originalTheme.appearance === 'light' ? MINIMAX_CODE_LIGHT_THEME : MINIMAX_CODE_DARK_THEME;
    setCapabilities({ ...originalCapabilities, hyperlinks: true });
    applyTuiRenderTheme(palette, 3);
    try {
      const view = new TranscriptView(() => [
        createTranscriptCell({
          id: 'assistant-linked-asset',
          kind: 'assistant',
          status: 'succeeded',
          content:
            '<deliver-assets><media src="/workspace/hello-world.html" caption="hello-world.html" /></deliver-assets>',
          createdAtMs: 1,
        }),
      ]);

      const rendered = view.render(80).join('\n');

      expect(rendered).toContain(`\x1b]8;;${pathToFileURL('/workspace/hello-world.html').href}\x1b\\`);
      expect(rendered).toContain('\x1b[4m');
      expect(stripVTControlCharacters(rendered)).toContain('Created  hello-world.html ↗');
    } finally {
      setCapabilities(originalCapabilities);
      applyTuiRenderTheme(palette, originalTheme.colorLevel);
    }
  });

  it('aligns assistant prose and preambles on one large dot per segment', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'assistant-preamble-anchor',
        kind: 'assistant-preamble',
        status: 'succeeded',
        content: 'I will inspect the transcript renderer before changing it.',
        createdAtMs: 1,
      }),
      createTranscriptCell({
        id: 'assistant-answer-anchor',
        kind: 'assistant',
        status: 'succeeded',
        content: 'The renderer now keeps wrapped continuation lines aligned with the answer.',
        createdAtMs: 2,
      }),
    ]);

    const lines = view
      .render(28)
      .map((line) => stripVTControlCharacters(line).trimEnd())
      .filter(Boolean);

    expect(lines.filter((line) => line.startsWith('● '))).toHaveLength(2);
    expect(lines.filter((line) => line.includes('●'))).toHaveLength(2);
    expect(lines.filter((line) => !line.includes('●')).every((line) => line.startsWith('  '))).toBe(
      true,
    );
  });

  it('renders assistant dots in the same tone as the body text', () => {
    const original = getTuiThemeSnapshot();
    const originalPalette =
      original.appearance === 'light' ? MINIMAX_CODE_LIGHT_THEME : MINIMAX_CODE_DARK_THEME;
    applyTuiRenderTheme(MINIMAX_CODE_DARK_THEME, 3);
    try {
      const view = new TranscriptView(() => [
        createTranscriptCell({
          id: 'assistant-tone-anchor',
          kind: 'assistant',
          status: 'succeeded',
          content: 'Same tone',
          createdAtMs: 1,
        }),
      ]);
      const line = view.render(28)[0] ?? '';
      const color = createTuiChalk({ colorLevel: 3 });

      expect(line).toContain(color.hex(MINIMAX_CODE_DARK_THEME.colors.text)('●'));
      expect(line).not.toContain(color.hex(MINIMAX_CODE_DARK_THEME.colors.signal)('●'));
    } finally {
      applyTuiRenderTheme(originalPalette, original.colorLevel);
    }
  });

  it('keeps assistant dots and Markdown within narrow terminal widths', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'assistant-narrow-anchor',
        kind: 'assistant',
        status: 'succeeded',
        content: [
          'A compact answer with a long line that wraps.',
          '',
          '```ts',
          'const value = 1;',
          '```',
        ].join('\n'),
        createdAtMs: 1,
      }),
    ]);

    const lines = view.render(28);
    const plainLines = lines.map((line) => stripVTControlCharacters(line).trimEnd());

    expect(plainLines[0]).toMatch(/^● /u);
    expect(plainLines.slice(1).every((line) => !line.includes('●'))).toBe(true);
    expect(plainLines.join('\n')).toContain('const value = 1;');
    expect(lines.every((line) => visibleWidth(line) <= 28)).toBe(true);
    for (const width of [0, 1, 2, 3, 4, 8]) {
      expect(view.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });

  it('renders assistant code blocks as compact highlighted content without chrome', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'assistant-code',
        kind: 'assistant',
        status: 'succeeded',
        content:
          "```ts title=policy\nconst startupExecutionPolicy = 'quarantined-with-a-long-suffix';\n```",
        createdAtMs: 1,
      }),
    ]);

    const lines = view.render(28);
    const plainLines = lines.map((line) => stripVTControlCharacters(line).trimEnd());

    expect(plainLines.join('\n')).not.toContain('```');
    expect(plainLines.join('\n')).not.toMatch(/[╭╮╰╯│]/u);
    expect(plainLines.join('\n')).toContain('startupExecutionPolicy');
    expect(plainLines.join('\n')).toContain('quarantined-with-a-');
    expect(lines.every((line) => visibleWidth(line) <= 28)).toBe(true);
  });

  it('invalidates a streaming frame when content changes at the same Runtime timestamp', () => {
    let cells = [
      createTranscriptCell({
        id: 'thinking-live',
        kind: 'thinking',
        status: 'running',
        content: 'First chunk',
        createdAtMs: 1,
        updatedAtMs: 10,
        expanded: true,
      }),
    ];
    const view = new TranscriptView(() => cells);

    const first = view.render(50);
    const current = cells[0];
    if (!current) throw new Error('missing transcript fixture');
    cells = [{ ...current, content: 'First chunk\nSecond chunk' }];
    const second = view.render(50);

    expect(second).not.toBe(first);
    expect(second.join('\n')).toContain('Second chunk');
  });

  it('renders Pi Markdown tables, nested blocks, and partial closing fences', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'assistant-markdown',
        kind: 'assistant',
        status: 'running',
        content: [
          '| Name | State |',
          '| --- | --- |',
          '| Markdown | **ready** |',
          '',
          '> Notes',
          '> - nested `code`',
          '',
          '```ts',
          'const value = 1;',
          '``',
        ].join('\n'),
        createdAtMs: 1,
      }),
    ]);

    const rendered = view.render(60).join('\n');

    expect(rendered).toContain('│ Name');
    expect(rendered).toContain('│ Notes');
    expect(rendered).toContain('- nested code');
    expect(rendered).toContain('const value = 1;');
    expect(rendered.match(/^\s*``\s*$/gmu)).toBeNull();
  });

  it('renders local inspection reports as a complete bordered table', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'inspection-status',
        kind: 'inspection',
        status: 'succeeded',
        content: 'MCode status\nAccount: Connected with MiniMax',
        inspection: {
          title: 'MCode status',
          badge: { label: 'READY', tone: 'success' },
          sections: [
            {
              title: 'Account',
              rows: [
                { label: 'Account', value: 'Connected with MiniMax', tone: 'success' },
                { label: 'Provider', value: 'minimax' },
              ],
            },
            {
              title: 'Model',
              rows: [{ label: 'Active', value: 'minimax/MiniMax-M3' }],
            },
          ],
          footer: 'Read only',
        },
        createdAtMs: 1,
      }),
    ]);

    const rendered = stripVTControlCharacters(view.render(60).join('\n'));

    expect(rendered).toContain('╭─');
    expect(rendered).toMatch(/│ MCode status\s+● READY │/u);
    expect(rendered).toContain('READY');
    expect(rendered).toContain('├─ Account ');
    expect(rendered).toMatch(/│ Account\s+│ Connected with MiniMax\s+│/u);
    expect(rendered).toContain('├─ Model ');
    expect(rendered).toMatch(/│ Read only\s+│/u);
    expect(rendered).toContain('╰─');
    expect(rendered.split('\n').every((line) => visibleWidth(line) === 60)).toBe(true);
  });

  it('stacks inspection labels and values on narrow terminals', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'inspection-config',
        kind: 'inspection',
        status: 'succeeded',
        content: 'Effective configuration',
        inspection: {
          title: 'Effective configuration',
          badge: { label: 'READ ONLY', tone: 'accent' },
          sections: [
            {
              title: 'Location',
              rows: [
                {
                  label: 'Source',
                  value: '/home/dev/.minimax/config.yaml',
                },
              ],
            },
          ],
        },
        createdAtMs: 1,
      }),
    ]);

    const rendered = stripVTControlCharacters(view.render(28).join('\n'));

    expect(rendered).toMatch(/│ Source\s+│/u);
    expect(rendered).toContain('│   /home/dev/.minimax');
    expect(rendered).toContain('│   /config.yaml');
    expect(rendered).not.toMatch(/│ Source\s+│?\s*\/home/u);
    expect(rendered).toContain('╰─');
    expect(rendered.split('\n').every((line) => visibleWidth(line) === 28)).toBe(true);
  });

  it('routes usage inspection reports through the compact usage visualization', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'inspection-usage',
        kind: 'inspection',
        status: 'succeeded',
        content: 'Session usage',
        inspection: {
          title: 'Session usage',
          badge: { label: 'HIDDEN', tone: 'accent' },
          sections: [{ title: 'Internal details', rows: [{ label: 'Turns', value: '9' }] }],
          footer: 'Runtime source',
          visualization: {
            kind: 'usage',
            model: 'minimax-cn-coding-plan/MiniMax-M3',
            inputTokens: 145_000,
            outputTokens: 1_400,
            totalTokens: 146_400,
            context: null,
          },
        },
        createdAtMs: 1,
      }),
    ]);

    const rendered = stripVTControlCharacters(view.render(60).join('\n'));

    expect(rendered).toContain('Usage');
    expect(rendered).not.toContain('HIDDEN');
    expect(rendered).not.toContain('Internal details');
    expect(rendered).not.toContain('Runtime source');
    expect(rendered.split('\n').every((line) => visibleWidth(line) <= 60)).toBe(true);
  });

  it('reuses unaffected item renders when Ctrl+O changes detail presentation', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'assistant-before-details',
        kind: 'assistant',
        status: 'succeeded',
        content: 'Stable answer',
        createdAtMs: 1,
      }),
      createTranscriptCell({
        id: 'tool-details',
        kind: 'tool',
        status: 'succeeded',
        title: 'bash',
        content: '{"command":"pnpm test"}',
        detail: 'result line 1\nresult line 2',
        createdAtMs: 2,
      }),
      createTranscriptCell({
        id: 'summary-after-details',
        kind: 'final-summary',
        status: 'succeeded',
        content: 'Stable summary',
        createdAtMs: 3,
      }),
    ]);

    view.render(60);
    view.toggleDetailMode();
    const detailed = view.render(60).join('\n');
    const performance = view.getPerformanceSnapshot();

    expect(detailed).toContain('result line 1');
    expect(performance.unitCacheHits).toBe(2);
    expect(performance.unitCacheMisses).toBe(1);
  });

  it('rerenders only the active item while detailed content streams', () => {
    const store = new TranscriptStore([
      createTranscriptCell({
        id: 'settled-before-stream',
        kind: 'assistant',
        status: 'succeeded',
        content: 'Stable answer',
        createdAtMs: 1,
      }),
      createTranscriptCell({
        id: 'active-thinking-stream',
        kind: 'thinking',
        status: 'running',
        content: 'Inspecting',
        createdAtMs: 2,
      }),
    ]);
    const view = new TranscriptView(store);
    view.toggleDetailMode();
    view.render(60);

    store.upsert({
      id: 'active-thinking-stream',
      content: 'Inspecting the renderer',
      updatedAtMs: 3,
    });
    const rendered = view.render(60).join('\n');
    const performance = view.getPerformanceSnapshot();

    expect(rendered).toContain('Inspecting the renderer');
    expect(performance.unitCacheHits).toBe(1);
    expect(performance.unitCacheMisses).toBe(1);
  });

  it('uses the generic fallback for tools without a built-in definition', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'deploy-1',
        kind: 'tool',
        status: 'succeeded',
        title: 'deploy',
        content: 'preview',
        createdAtMs: 1,
      }),
    ]);

    expect(view.render(50).join('\n')).toContain('Deploy (preview)');
  });

  it('renders product Web Tool summaries and hides output in compact mode', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'web-search',
        kind: 'tool',
        status: 'succeeded',
        title: 'mcp__matrix__web_search',
        content: '{"query":"AI news today 2026-08-07"}',
        detail: 'private search result',
        createdAtMs: 1,
      }),
      createTranscriptCell({
        id: 'web-fetch',
        kind: 'tool',
        status: 'succeeded',
        title: 'web_fetch',
        content: '{"url":"https://example.com/article"}',
        detail: 'private fetched body',
        createdAtMs: 2,
      }),
    ]);

    const compact = stripVTControlCharacters(view.render(90).join('\n'));
    expect(compact).toContain('Used WebSearch (AI news today 2026-08-07)');
    expect(compact).toContain('Used WebFetch (https://example.com/article)');
    expect(compact).not.toContain('matrix.web_search');
    expect(compact).not.toContain('private search result');
    expect(compact).not.toContain('private fetched body');

    view.toggleDetailMode();
    const detailed = stripVTControlCharacters(view.render(90).join('\n'));
    expect(detailed).toContain('private search result');
    expect(detailed).toContain('private fetched body');
  });

  it('keeps non-Web MCP identities while hiding their output in compact mode', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'mcp-1',
        kind: 'tool',
        status: 'succeeded',
        title: 'mcp__jira__create_issue',
        content: '{"description":"Broken checkout"}',
        detail: 'issue-123',
        createdAtMs: 1,
      }),
    ]);

    const compact = stripVTControlCharacters(view.render(72).join('\n'));
    expect(compact).toContain('Called jira.create_issue (Broken checkout)');
    expect(compact).not.toContain('issue-123');

    view.toggleDetailMode();
    expect(stripVTControlCharacters(view.render(72).join('\n'))).toContain('issue-123');
  });

  it('keeps failed Web Tool errors hidden until detailed mode is requested', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'web-fetch-failed',
        kind: 'tool',
        status: 'failed',
        title: 'web_fetch',
        content: '{"url":"https://example.com/missing"}',
        detail: 'HTTP 404 response body',
        createdAtMs: 1,
      }),
    ]);

    const compact = stripVTControlCharacters(view.render(72).join('\n'));
    expect(compact).toContain('WebFetch failed (https://example.com/missing)');
    expect(compact).not.toContain('HTTP 404 response body');

    view.toggleDetailMode();
    expect(stripVTControlCharacters(view.render(72).join('\n'))).toContain(
      'HTTP 404 response body',
    );
  });

  it('hides structured changes until Tool details are requested', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'edit-1',
        kind: 'tool',
        status: 'succeeded',
        title: 'edit',
        content: '{"path":"src/greeting.ts"}',
        structuredPreview: {
          schemaVersion: 1,
          state: 'applied',
          blocks: [
            {
              kind: 'diff',
              path: 'src/greeting.ts',
              diff: '- old greeting\n+ new greeting',
              addedLines: 1,
              removedLines: 1,
              truncated: false,
            },
          ],
        },
        createdAtMs: 1,
        turnId: 'turn-1',
      }),
    ]);

    const compact = stripVTControlCharacters(view.render(60).join('\n'));
    expect(compact).toContain('Edited (src/greeting.ts)');
    expect(compact).not.toContain('Applied');
    expect(compact).not.toContain('- old greeting');
    expect(compact).not.toContain('+ new greeting');

    view.toggleDetailMode();
    const detailed = stripVTControlCharacters(view.render(60).join('\n'));
    expect(detailed).toContain('Applied');
    expect(detailed).toContain('- old greeting');
    expect(detailed).toContain('+ new greeting');
  });

  it.each([{ width: 80 }, { width: 40 }, { width: 28 }])(
    'keeps Tool rows within the terminal width at $width columns',
    ({ width }) => {
      const view = new TranscriptView(() => [
        createTranscriptCell({
          id: `responsive-tool-${width}`,
          kind: 'tool',
          status: 'succeeded',
          title: 'bash',
          content: JSON.stringify({ command: 'pnpm test' }),
          detail: 'All tests passed',
          createdAtMs: 1,
        }),
      ]);

      const lines = view.render(width);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    },
  );

  it('avoids duplicate structured success output but keeps the failure reason', () => {
    const preview = {
      schemaVersion: 1 as const,
      state: 'not-applied' as const,
      blocks: [
        {
          kind: 'diff' as const,
          path: 'src/greeting.ts',
          diff: '- old greeting\n+ new greeting',
          addedLines: 1,
          removedLines: 1,
          truncated: false,
        },
      ],
    };
    const succeeded = createTranscriptCell({
      id: 'edit-succeeded',
      kind: 'tool',
      status: 'succeeded',
      title: 'edit',
      content: '{"path":"src/greeting.ts"}',
      detail: 'duplicate raw success payload',
      structuredPreview: { ...preview, state: 'applied' },
      createdAtMs: 1,
    });
    const failed = createTranscriptCell({
      ...succeeded,
      id: 'edit-failed',
      status: 'failed',
      detail: 'Permission denied',
      structuredPreview: preview,
    });

    const successView = new TranscriptView(() => [succeeded]);
    const failureView = new TranscriptView(() => [failed]);
    successView.toggleDetailMode();
    failureView.toggleDetailMode();
    const successOutput = stripVTControlCharacters(successView.render(64).join('\n'));
    const failureOutput = stripVTControlCharacters(failureView.render(64).join('\n'));

    expect(successOutput).toContain('Applied');
    expect(successOutput).not.toContain('duplicate raw success payload');
    expect(failureOutput).toContain('Not applied');
    expect(failureOutput).toContain('Permission denied');
  });

  it('keeps completed Diff previews hidden until inline details are requested', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'edit-large',
        kind: 'tool',
        status: 'succeeded',
        title: 'edit',
        content: '{"path":"src/large.ts"}',
        structuredPreview: {
          schemaVersion: 1,
          state: 'applied',
          blocks: [
            {
              kind: 'diff',
              path: 'src/large.ts',
              diff: Array.from({ length: 8 }, (_, index) => `+ line ${index + 1}`).join('\n'),
              addedLines: 8,
              removedLines: 0,
              truncated: false,
            },
          ],
        },
        createdAtMs: 1,
      }),
    ]);

    const compact = stripVTControlCharacters(view.render(60).join('\n'));
    expect(compact).toContain('Edited (src/large.ts)');
    expect(compact).not.toContain('Applied');
    expect(compact).not.toContain('lines hidden');
    expect(compact).not.toContain('+ line 8');

    expect(view.toggleDetailMode()).toBe('detailed');
    const detailed = stripVTControlCharacters(view.render(60).join('\n'));
    expect(detailed).toContain('+ line 8');
    expect(detailed).not.toContain('lines hidden');
  });

  it('renders intent and execution as one compact visual rail', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'user-1',
        kind: 'user',
        status: 'succeeded',
        content: 'Please **inspect** this.',
        createdAtMs: 1,
        turnId: 'turn-1',
      }),
      createTranscriptCell({
        id: 'thinking-1',
        kind: 'thinking',
        status: 'running',
        content: 'Reading the repository',
        createdAtMs: 2,
        turnId: 'turn-1',
        expanded: true,
      }),
      createTranscriptCell({
        id: 'tool-1',
        kind: 'tool',
        status: 'running',
        title: 'read',
        content: 'README.md',
        createdAtMs: 3,
        turnId: 'turn-1',
      }),
      createTranscriptCell({
        id: 'assistant-1',
        kind: 'assistant',
        status: 'running',
        content: 'I found `one` result.',
        createdAtMs: 4,
        turnId: 'turn-1',
      }),
      createTranscriptCell({
        id: 'error-1',
        kind: 'error',
        status: 'failed',
        content: 'provider unavailable',
        createdAtMs: 5,
      }),
    ]);

    const lines = view.render(50);
    const rendered = lines.join('\n');

    expect(rendered).toContain('› Please inspect this.');
    expect(rendered).not.toContain('YOU');
    expect(rendered).toContain('├ • Thinking…');
    expect(rendered).toContain('│   Reading the repository');
    expect(rendered).toContain('└ • Reading (README.md)');
    expect(rendered).toContain('I found one result.');
    expect(rendered).toContain('× Error  provider unavailable');
    const thinkingIndex = lines.findIndex((line) => line.includes('Reading the repository'));
    expect(lines[thinkingIndex + 1]).toContain('Reading (README.md)');
  });

  it('renders user messages as a vertically padded full-width prompt band', () => {
    const original = getTuiThemeSnapshot();
    const originalPalette =
      original.appearance === 'light' ? MINIMAX_CODE_LIGHT_THEME : MINIMAX_CODE_DARK_THEME;
    applyTuiRenderTheme(MINIMAX_CODE_LIGHT_THEME, 3);
    try {
      const view = new TranscriptView(() => [
        createTranscriptCell({
          id: 'user-band',
          kind: 'user',
          status: 'succeeded',
          content: 'Short message',
          createdAtMs: 1,
        }),
      ]);

      const lines = view.render(24);

      expect(lines).toHaveLength(3);
      expect(lines.map(stripVTControlCharacters)).toEqual([
        ' '.repeat(24),
        ' › Short message'.padEnd(24),
        ' '.repeat(24),
      ]);
      expect(lines.join('\n')).not.toContain('YOU');
      expect(lines.every((line) => line.includes('\u001B[48;2;245;245;245m'))).toBe(true);
      expect(lines.every((line) => visibleWidth(line) === 24)).toBe(true);
    } finally {
      applyTuiRenderTheme(originalPalette, original.colorLevel);
    }
  });

  it('renders structured attachment cards before user text and omits an empty text band', () => {
    const withText = new TranscriptView(() => [
      createTranscriptCell({
        id: 'user-with-attachments',
        kind: 'user',
        status: 'succeeded',
        content: 'Inspect these files',
        attachments: [
          {
            type: 'image',
            fileName: 'diagram.png',
            mimeType: 'image/png',
            sizeBytes: 2048,
          },
          {
            type: 'file',
            fileName: 'notes.md',
            mimeType: 'text/markdown',
          },
          {
            type: 'file',
            fileName: 'walkthrough.mov',
            mimeType: 'video/quicktime',
            sizeBytes: 4096,
          },
        ],
        createdAtMs: 1,
      }),
    ]);

    const rendered = withText.render(48).map(stripVTControlCharacters);
    const imageIndex = rendered.findIndex((line) => line.includes('Image  diagram.png'));
    const fileIndex = rendered.findIndex((line) => line.includes('File  notes.md'));
    const videoIndex = rendered.findIndex((line) => line.includes('Video  walkthrough.mov'));
    const textIndex = rendered.findIndex((line) => line.includes('› Inspect these files'));

    expect(imageIndex).toBeGreaterThanOrEqual(0);
    expect(fileIndex).toBeGreaterThan(imageIndex);
    expect(videoIndex).toBeGreaterThan(fileIndex);
    expect(textIndex).toBeGreaterThan(videoIndex);
    expect(rendered.join('\n')).not.toContain('Attachments:');

    const attachmentOnly = new TranscriptView(() => [
      createTranscriptCell({
        id: 'attachment-only',
        kind: 'user',
        status: 'succeeded',
        content: '',
        attachments: [
          {
            type: 'image',
            fileName: 'only.png',
            mimeType: 'image/png',
            sizeBytes: 1024,
          },
        ],
        createdAtMs: 1,
      }),
    ]);
    const attachmentOnlyLines = attachmentOnly.render(48).map(stripVTControlCharacters);

    expect(attachmentOnlyLines.join('\n')).toContain('Image  only.png');
    expect(attachmentOnlyLines.every((line) => !line.includes('›'))).toBe(true);
  });

  it('shows a bounded result preview below a completed tool', () => {
    const view = new TranscriptView(
      () => [
        createTranscriptCell({
          id: 'tool-1',
          kind: 'tool',
          status: 'succeeded',
          title: 'bash',
          content: 'pnpm test',
          detail: ['114 tests passed', '0 failed', 'completed in 1.4s', 'coverage 92%'].join('\n'),
          createdAtMs: 1,
        }),
      ],
      { displayModes: previewDisplayModes },
    );

    const lines = view.render(40);
    const rendered = lines.join('\n');

    expect(rendered).toContain('└ • Ran  pnpm test · 4 output lines');
    expect(rendered).toContain('$ pnpm test');
    expect(rendered).toContain('114 tests passed');
    expect(rendered).toContain('1 line hidden');
    expect(rendered).toContain('coverage 92%');
    expect(rendered).not.toContain('completed in 1.4s');
  });

  it('distinguishes a running background bash dispatch from a foreground command', () => {
    const view = new TranscriptView(
      () => [
        createTranscriptCell({
          id: 'tool-background-running',
          kind: 'tool',
          status: 'running',
          title: 'bash',
          content: JSON.stringify({ command: 'sleep 30', run_in_background: true }),
          createdAtMs: 1,
        }),
      ],
      { displayModes: previewDisplayModes },
    );

    const rendered = view.render(80).map(stripVTControlCharacters).join('\n');

    expect(rendered).toContain('Starting background task');
    expect(rendered).toContain('$ sleep 30');
    expect(rendered).not.toContain('Running  ');
  });

  it('shows the task id after a background bash dispatch starts', () => {
    const view = new TranscriptView(
      () => [
        createTranscriptCell({
          id: 'tool-background-started',
          kind: 'tool',
          status: 'succeeded',
          title: 'bash',
          content: JSON.stringify({ command: 'sleep 30', run_in_background: true }),
          detail:
            '<bash_background task_id="bg_abc123">\nStarted local background bash task bg_abc123.\n</bash_background>',
          createdAtMs: 1,
        }),
      ],
      { displayModes: previewDisplayModes },
    );

    const rendered = view.render(80).map(stripVTControlCharacters).join('\n');

    expect(rendered).toContain('Started background task  bg_abc123');
    expect(rendered).toContain('$ sleep 30');
    expect(rendered).not.toContain('3 output lines');
    expect(rendered).not.toContain('<bash_background');
  });

  it('recognizes replayed background bash history from its result envelope', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'tool-background-replayed',
        kind: 'tool',
        status: 'succeeded',
        title: 'bash',
        content: JSON.stringify({ command: 'sleep 30' }),
        detail:
          '<bash_background task_id="bg_replayed">\nStarted local background bash task bg_replayed.\n</bash_background>',
        createdAtMs: 1,
      }),
    ]);

    const rendered = view.render(80).map(stripVTControlCharacters).join('\n');

    expect(rendered).toContain('Started background task  bg_replayed');
    expect(rendered).not.toContain('Ran  3 output lines');
  });

  it('keeps multiline shell commands out of the single-line execution summary', () => {
    const command = [
      "git commit -q -F - <<'EOF'",
      'fix(tui): keep execution rows aligned',
      '',
      'Keep multiline commit messages on the detail rail.',
      'EOF',
    ].join('\n');
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'tool-multiline-shell',
        kind: 'tool',
        status: 'succeeded',
        title: 'bash',
        content: JSON.stringify({ command }),
        createdAtMs: 1,
      }),
    ]);

    const compact = view.render(80).map(stripVTControlCharacters);

    expect(compact).toEqual(["└ • Ran  git commit -q -F - <<'EOF'… · no output"]);
    expect(compact.join('\n')).not.toContain('fix(tui): keep execution rows aligned');

    view.toggleDetailMode();
    const detailed = view.render(80).map(stripVTControlCharacters);

    expect(detailed[0]).toBe("└ • Ran  git commit -q -F - <<'EOF'… · no output");
    expect(detailed[1]).toBe("    $ git commit -q -F - <<'EOF'");
    expect(detailed[2]).toBe('      fix(tui): keep execution rows aligned');
  });

  it('shows the shell command alongside the output count on the collapsed row', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'tool-shell-summary',
        kind: 'tool',
        status: 'succeeded',
        title: 'bash',
        content: JSON.stringify({ command: 'git merge origin/preview_train' }),
        detail: 'Updating a1b2c3d..e4f5g6h\nFast-forward',
        createdAtMs: 1,
      }),
    ]);

    const rendered = view.render(80).map(stripVTControlCharacters);

    expect(rendered[0]).toBe('└ • Ran  git merge origin/preview_train · 2 output lines');
  });

  it('syntax-highlights executable commands on the collapsed shell row', () => {
    const original = getTuiThemeSnapshot();
    const originalPalette =
      original.appearance === 'light' ? MINIMAX_CODE_LIGHT_THEME : MINIMAX_CODE_DARK_THEME;
    applyTuiRenderTheme(MINIMAX_CODE_DARK_THEME, 3);

    try {
      const command = 'ls packages/tui/src/ && echo "---" && ls packages/tui/src/tui/ 2>/dev/null';
      const view = new TranscriptView(() => [
        createTranscriptCell({
          id: 'tool-shell-highlighted-summary',
          kind: 'tool',
          status: 'succeeded',
          title: 'bash',
          content: JSON.stringify({ command }),
          detail: 'account\nacp',
          createdAtMs: 1,
        }),
      ]);

      const rendered = view.render(140)[0] ?? '';
      const ansi = createTuiChalk({ colorLevel: 3 });

      expect(stripVTControlCharacters(rendered)).toBe(`└ • Ran  ${command} · 2 output lines`);
      expect(rendered).toContain(ansi.bold.hex(tuiColors.accent)('ls'));
      expect(rendered).toContain(ansi.bold.hex(tuiColors.accent)('echo'));
    } finally {
      applyTuiRenderTheme(originalPalette, original.colorLevel);
    }
  });

  it('trims the shell command but keeps the output count when the row is narrow', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'tool-shell-narrow',
        kind: 'tool',
        status: 'succeeded',
        title: 'bash',
        content: JSON.stringify({
          command: 'pnpm --filter @mavis/ui exec vitest run packages/ui/test/unit/example.test.tsx',
        }),
        detail: 'ok',
        createdAtMs: 1,
      }),
    ]);

    const rendered = view.render(56).map(stripVTControlCharacters);

    expect(rendered[0]).toContain('1 output line');
    expect(rendered[0]).toContain('…');
    expect(rendered[0]?.length).toBeLessThanOrEqual(56);
  });

  it('keeps failed search queries on a single execution-summary row', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'tool-multiline-search',
        kind: 'tool',
        status: 'failed',
        title: 'search',
        content: JSON.stringify({ query: 'compact",\noutput_mode' }),
        detail: 'No matches found',
        createdAtMs: 1,
      }),
    ]);

    const compact = view.render(80).map(stripVTControlCharacters);

    expect(compact[0]).toBe('└ × Search failed (compact",)');
    expect(compact[0]).not.toContain('\n');
  });

  it('labels an invalid grep regex separately from a generic search failure', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'tool-invalid-regex',
        kind: 'tool',
        status: 'failed',
        title: 'grep',
        content: JSON.stringify({ pattern: '(?:fork: async|fork(input)' }),
        detail: 'Invalid search pattern: unclosed group.',
        toolErrorCode: 'invalid_regex',
        createdAtMs: 1,
      }),
    ]);

    const compact = view.render(100).map(stripVTControlCharacters);

    expect(compact[0]).toBe('└ × Invalid search pattern ((?:fork: async|fork(input))');
  });

  it('shows live Thinking detail and fully collapses it on completion', () => {
    const running = createTranscriptCell({
      id: 'thinking-running',
      kind: 'thinking',
      status: 'running',
      content: 'Inspecting the repository',
      createdAtMs: 1_000,
      updatedAtMs: 1_600,
    });
    const completed = createTranscriptCell({
      ...running,
      id: 'thinking-completed',
      status: 'succeeded',
      durationMs: 1_600,
      updatedAtMs: 2_600,
    });

    const live = new TranscriptView(() => [running]).render(60).join('\n');
    const settled = new TranscriptView(() => [completed]).render(60).join('\n');

    expect(live).toContain('Thinking…');
    expect(live).toContain('Inspecting the repository');
    expect(settled).toContain('Thought for 1.6s');
    expect(settled).not.toContain('Inspecting the repository');
  });

  it('keeps live Thinking to a tail preview until the user expands it', () => {
    const running = createTranscriptCell({
      id: 'thinking-running-preview',
      kind: 'thinking',
      status: 'running',
      content: ['one', 'two', 'three', 'four', 'five'].join('\n'),
      createdAtMs: 1,
    });
    const expanded = createTranscriptCell({
      ...running,
      id: 'thinking-running-expanded',
      expanded: true,
    });

    const preview = new TranscriptView(() => [running]).render(60).join('\n');
    expect(preview).not.toContain('one');
    expect(preview).not.toContain('two');
    expect(preview).toContain('2 earlier lines');
    expect(preview).toContain('three');
    expect(preview).toContain('five');

    const fullView = new TranscriptView(() => [expanded]);
    fullView.toggleDetailMode();
    const full = fullView.render(60).join('\n');
    expect(full).toContain('one');
    expect(full).toContain('five');
  });

  it('uses tool-specific bounded previews for live output and errors', () => {
    const detail = Array.from({ length: 14 }, (_, index) => `output-${index + 1}`).join('\n');
    const running = createTranscriptCell({
      id: 'tool-bash-running-preview',
      kind: 'tool',
      status: 'running',
      title: 'bash',
      content: 'pnpm test',
      detail,
      createdAtMs: 1,
    });
    const failed = createTranscriptCell({
      ...running,
      id: 'tool-bash-failed-preview',
      status: 'failed',
    });

    const live = new TranscriptView(() => [running], {
      displayModes: previewDisplayModes,
    })
      .render(80)
      .join('\n');
    expect(live).not.toContain('output-1\n');
    expect(live).toContain('11 earlier lines');
    expect(live).toContain('output-14');

    const error = new TranscriptView(() => [failed], {
      displayModes: previewDisplayModes,
    })
      .render(80)
      .join('\n');
    expect(error).toContain('output-14');
    expect(error).not.toContain('output-1\n');
  });

  it('bounds previews by rendered rows when one physical line wraps', () => {
    const view = new TranscriptView(
      () => [
        createTranscriptCell({
          id: 'tool-read-wrapped-preview',
          kind: 'tool',
          status: 'running',
          title: 'read',
          content: 'README.md',
          detail: Array.from({ length: 80 }, (_, index) => `word-${index + 1}`).join(' '),
          createdAtMs: 1,
        }),
      ],
      { displayModes: previewDisplayModes },
    );

    const detailLines = view.render(30).slice(1);

    expect(detailLines.length).toBeLessThanOrEqual(4);
    expect(detailLines.join('\n')).toContain('earlier lines');
    expect(detailLines.join('\n')).toContain('word-80');
  });

  it('hides a running tool result until the user requests details', () => {
    const running = createTranscriptCell({
      id: 'tool-running',
      kind: 'tool',
      status: 'running',
      title: 'bash',
      content: 'pnpm test',
      detail: 'streaming output',
      createdAtMs: 1,
    });
    const view = new TranscriptView(() => [running]);
    expect(view.render(60).join('\n')).not.toContain('streaming output');
    view.toggleDetailMode();
    expect(view.render(60).join('\n')).toContain('streaming output');
  });

  it('keeps completed Thinking collapsed while live Thinking remains visible', () => {
    const completed = createTranscriptCell({
      id: 'thinking-completed',
      kind: 'thinking',
      status: 'succeeded',
      content: ['First decision', 'Second decision', 'Third decision', 'Final detail'].join('\n'),
      createdAtMs: 1,
    });
    const running = createTranscriptCell({
      id: 'thinking-running',
      kind: 'thinking',
      status: 'running',
      content: 'Inspecting the code',
      createdAtMs: 2,
    });
    const completedView = new TranscriptView(() => [completed]);
    const compact = completedView.render(40).join('\n');
    expect(compact).toContain('Thought');
    expect(compact).not.toContain('First decision');
    expect(compact).not.toContain('Final detail');
    expect(new TranscriptView(() => [running]).render(40).join('\n')).toContain(
      'Inspecting the code',
    );
    completedView.toggleDetailMode();
    expect(completedView.render(40).join('\n')).toContain('First decision');
    expect(completedView.render(40).join('\n')).toContain('Final detail');
  });

  it('extracts the useful target from structured tool arguments', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'tool-structured',
        kind: 'tool',
        status: 'running',
        title: 'read',
        content: JSON.stringify({ path: 'src/cart/price.ts', offset: 120 }),
        createdAtMs: 1,
      }),
    ]);

    const rendered = view.render(50).join('\n');

    expect(rendered).toContain('Reading (src/cart/price.ts)');
    expect(rendered).not.toContain('{"path"');
  });

  it('collapses grouped read targets in compact mode and reveals them in detailed mode', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'thinking-1',
        kind: 'thinking',
        status: 'running',
        content: 'Inspecting the implementation',
        createdAtMs: 1,
        turnId: 'turn-1',
      }),
      createTranscriptCell({
        id: 'read-1',
        kind: 'tool',
        status: 'succeeded',
        title: 'read',
        content: JSON.stringify({ path: 'src/app.ts' }),
        createdAtMs: 2,
        turnId: 'turn-1',
      }),
      createTranscriptCell({
        id: 'read-2',
        kind: 'tool',
        status: 'running',
        title: 'read',
        content: JSON.stringify({ path: 'src/runtime.ts' }),
        createdAtMs: 3,
        turnId: 'turn-1',
      }),
      createTranscriptCell({
        id: 'read-3',
        kind: 'tool',
        status: 'failed',
        title: 'read',
        content: JSON.stringify({ path: 'src/missing.ts' }),
        createdAtMs: 4,
        turnId: 'turn-1',
      }),
      createTranscriptCell({
        id: 'read-4',
        kind: 'tool',
        status: 'succeeded',
        title: 'read',
        content: JSON.stringify({ path: 'src/app.ts' }),
        createdAtMs: 5,
        turnId: 'turn-1',
      }),
      createTranscriptCell({
        id: 'bash-1',
        kind: 'tool',
        status: 'running',
        title: 'bash',
        content: JSON.stringify({ command: 'pnpm test' }),
        createdAtMs: 6,
        turnId: 'turn-1',
      }),
    ]);

    const compact = view.render(64).join('\n');

    expect(compact).toContain('Reading 3 files');
    expect(compact).toContain('1 failed');
    expect(compact).not.toContain('src/app.ts');
    expect(compact).not.toContain('src/runtime.ts');
    expect(compact).not.toContain('src/missing.ts');
    expect(compact).toContain('└ • Running');
    expect(compact).toContain('pnpm test');

    view.toggleDetailMode();
    const detailed = view.render(64).join('\n');

    expect(detailed).toContain('src/app.ts');
    expect(detailed).toContain('src/runtime.ts');
    expect(detailed).toContain('reading');
    expect(detailed).toContain('src/missing.ts');
    expect(detailed).toContain('failed');
    expect(detailed).toContain('$ pnpm test');
    expect(detailed.match(/src\/app\.ts/gu)).toHaveLength(2);
    expect(compact).toContain('4 calls');
    expect(detailed.match(/\bRead {2}src\//gu)).toBeNull();
  });

  it('keeps read groups turn-scoped and preserves expanded details', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'read-1',
        kind: 'tool',
        status: 'succeeded',
        title: 'read',
        content: 'src/a.ts',
        detail: 'const a = 1;',
        expanded: true,
        createdAtMs: 1,
        turnId: 'turn-1',
      }),
      createTranscriptCell({
        id: 'read-2',
        kind: 'tool',
        status: 'succeeded',
        title: 'read',
        content: 'src/b.ts',
        createdAtMs: 2,
        turnId: 'turn-1',
      }),
      createTranscriptCell({
        id: 'read-3',
        kind: 'tool',
        status: 'succeeded',
        title: 'read',
        content: 'src/c.ts',
        createdAtMs: 3,
        turnId: 'turn-2',
      }),
    ]);

    const compact = view.render(50).join('\n');

    expect(compact).toContain('Read 2 files');
    expect(compact).not.toContain('const a = 1;');
    expect(compact).toContain('Read (src/c.ts)');

    view.toggleDetailMode();
    expect(view.render(50).join('\n')).toContain('const a = 1;');
  });

  it('labels a single image read as Read Image', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'read-image',
        kind: 'tool',
        status: 'succeeded',
        title: 'read',
        content: JSON.stringify({ path: 'figures/reference_overview.png' }),
        detail: 'Read image file [image/png]',
        createdAtMs: 1,
      }),
    ]);

    const rendered = stripVTControlCharacters(view.render(80).join('\n'));

    expect(rendered).toContain('Read Image (figures/reference_overview.png)');
  });

  it('collapses grouped search and path targets while preserving the concrete action', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'search-1',
        kind: 'tool',
        status: 'succeeded',
        title: 'grep',
        content: JSON.stringify({ query: 'watchStream' }),
        createdAtMs: 1,
        turnId: 'turn-1',
      }),
      createTranscriptCell({
        id: 'list-1',
        kind: 'tool',
        status: 'succeeded',
        title: 'glob',
        content: JSON.stringify({ pattern: '**/*.ts' }),
        createdAtMs: 2,
        turnId: 'turn-1',
      }),
    ]);

    const compact = view.render(64).join('\n');

    expect(compact).toContain('Explored 2 operations');
    expect(compact).not.toContain('watchStream');
    expect(compact).not.toContain('**/*.ts');
    expect(compact).not.toContain('searching');
    expect(compact).not.toContain('listing');

    view.toggleDetailMode();
    const detailed = view.render(64).join('\n');

    expect(detailed).toContain('watchStream');
    expect(detailed).toContain('**/*.ts');
  });

  it('keeps unanswered prompts in the picker and shows compact answer progress and receipts', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'permission-1',
        kind: 'permission',
        status: 'blocked',
        title: 'bash',
        content: 'Run the unit tests',
        createdAtMs: 1,
      }),
      createTranscriptCell({
        id: 'permission-2',
        kind: 'permission',
        status: 'resolved',
        title: 'write_file',
        content: 'Update the changelog',
        detail: 'Allowed for this conversation · write_file',
        createdAtMs: 2,
      }),
      createTranscriptCell({
        id: 'question-1',
        kind: 'question',
        status: 'blocked',
        title: 'Input required',
        content: '',
        createdAtMs: 3,
      }),
      createTranscriptCell({
        id: 'question-2',
        kind: 'question',
        status: 'blocked',
        title: 'Release setup',
        content: 'Release channel  Stable',
        detail: '1 of 2 answered',
        createdAtMs: 4,
      }),
      createTranscriptCell({
        id: 'question-3',
        kind: 'question',
        status: 'pending',
        title: 'Answers sent',
        content: 'Release channel  Stable\nCollaboration  Mixed mode',
        detail: 'Sending your answer…',
        createdAtMs: 5,
      }),
      createTranscriptCell({
        id: 'question-4',
        kind: 'question',
        status: 'resolved',
        title: 'Answers sent',
        content: 'Release channel  Stable\nCollaboration  Mixed mode',
        detail: 'MCode is continuing…',
        createdAtMs: 6,
      }),
    ]);

    const rendered = view.render(60).join('\n');

    expect(rendered).not.toContain('Approval needed');
    expect(rendered).not.toContain('Run the unit tests');
    expect(rendered).toContain('✓ Allowed for this conversation · write_file');
    expect(rendered).not.toContain('Update the changelog');
    expect(rendered).not.toContain('decision panel');
    expect(rendered).toContain('◆ Answers so far');
    expect(rendered).toContain('1 of 2 answered');
    expect(rendered).toContain('● Sending answers…');
    expect(rendered).toContain('✓ Answers sent');
    expect(rendered).toContain('Release channel  Stable');
    expect(rendered).toContain('Collaboration  Mixed mode');
    expect(rendered).toContain('MCode is continuing');
    expect(rendered).not.toContain('/allow');
    expect(rendered).not.toContain('/q1');
  });

  it('uses a denied lifecycle marker for resolved permission receipts', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'permission-denied',
        kind: 'permission',
        status: 'resolved',
        title: 'bash',
        content: 'Run a command',
        detail: 'Denied · bash',
        createdAtMs: 1,
      }),
    ]);

    expect(view.render(48).join('\n')).toContain('× Denied · bash');
  });

  it('uses readable action labels and never exposes generic JSON as a tool summary', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'memory-1',
        kind: 'tool',
        status: 'succeeded',
        title: 'Memory',
        content: JSON.stringify({
          target: 'user',
          operation: 'append',
          content: 'large private implementation payload',
        }),
        createdAtMs: 1,
      }),
      createTranscriptCell({
        id: 'write-1',
        kind: 'tool',
        status: 'succeeded',
        title: 'write_file',
        content: JSON.stringify({ file_path: 'src/app.ts', contents: '...' }),
        createdAtMs: 2,
      }),
      createTranscriptCell({
        id: 'task-1',
        kind: 'tool',
        status: 'running',
        title: 'task',
        content: JSON.stringify({
          agent_name: 'verifier',
          description: 'Review recent CLI changes',
        }),
        createdAtMs: 3,
      }),
    ]);

    const rendered = view.render(80).join('\n');

    expect(rendered).toContain('Updated memory (user · append)');
    expect(rendered).toContain('Wrote (src/app.ts)');
    expect(rendered).not.toContain('large private implementation payload');
    expect(rendered).not.toContain('{"target"');
    expect(rendered).not.toContain('Write_file');
    expect(rendered).toContain('Delegating (verifier · Review recent CLI changes)');
  });

  it('uses blue for Ask User, gold for permission confirmation, and green after resolution', () => {
    expect(resolveTuiDecisionColor('question', false)).toBe(tuiColors.signal);
    expect(resolveTuiDecisionColor('permission', false)).toBe(tuiColors.warning);
    expect(resolveTuiDecisionColor('question', true)).toBe(tuiColors.success);
  });

  it('keeps every rail row inside a narrow terminal', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'user-narrow',
        kind: 'user',
        status: 'succeeded',
        content: 'Inspect this deliberately long request before changing anything.',
        createdAtMs: 1,
      }),
      createTranscriptCell({
        id: 'tool-narrow',
        kind: 'tool',
        status: 'running',
        title: 'read',
        content: 'src/a-deliberately-long-file-name.ts',
        detail: 'Waiting for a deliberately long result from the runtime.',
        createdAtMs: 2,
      }),
    ]);

    const lines = view.render(28);

    expect(lines.every((line) => visibleWidth(line) <= 28)).toBe(true);
    expect(lines.some((line) => line.includes('Read') && line.includes('…'))).toBe(true);
  });

  it('keeps a stable turn-window anchor as new cells append', () => {
    let cells = Array.from({ length: 80 }, (_, index) =>
      createTranscriptCell({
        id: `cell-${index + 1}`,
        turnId: `turn-${Math.floor(index / 2) + 1}`,
        kind: 'final-summary',
        status: 'succeeded',
        content: `message ${index + 1}`,
        createdAtMs: index + 1,
      }),
    );
    const view = new TranscriptView(() => cells, { maxInitialTurns: 10 });

    const first = view.render(80).join('\n');
    cells = [
      ...cells,
      createTranscriptCell({
        id: 'cell-81',
        turnId: 'turn-41',
        kind: 'final-summary',
        status: 'succeeded',
        content: 'message 81',
        createdAtMs: 81,
      }),
    ];
    const appended = view.render(80).join('\n');

    expect(first).toContain('30 earlier turns omitted');
    expect(first).toContain('message 61');
    expect(first).not.toContain('message 60');
    expect(appended).toContain('message 61');
    expect(appended).toContain('message 81');
  });

  it('folds the oldest cells inside one oversized turn while preserving its request and tail', () => {
    const cells = [
      createTranscriptCell({
        id: 'user-1',
        turnId: 'turn-1',
        kind: 'user',
        status: 'succeeded',
        content: 'Inspect the repository',
        createdAtMs: 1,
      }),
      ...Array.from({ length: 200 }, (_, index) =>
        createTranscriptCell({
          id: `tool-${index + 1}`,
          turnId: 'turn-1',
          kind: 'tool',
          status: 'succeeded',
          title: 'read',
          content: `src/file-${index + 1}.ts`,
          createdAtMs: index + 2,
        }),
      ),
      createTranscriptCell({
        id: 'assistant-final',
        turnId: 'turn-1',
        kind: 'assistant',
        status: 'succeeded',
        content: 'Final conclusion',
        createdAtMs: 202,
      }),
    ];
    const view = new TranscriptView(() => cells, { maxCellsPerTurn: 40 });

    const rendered = view.render(80).join('\n');

    expect(rendered).toContain('Inspect the repository');
    expect(rendered).toContain('earlier steps folded');
    expect(rendered).toContain('Final conclusion');
    expect(view.getPerformanceSnapshot()).toMatchObject({
      sourceUnits: 202,
      projectedCells: 41,
      foldedCells: 162,
    });
  });

  it('renders Todo progress as a compact read-only checklist', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'todo-turn-1',
        kind: 'todo',
        status: 'running',
        content: '',
        todoItems: [
          { content: 'Inspect competitors', status: 'completed' },
          { content: 'Add Todo display', status: 'in_progress' },
          { content: 'Run focused tests', status: 'pending' },
          { content: 'Discard obsolete draft', status: 'cancelled' },
        ],
        createdAtMs: 1,
      }),
    ]);

    const rendered = stripVTControlCharacters(view.render(48).join('\n'));

    expect(rendered).toContain('Todo list 1/4 · 1 cancelled');
    expect(rendered).toContain('✓ Inspect competitors');
    expect(rendered).toContain('● Add Todo display');
    expect(rendered).toContain('○ Run focused tests');
    expect(rendered).toContain('× Discard obsolete draft');
    expect(rendered).not.toContain('todowrite');
  });

  it('wraps long Todo items within a narrow terminal', () => {
    const view = new TranscriptView(() => [
      createTranscriptCell({
        id: 'todo-turn-1',
        kind: 'todo',
        status: 'running',
        content: '',
        todoItems: [
          {
            content: 'Implement a deliberately long task description that must wrap',
            status: 'in_progress',
          },
        ],
        createdAtMs: 1,
      }),
    ]);

    const lines = view.render(24);

    expect(stripVTControlCharacters(lines.join('\n'))).toContain('Todo list 0/1');
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
  });
});
