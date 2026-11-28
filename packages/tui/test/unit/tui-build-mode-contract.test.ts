import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { stripAnsi } from '../../src/tui/rendering/text.js';
import { TuiAutomationStatusStore } from '../../src/tui/automation/status-store.js';
import type { TuiChatSnapshot } from '../../src/tui/controller/chat-controller.js';
import { createTuiCustomStatusCommandRunner } from '../../src/host/custom-status-command.js';
import { TuiStatusLine } from '../../src/tui/shell/chrome.js';
import { readTuiPresentationConfig } from '../../src/tui/shell/status-line-config.js';
import { parseTuiStatusLineItems } from '../../src/tui/shell/status-line-items.js';
import { resolveTuiAgentRef } from '../../src/tui/shell/status-protocol.js';
import type { TuiShellState } from '../../src/tui/shell/contracts.js';

const roots: string[] = [];

/** `waiting=` 是 opt-in 字段：只有显式打开时才出现在机器状态行里。 */
function withWaitingField<T>(run: () => T): T {
  const previous = process.env.MCODE_TUI_STATUS_WAITING_FIELD;
  process.env.MCODE_TUI_STATUS_WAITING_FIELD = '1';
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.MCODE_TUI_STATUS_WAITING_FIELD;
    else process.env.MCODE_TUI_STATUS_WAITING_FIELD = previous;
  }
}


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

// The published contract needs at least 190 columns for a full `[V]` line, so this
// helper renders wide enough that a complete record is never truncated into an
// ellipsis; the truncation behaviour itself is covered by the shell frame tests.
const CONTRACT_WIDTH = 200;

function render(statusLineItems: readonly string[] | undefined, state = BASE_STATE): string {
  const parsedItems = statusLineItems ? parseTuiStatusLineItems(statusLineItems) : undefined;
  return new TuiStatusLine({
    ...state,
    ...(parsedItems ? { statusLineItems: parsedItems } : {}),
  })
    .render(CONTRACT_WIDTH)
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
      '    - context-meter',
    ]);
    const state: TuiShellState = {
      ...BASE_STATE,
      contextWindowTokens: 1_000_000,
      agentSeq: 'z',
      agentStatus: 'perm',
      agentSessionId: 'mvs_41a0f678864f45118a737a176fd94daa',
      agentRunId: 'turn-456',
      agentRequestId: 'permission-789',
      agentActiveCount: 2,
      agentTotalCount: 3,
      agentWaitingCount: 1,
      agentBackgroundCount: 1,
    };
    const rendered = withWaitingField(() => render(config.statusLineItems, state));

    expect(config.statusLineItems).toEqual(['current-dir', 'build-mode', 'approval-mode', 'context-window', 'context-meter']);
    expect(rendered).not.toContain('\u001b[');
    expect(rendered.trim()).toBe(
      `[V] seq=z state=perm session=mvs_41a0f678864f45118a737a176fd94daa ` +
        `turn=turn-456 request=${resolveTuiAgentRef('permission-789')} agents=2/3 waiting=1 background=1`,
    );
    expect(rendered).not.toContain('~/repo');
    expect(rendered).not.toContain('Context');
    expect(rendered).not.toMatch(/auto/iu);
  });

  it('omits the waiting field by default so the deployed poller contract still matches', async () => {
    const config = await readPresentationConfig([
      'tui:',
      '  statusLine:',
      '    - build-mode',
    ]);
    const state: TuiShellState = {
      ...BASE_STATE,
      agentSeq: 'z',
      agentStatus: 'perm',
      agentSessionId: 'mvs_41a0f678864f45118a737a176fd94daa',
      agentRunId: 'turn-456',
      agentRequestId: 'permission-789',
      agentActiveCount: 2,
      agentTotalCount: 3,
      agentWaitingCount: 1,
      agentBackgroundCount: 1,
    };

    const rendered = render(config.statusLineItems, state);

    expect(rendered.trim()).toBe(
      `[V] seq=z state=perm session=mvs_41a0f678864f45118a737a176fd94daa ` +
        `turn=turn-456 request=${resolveTuiAgentRef('permission-789')} agents=2/3 background=1`,
    );
    expect(rendered).not.toContain('waiting=');
  });

  it('publishes turn only as a raw Runtime id or none', () => {
    let nowMs = 0;
    const store = new TuiAutomationStatusStore({
      delegatedHold: true,
      now: () => nowMs,
      log: () => undefined,
    });
    const session = { sessionId: 'mvs_41a0f678864f45118a737a176fd94daa' } as TuiChatSnapshot['session'];
    const line = (snapshot: Omit<TuiChatSnapshot, 'sessions' | 'session'>, currentLiveRunId?: string) => {
      const status = store.reconcile({
        snapshot: { sessions: [], session, ...snapshot },
        connection: { phase: 'live' },
        ...(currentLiveRunId ? { currentLiveRunId } : {}),
        runtimeQueuedCount: 0,
        runtimeQueueHandoffPending: false,
        compacting: false,
        retrying: false,
      });
      return stripAnsi(
        render(['build-mode'], {
          ...BASE_STATE,
          agentSeq: status.seq,
          agentStatus: status.status,
          ...(status.sessionId ? { agentSessionId: status.sessionId } : {}),
          ...(status.turnId ? { agentRunId: status.turnId } : {}),
          agentActiveCount: status.activeAgents,
          agentTotalCount: status.totalAgents,
          agentBackgroundCount: status.backgroundTasks,
        }),
      ).trim();
    };
    const runtimeTurn = 'turn_550e8400-e29b-41d4-a716-446655440000';
    const tuiTurn = 'turn_mvi6ub2p_k9l13a';

    // Submitted, then sent to the Queue after a busy rejection: no Runtime turn yet.
    const submitted = line({ status: 'running', activeTurnId: tuiTurn, unadmittedTurnId: tuiTurn }, tuiTurn);
    const queued = line({ status: 'idle', unadmittedTurnId: tuiTurn });
    const dispatched = line({ status: 'idle', unadmittedTurnId: tuiTurn }, runtimeTurn);

    expect(submitted).toMatch(/^\[V\] seq=0 state=run session=mvs_\S+ turn=none request=none /u);
    expect(queued).toBe(submitted);
    expect(dispatched).toMatch(new RegExp(`^\\[V\\] seq=1 state=run session=mvs_\\S+ turn=${runtimeTurn} `, 'u'));
    for (const record of [submitted, queued, dispatched]) expect(record).not.toContain(tuiTurn);
    // Lost settlement is a protocol error, not a Turn result with no JSONL record.
    line({ status: 'idle' });
    nowMs += 1_800_000;
    expect(line({ status: 'idle' })).toMatch(/state=error session=\S+ turn=none request=none /u);
    expect(line({ status: 'running', activeTurnId: 'runtime-next' })).toContain('state=run');

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
        const rendered = status.renderViewport(CONTRACT_WIDTH, height).join('\n');
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
