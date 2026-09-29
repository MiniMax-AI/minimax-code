import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { stripAnsi } from '../../src/tui/rendering/text.js';
import { createTuiCustomStatusCommandRunner } from '../../src/host/custom-status-command.js';
import { TuiStatusLine } from '../../src/tui/shell/chrome.js';
import { readTuiPresentationConfig } from '../../src/tui/shell/status-line-config.js';
import { parseTuiStatusLineItems } from '../../src/tui/shell/status-line-items.js';
import { resolveTuiAgentRef } from '../../src/tui/shell/status-protocol.js';
import type { TuiShellState } from '../../src/tui/shell/contracts.js';

const roots: string[] = [];

const BASE_STATE: TuiShellState = {
  version: '0.1.0',
  workspace: '/home/dev/repo',
  homeDir: '/home/dev',
  runtimeStatus: 'ready',
  sessionTitle: 'Protected status contract',
  model: 'minimax/m2',
  contextWindowTokens: 1_000_000,
  permissionMode: 'auto',
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// readTuiPresentationConfig lazily imports @mavis/config on first use. Warm
// that module here so a cold import on a loaded CI worker is charged to this
// setup hook instead of pushing the first test past its own timeout.
beforeAll(async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mcode-build-mode-contract-'));
  roots.push(dataDir);
  await readTuiPresentationConfig(dataDir);
}, 30_000);

async function readPresentationConfig(lines: readonly string[]) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mcode-build-mode-contract-'));
  roots.push(dataDir);
  await writeFile(join(dataDir, 'config.yaml'), lines.join('\n'));
  return readTuiPresentationConfig(dataDir);
}

function render(statusLineItems: readonly string[] | undefined, state = BASE_STATE): string {
  const parsedItems = statusLineItems ? parseTuiStatusLineItems(statusLineItems) : undefined;
  return new TuiStatusLine({
    ...state,
    ...(parsedItems ? { statusLineItems: parsedItems } : {}),
  })
    .render(120)
    .join('\n');
}

describe('Vela build-mode status-line contract', () => {
  it('keeps the ordinary default status line when tui.statusLine is omitted', async () => {
    const config = await readPresentationConfig(['tui:', '  showTips: false']);
    const rendered = stripAnsi(render(config.statusLineItems));

    expect(config.statusLineItems).toBeUndefined();
    expect(rendered).not.toMatch(/(?:^|\n)\s*\[V\](?:\s|$)/u);
    expect(rendered).toContain('~/repo');
    expect(rendered).toContain('m2');
    expect(rendered).toContain('Context 1M');
  });

  it('lets explicit build-mode own one ANSI-free machine line', async () => {
    const config = await readPresentationConfig([
      'tui:',
      '  statusLine:',
      '    - current-dir',
      '    - build-mode',
      '    - approval-mode',
      '    - context-window',
    ]);
    const state: TuiShellState = {
      ...BASE_STATE,
      contextWindowTokens: 1_000_000,
      agentSeq: 'z',
      agentStatus: 'perm',
      agentSessionId: 'session-123',
      agentRunId: 'turn-456',
      agentRequestId: 'permission-789',
      agentActiveCount: 2,
      agentTotalCount: 3,
      agentBackgroundCount: 1,
    };
    const rendered = render(config.statusLineItems, state);

    expect(config.statusLineItems).toEqual(['current-dir', 'build-mode', 'approval-mode', 'context-window']);
    expect(rendered).not.toContain('\u001b[');
    expect(rendered.trim()).toBe(
      `[V] seq=z state=perm session=${resolveTuiAgentRef('session-123')} ` +
        `turn=${resolveTuiAgentRef('turn-456')} request=${resolveTuiAgentRef(
          'permission-789',
        )} agents=2/3 background=1`,
    );
    expect(rendered).not.toContain('~/repo');
    expect(rendered).not.toContain('Context');
    expect(rendered).not.toMatch(/auto/iu);
  });

  it('honours an explicit empty list instead of falling back to the default', async () => {
    const config = await readPresentationConfig(['tui:', '  statusLine: []']);

    expect(config.statusLineItems).toEqual([]);
    expect(render(config.statusLineItems)).toBe('');
  });

  it.each([
    ['inline', 'above', 'plain'],
    ['inline', 'below', 'ansi'],
    ['block', 'above', 'plain'],
    ['block', 'above', 'ansi'],
    ['block', 'below', 'plain'],
    ['block', 'below', 'ansi'],
  ] as const)(
    'keeps build-mode exclusive and spawn-free with custom-command display %s at %s in %s',
    async (display, position, colorMode) => {
      const config = await readPresentationConfig([
        'tui:',
        '  statusLine:',
        '    - build-mode',
        '    - custom-command',
        '  customStatusLine:',
        '    command: cost-probe',
        `    display: ${display}`,
        `    position: ${position}`,
        `    colorMode: ${colorMode}`,
        '    maxLines: 5',
      ]);

      expect(config.statusLineItems).toEqual(['build-mode', 'custom-command']);
      expect(config.customStatusLine).toEqual({
        command: 'cost-probe',
        display,
        position,
        colorMode,
        maxLines: 5,
      });

      // Render-side exclusivity: the machine line never mixes with command output.
      const state: TuiShellState = {
        ...BASE_STATE,
        statusLineItems: parseTuiStatusLineItems(config.statusLineItems ?? []),
        agentStatus: 'ready',
        customStatusText: '\u001b[31mcustom first\ncustom second\u001b[0m',
      };
      const status = new TuiStatusLine(state, config.customStatusLine);
      const expected = render(['build-mode'], state);
      for (const height of [0, 1, 24]) {
        const rendered = status.renderViewport(120, height).join('\n');
        expect(rendered).toBe(expected);
        expect(rendered.trim()).toMatch(/^\[V\] /u);
        expect(rendered).not.toContain('\u001b');
        expect(rendered).not.toContain('custom');
      }

      // Spawn-side exclusivity: the runner factory refuses to create a runner,
      // so a build-mode TUI executes zero custom commands.
      expect(
        createTuiCustomStatusCommandRunner(parseTuiStatusLineItems(config.statusLineItems ?? []), {
          config: config.customStatusLine ?? {},
          version: '0.1.0',
          getContext: () => ({ workspaceDir: '/workspace' }),
          onText: () => {},
        }),
      ).toBeUndefined();
    },
  );
});
