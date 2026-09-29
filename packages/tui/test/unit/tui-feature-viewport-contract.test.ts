import { describe, expect, it, vi } from 'vitest';
import type { TuiSessionInputSummary } from '../../src/runtime/port.js';
import { TuiAgentTeamPanel } from '../../src/tui/agent-team/panel.js';
import type { TuiAgentTeamSnapshot } from '../../src/tui/agent-team/model.js';
import { TuiBackgroundWorkPanel } from '../../src/tui/background-work/panel.js';
import { TuiSessionMutationForkConfirmation } from '../../src/tui/controller/product/session-mutation-flow.js';
import { TuiAltScreen } from '../../src/tui/engine/tui-alt-screen.js';
import { TuiMainScreen } from '../../src/tui/engine/tui-main-screen.js';
import { TuiPluginManager } from '../../src/tui/features/plugin/manager.js';
import { TuiSessionHistoryExplorer } from '../../src/tui/features/session-mutation/history-explorer.js';
import { TuiSessionMutationHistoryPicker } from '../../src/tui/features/session-mutation/history-picker.js';
import { TuiSessionMutationRewindPreviewPanel } from '../../src/tui/features/session-mutation/rewind-preview-panel.js';
import { TuiSessionMutationScopePicker } from '../../src/tui/features/session-mutation/scope-picker.js';
import { TuiTranscriptPanel } from '../../src/tui/features/transcript/panel.js';
import { TuiOverlayRegularFeaturePresenter } from '../../src/tui/shell/regular-feature-presenter.js';
import { TuiSurfaceHost, type TuiFeatureScreen } from '../../src/tui/shell/surface-host.js';
import { createTranscriptCell } from '../../src/tui/transcript/model.js';
import { TranscriptStore } from '../../src/tui/transcript/store.js';
import { VirtualTerminal } from '../pi-084-upstream/virtual-terminal.js';

type Factory = (count: number, onCancel: () => void, requestRender: () => void) => TuiFeatureScreen;
const summaries = (count: number): TuiSessionInputSummary[] =>
  Array.from({ length: count }, (_, index) => ({
    userMessageId: `input-${index}`,
    contentHead: `Prompt ${index}`,
    timestamp: index + 1,
    fileChangeCount: 0,
  }));
const team = (count: number): TuiAgentTeamSnapshot => ({
  rootSessionId: 'root',
  capturedAtMs: 1,
  summary: { total: count, running: count, waiting: 0, queued: 0, done: 0, failed: 0, stopped: 0 },
  members: Array.from({ length: count }, (_, index) => ({
    sessionId: `agent-${index}`,
    parentSessionId: 'root',
    agentName: `Agent ${index}`,
    task: 'Inspect rendering',
    status: 'running',
    phase: 'tool',
    activity: 'Reading',
    toolCount: 1,
    startedAtMs: 1,
    updatedAtMs: 1,
  })),
});
const factories: Record<string, Factory> = {
  tasks: (count, onCancel, requestRender) =>
    new TuiBackgroundWorkPanel({
      agentTeam: () => team(count),
      backgroundTasks: () => [],
      activeSessionId: () => 'root',
      onOpenAgent: vi.fn(),
      onCancel,
      requestRender,
    }),
  agents: (count, onCancel, requestRender) =>
    new TuiAgentTeamPanel({
      snapshot: () => team(count),
      activeSessionId: () => 'root',
      onSelect: vi.fn(),
      onCancel,
      requestRender,
    }),
  plugins: (count, onCancel, requestRender) => {
    const plugins = Array.from({ length: count }, (_, index) => ({
      pluginId: `plugin-${index}`,
      name: `Plugin ${index}`,
      displayName: `Plugin ${index}`,
      marketplace: 'official' as const,
      installed: false,
      enabled: false,
      capabilities: { appCount: 0, mcpServerCount: 0, skillCount: 1 },
    }));
    return new TuiPluginManager({
      plugins,
      onInstall: async (plugin) => plugin,
      onRemove: async (plugin) => plugin,
      onSetEnabled: async (plugin) => plugin,
      onRefresh: async () => plugins,
      onCancel,
      requestRender,
    });
  },
  transcript: (count, onCancel, requestRender) =>
    new TuiTranscriptPanel({
      source: new TranscriptStore(
        Array.from({ length: count }, (_, index) =>
          createTranscriptCell({
            id: `cell-${index}`,
            turnId: `turn-${index}`,
            kind: 'user',
            status: 'succeeded',
            content: `Inspect message ${index}`,
            createdAtMs: index + 1,
          }),
        ),
      ),
      onCancel,
      requestRender,
    }),
  history: (count, onCancel, requestRender) =>
    new TuiSessionHistoryExplorer({
      summaries: summaries(count),
      mutationAvailable: true,
      onAction: vi.fn(),
      onCancel,
      requestRender,
    }),
  'history-picker': (count, onCancel, requestRender) =>
    new TuiSessionMutationHistoryPicker({
      summaries: summaries(count),
      mode: 'rewind',
      onSelect: vi.fn(),
      onCancel,
      requestRender,
    }),
  'rewind-preview': (count, onCancel, requestRender) =>
    new TuiSessionMutationRewindPreviewPanel({
      preview: {
        turns: [
          {
            turnId: 'turn',
            files: Array.from({ length: count }, (_, index) => ({
              filePath: `src/file-${index}.ts`,
              action: 'modified' as const,
              skipped: false,
            })),
          },
        ],
      },
      onContinue: vi.fn(),
      onCancel,
      requestRender,
    }),
  'rewind-scope': (_count, onCancel, requestRender) =>
    new TuiSessionMutationScopePicker({
      onSelect: vi.fn(),
      onCancel,
      requestRender,
    }),
  'fork-confirmation': (_count, onCancel, requestRender) =>
    new TuiSessionMutationForkConfirmation({
      summary: summaries(1)[0]!,
      options: { canFork: true, worktreeEligible: false, worktreeVisible: false },
      onConfirm: vi.fn(),
      onCancel,
      requestRender,
    }),
};

describe.each(Object.entries(factories))('%s regular viewport lifecycle', (_name, factory) => {
  it.each([
    ...[0, 1, 30].flatMap((count) => [8, 24, 50].map((rows) => ({ count, rows, chatCount: 80 }))),
    ...[0, 4].map((chatCount) => ({ count: 1, rows: 24, chatCount })),
  ])(
    'isolates $count entries over $chatCount chat rows at $rows rows through updates, resize, nesting and return',
    async ({ count, rows, chatCount }) => {
      const terminal = new VirtualTerminal(80, rows);
      const tui = new TuiMainScreen(terminal);
      const messages = Array.from({ length: chatCount }, (_, index) => `BACKGROUND-${index}`);
      const chat = () => [...messages, 'COMPOSER', 'STATUS'];
      const chatComponent = { render: chat, invalidate() {} };
      const host = new TuiSurfaceHost({
        chat: { component: chatComponent, focus: chatComponent },
        chatMode: 'regular',
        viewportRows: () => terminal.rows,
        regularFeaturePresenter: new TuiOverlayRegularFeaturePresenter(terminal, tui, () =>
          tui.requestRender(),
        ),
        setFocus: (focus) => tui.setFocus(focus),
        requestRender: () => tui.requestRender(),
      });
      tui.addChild(host);
      const assertCovered = async () => {
        tui.renderNow();
        await terminal.flush();
        const viewport = terminal.getViewport().join('\n');
        expect(viewport.trim()).not.toBe('');
        expect(viewport).not.toMatch(/BACKGROUND-|COMPOSER|STATUS/);
      };
      tui.start();
      try {
        await terminal.waitForRender();
        const handle = host.pushFeature({
          screen: factory(
            count,
            () => handle.close(),
            () => tui.requestRender(),
          ),
        });
        await assertCovered();
        messages.push('BACKGROUND-live');
        await assertCovered();
        messages.splice(-12);
        await assertCovered();
        for (const key of ['\x1b[B', '\x1b[6~', '\x1b[5~']) {
          terminal.sendInput(key);
          await assertCovered();
        }
        terminal.resize(40, rows === 8 ? 24 : 8);
        await assertCovered();
        terminal.resize(80, rows);
        await assertCovered();
        const nestedFactory =
          _name === 'rewind-preview' ? factories['rewind-scope']! : factories['rewind-preview']!;
        const nested = host.pushFeature({
          screen: nestedFactory(
            0,
            () => nested.close(),
            () => tui.requestRender(),
          ),
        });
        await assertCovered();
        terminal.sendInput('\x1b');
        await assertCovered();
        expect(handle.isActive()).toBe(true);
        // Some panels first clear a search/filter on Esc; close their surface handle here.
        handle.close();
        tui.renderNow();
        await vi.waitFor(async () => {
          await terminal.flush();
          const expected = [...chat(), ...Array(Math.max(0, rows - chat().length)).fill('')];
          expect(terminal.getViewport()).toEqual(expected.slice(-rows));
          expect(terminal.getScrollBuffer()).toEqual(expected);
        });
      } finally {
        host.dispose();
        tui.stop();
      }
    },
  );
});

describe.each(Object.entries(factories))('%s fullscreen viewport lifecycle', (_name, factory) => {
  it.each([
    { rows: 8, count: 0 },
    { rows: 24, count: 1 },
    { rows: 50, count: 30 },
  ])(
    'isolates $count entries at $rows rows and restores the chat layout',
    async ({ rows, count }) => {
      const terminal = new VirtualTerminal(80, rows);
      const tui = new TuiAltScreen(terminal);
      const component = {
        render: () => ['BACKGROUND-chat', 'COMPOSER', 'STATUS'],
        invalidate() {},
      };
      const host = new TuiSurfaceHost({
        chat: { component, focus: component },
        chatMode: 'fullscreen',
        viewportRows: () => terminal.rows,
        regularFeaturePresenter: new TuiOverlayRegularFeaturePresenter(terminal, tui, () =>
          tui.requestRender(),
        ),
        setFocus: (focus) => tui.setFocus(focus),
        requestRender: () => tui.requestRender(),
      });
      tui.setLayoutRoot(host);
      tui.start();
      try {
        await terminal.waitForRender();
        const original = terminal.getViewport();
        const handle = host.pushFeature({
          screen: factory(
            count,
            () => handle.close(),
            () => tui.requestRender(),
          ),
        });
        for (const width of [80, 24, 80]) {
          terminal.resize(width, rows);
          terminal.sendInput('\x1b[B');
          terminal.sendInput('\x1b[6~');
          tui.renderNow();
          await terminal.flush();
          expect(terminal.getViewport().join('\n').trim()).not.toBe('');
          expect(terminal.getViewport().join('\n')).not.toMatch(/BACKGROUND-|COMPOSER|STATUS/);
        }
        handle.close();
        tui.renderNow();
        await terminal.flush();
        expect(terminal.getViewport()).toEqual(original);
      } finally {
        host.dispose();
        tui.stop();
      }
    },
  );
});
