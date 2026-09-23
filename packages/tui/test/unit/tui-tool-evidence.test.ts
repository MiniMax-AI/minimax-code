import { stripVTControlCharacters } from 'node:util';

import { describe, expect, it } from 'vitest';

import { renderTuiStructuredPreview } from '../../src/tui/transcript/presentation/structured-preview.js';
import { syntaxLanguageForPath } from '../../src/tui/transcript/presentation/syntax-highlight.js';
import { createTranscriptCell } from '../../src/tui/transcript/model.js';
import {
  resolveTranscriptToolDefinition,
  type TranscriptToolDefinition,
} from '../../src/tui/transcript/tool-definitions.js';
import { presentTranscriptToolEvidence } from '../../src/tui/transcript/tool-evidence.js';
import { MINIMAX_CODE_DARK_THEME, MINIMAX_CODE_LIGHT_THEME } from '../../src/tui/theme/palettes.js';
import {
  applyTuiRenderTheme,
  createTuiChalk,
  getTuiThemeSnapshot,
  tuiColors,
} from '../../src/tui/theme/runtime.js';

function definitionFor(title: string): TranscriptToolDefinition {
  const definition = resolveTranscriptToolDefinition(title);
  if (!definition) throw new Error(`Missing tool definition for ${title}`);
  return definition;
}

describe('transcript tool evidence', () => {
  it('uses the command purpose as its summary and keeps the executable source in details', () => {
    const evidence = presentTranscriptToolEvidence(createTranscriptCell({
      id: 'bash-purpose', kind: 'tool', status: 'succeeded', title: 'bash',
      content: JSON.stringify({ command: 'pnpm test', description: '验证 Bash 回归' }),
      detail: 'passed', createdAtMs: 1,
    }), definitionFor('bash'), { width: 80, prefix: '    ', displayMode: 'preview' });
    expect(evidence.summary).toContain('验证 Bash 回归');
    expect(stripVTControlCharacters(evidence.lines.join('\n'))).toContain('$ pnpm test');
  });
  it('renders a highlighted shell command separately from its quieter output', () => {
    const evidence = presentTranscriptToolEvidence(
      createTranscriptCell({
        id: 'shell',
        kind: 'tool',
        status: 'succeeded',
        title: 'bash',
        content: JSON.stringify({ command: 'if test -f package.json; then echo "ready"; fi' }),
        detail: 'package.json\nready',
        createdAtMs: 1,
      }),
      definitionFor('bash'),
      { width: 80, prefix: '    ', displayMode: 'preview' },
    );

    const plain = stripVTControlCharacters(evidence.lines.join('\n'));
    expect(evidence.summary).toBe('if test -f package.json; then echo "ready"; fi · 2 output lines');
    expect(plain).toContain('$ if test -f package.json; then echo "ready"; fi');
    expect(plain).toContain('│ package.json');
    expect(plain).toContain('│ ready');
    expect(syntaxLanguageForPath('script.sh')).toBe('bash');
  });

  it('uses executable-focused shell highlighting in expanded transcript evidence', () => {
    const original = getTuiThemeSnapshot();
    const originalPalette =
      original.appearance === 'light' ? MINIMAX_CODE_LIGHT_THEME : MINIMAX_CODE_DARK_THEME;
    applyTuiRenderTheme(MINIMAX_CODE_DARK_THEME, 3);

    try {
      const evidence = presentTranscriptToolEvidence(
        createTranscriptCell({
          id: 'shell-executable-highlights',
          kind: 'tool',
          status: 'succeeded',
          title: 'bash',
          content: JSON.stringify({ command: 'cp source target && rm target | mv backup restored' }),
          detail: undefined,
          createdAtMs: 1,
        }),
        definitionFor('bash'),
        { width: 80, prefix: '    ', displayMode: 'expanded' },
      );
      const rendered = evidence.lines.join('\n');
      const ansi = createTuiChalk({ colorLevel: 3 });

      expect(rendered).toContain(ansi.bold.hex(tuiColors.accent)('cp'));
      expect(rendered).toContain(ansi.bold.hex(tuiColors.accent)('rm'));
      expect(rendered).toContain(ansi.bold.hex(tuiColors.accent)('mv'));
    } finally {
      applyTuiRenderTheme(originalPalette, original.colorLevel);
    }
  });

  it('keeps only the first line of a multiline shell command in the summary', () => {
    const evidence = presentTranscriptToolEvidence(
      createTranscriptCell({
        id: 'shell-multiline',
        kind: 'tool',
        status: 'succeeded',
        title: 'bash',
        content: JSON.stringify({ command: "git commit -F - <<'EOF'\nsubject line\nEOF" }),
        detail: undefined,
        createdAtMs: 1,
      }),
      definitionFor('bash'),
      { width: 80, prefix: '    ', displayMode: 'collapsed' },
    );

    expect(evidence.summary).toBe("git commit -F - <<'EOF'… · no output");
    expect(evidence.summary).not.toContain('subject line');
  });

  it('syntax-highlights Read output from the requested file type with a stable line gutter', () => {
    const evidence = presentTranscriptToolEvidence(
      createTranscriptCell({
        id: 'read',
        kind: 'tool',
        status: 'succeeded',
        title: 'read',
        content: JSON.stringify({ path: 'src/server.ts', offset: 12 }),
        detail: 'const port = 3000;\nexport { port };',
        createdAtMs: 1,
      }),
      definitionFor('read'),
      { width: 80, prefix: '    ', displayMode: 'preview' },
    );

    const plain = stripVTControlCharacters(evidence.lines.join('\n'));
    expect(evidence.summary).toBe('src/server.ts · 2 lines');
    expect(plain).toContain('12 │ const port = 3000;');
    expect(plain).toContain('13 │ export { port };');
    expect(syntaxLanguageForPath('src/server.ts')).toBe('typescript');
  });

  it('keeps the newest shell output while running and head plus tail after completion', () => {
    const output = Array.from({ length: 8 }, (_, index) => `line-${index + 1}`).join('\n');
    const running = presentTranscriptToolEvidence(
      createTranscriptCell({
        id: 'running',
        kind: 'tool',
        status: 'running',
        title: 'bash',
        content: JSON.stringify({ command: 'pnpm test' }),
        detail: output,
        createdAtMs: 1,
      }),
      definitionFor('bash'),
      { width: 80, prefix: '    ', displayMode: 'preview' },
    );
    const completed = presentTranscriptToolEvidence(
      createTranscriptCell({
        id: 'completed',
        kind: 'tool',
        status: 'succeeded',
        title: 'bash',
        content: JSON.stringify({ command: 'pnpm test' }),
        detail: output,
        createdAtMs: 1,
      }),
      definitionFor('bash'),
      { width: 80, prefix: '    ', displayMode: 'preview' },
    );

    const runningPlain = stripVTControlCharacters(running.lines.join('\n'));
    expect(runningPlain).not.toContain('line-1');
    expect(runningPlain).toContain('line-8');
    expect(runningPlain).toContain('5 earlier lines');

    const completedPlain = stripVTControlCharacters(completed.lines.join('\n'));
    expect(completedPlain).toContain('line-1');
    expect(completedPlain).toContain('line-8');
    expect(completedPlain).toContain('5 lines hidden');
  });

  it('summarizes search results and shows a small path sample', () => {
    const evidence = presentTranscriptToolEvidence(
      createTranscriptCell({
        id: 'grep',
        kind: 'tool',
        status: 'succeeded',
        title: 'grep',
        content: JSON.stringify({ pattern: 'renderTool', path: 'packages/tui' }),
        detail: [
          'packages/tui/src/a.ts:12:renderTool()',
          'packages/tui/src/b.ts:4:renderTool()',
          'packages/tui/src/c.ts:9:renderTool()',
          'packages/tui/src/d.ts:2:renderTool()',
        ].join('\n'),
        createdAtMs: 1,
      }),
      definitionFor('grep'),
      { width: 80, prefix: '    ', displayMode: 'preview' },
    );

    const plain = stripVTControlCharacters(evidence.lines.join('\n'));
    expect(evidence.summary).toBe('renderTool · 4 matches');
    expect(plain).toContain('packages/tui/src/a.ts:12');
    expect(plain).toContain('1 more match');
    expect(plain).not.toContain('packages/tui/src/d.ts:2');
  });

  it('keeps failed Read output as an error instead of pretending it is source code', () => {
    const evidence = presentTranscriptToolEvidence(
      createTranscriptCell({
        id: 'read-failed',
        kind: 'tool',
        status: 'failed',
        title: 'read',
        content: JSON.stringify({ path: 'src/missing.ts' }),
        detail: 'ENOENT: file not found',
        createdAtMs: 1,
      }),
      definitionFor('read'),
      { width: 80, prefix: '    ', displayMode: 'preview' },
    );

    const plain = stripVTControlCharacters(evidence.lines.join('\n'));
    expect(evidence.summary).toBe('src/missing.ts');
    expect(plain).toContain('× ENOENT: file not found');
    expect(plain).not.toContain('1 │');
  });

  it('pretty-prints structured fallback results without dumping one-line JSON', () => {
    const evidence = presentTranscriptToolEvidence(
      createTranscriptCell({
        id: 'mcp',
        kind: 'tool',
        status: 'succeeded',
        title: 'mcp__repo__inspect',
        content: JSON.stringify({ path: 'src' }),
        detail: JSON.stringify({ files: 12, status: 'ready' }),
        createdAtMs: 1,
      }),
      definitionFor('mcp__repo__inspect'),
      { width: 80, prefix: '    ', displayMode: 'expanded' },
    );

    const plain = stripVTControlCharacters(evidence.lines.join('\n'));
    expect(plain).toContain('│ {');
    expect(plain).toContain('"files": 12');
    expect(plain).toContain('"status": "ready"');
    expect(plain).not.toContain('{"files":12');
  });

  it('syntax-highlights file structured previews instead of painting the body uniformly', () => {
    const rendered = renderTuiStructuredPreview(
      {
        schemaVersion: 1,
        state: 'applied',
        blocks: [
          {
            kind: 'file',
            path: 'src/config.ts',
            content: 'export const enabled = true;',
            lineCount: 1,
            truncated: false,
          },
        ],
      },
      80,
      { maxBodyLines: 3 },
    ).join('\n');

    expect(stripVTControlCharacters(rendered)).toContain('1 export const enabled = true;');
    expect(syntaxLanguageForPath('src/config.ts')).toBe('typescript');
  });
});
