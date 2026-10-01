import { describe, expect, it, vi } from 'vitest';
import { TuiMainScreen } from '../../src/tui/engine/tui-main-screen.js';
import { TuiOverlayRegularFeaturePresenter } from '../../src/tui/shell/regular-feature-presenter.js';
import { VirtualTerminal } from '../pi-084-upstream/virtual-terminal.js';

import { TuiSessionMutationHistoryPicker } from '../../src/tui/features/session-mutation/history-picker.js';
import { TuiSessionMutationRewindPreviewPanel } from '../../src/tui/features/session-mutation/rewind-preview-panel.js';
import { TuiSessionMutationScopePicker } from '../../src/tui/features/session-mutation/scope-picker.js';
import {
  formatPromptHead,
  formatRelativeTimestamp,
  formatSessionInputSummaryLabel,
} from '../../src/tui/features/session-mutation/format.js';
import {
  sessionHistoryText,
  sessionMutationTemplate,
  sessionMutationText,
} from '../../src/tui/features/session-mutation/copy.js';
import { stripAnsi } from '../../src/tui/rendering/text.js';
import type {
  TuiRewindPreview,
  TuiSessionInputSummary,
  TuiRewindScope,
} from '../../src/runtime/port.js';

const NOW_MS = 1_700_000_000_000;

function makeSummary(overrides: Partial<TuiSessionInputSummary> = {}): TuiSessionInputSummary {
  return {
    userMessageId: 'msg-user-1',
    assistantMessageId: 'msg-assistant-1',
    contentHead: 'Investigate flaky login tests and capture the failure trace',
    timestamp: NOW_MS - 5 * 60_000,
    fileChangeCount: 2,
    ...overrides,
  };
}

describe('formatSessionInputSummaryLabel', () => {
  it('formats a concise label with assistant-boundary, files, and relative time', () => {
    const label = formatSessionInputSummaryLabel(
      {
        userMessageId: 'msg-user-1',
        assistantMessageId: 'msg-assistant-1',
        contentHead: 'Investigate flaky login tests and capture the failure trace',
        timestamp: NOW_MS - 5 * 60_000,
        fileChangeCount: 2,
      },
      { nowMs: NOW_MS },
    );

    expect(label.title).toContain('Investigate flaky login tests');
    expect(label.title).toMatch(/\u2026$/u);
    expect(label.subtitle).toMatch(/2 files/u);
    expect(label.subtitle).toMatch(/5m/u);
    expect(label.subtitle).toMatch(/assistant replied/u);
  });

  it('omits the assistant marker when no assistant message exists', () => {
    const label = formatSessionInputSummaryLabel(
      makeSummary({ assistantMessageId: undefined, fileChangeCount: 0 }),
      { nowMs: NOW_MS },
    );
    expect(label.subtitle).not.toMatch(/assistant/u);
    expect(label.subtitle).toMatch(/0 files/u);
  });

  it('uses Chinese Session history copy and formatting for a Chinese locale', () => {
    const label = formatSessionInputSummaryLabel(makeSummary(), {
      nowMs: NOW_MS,
      locale: 'zh-CN',
    });

    expect(label.subtitle).toContain('2 个文件');
    expect(label.subtitle).toContain('助手已回复');
    expect(formatRelativeTimestamp(0, NOW_MS, 'zh-CN')).toBe('未知时间');
    expect(sessionHistoryText('actions', 'zh_CN')).toBe('选择历史操作');
    expect(sessionMutationText('sessionMutation.confirm.rewind.title', 'zh-Hans')).toBe(
      '确认回退',
    );
    expect(
      sessionMutationTemplate(
        'sessionMutation.confirm.fileCounts',
        { ready: 2, skipped: 1 },
        'zh-CN',
      ),
    ).toBe('2 可回退 · 1 已跳过');
  });
});

describe('TuiSessionMutationHistoryPicker', () => {
  it('renders the picker header and lists every summary newest-first with full id retained', () => {
    const older = makeSummary({
      userMessageId: 'msg-user-older',
      contentHead: 'Older prompt body',
      timestamp: NOW_MS - 30 * 60_000,
      fileChangeCount: 1,
    });
    const middle = makeSummary({
      userMessageId: 'msg-user-middle',
      contentHead: 'Middle prompt body',
      timestamp: NOW_MS - 10 * 60_000,
      fileChangeCount: 0,
    });
    const latest = makeSummary({
      userMessageId: 'msg-user-latest',
      contentHead: 'Latest prompt body',
      timestamp: NOW_MS - 1 * 60_000,
      fileChangeCount: 3,
    });
    const onSelect = vi.fn();
    const picker = new TuiSessionMutationHistoryPicker({
      summaries: [older, middle, latest],
      mode: 'rewind',
      onSelect,
      onCancel: vi.fn(),
      nowMs: NOW_MS,
    });

    const rendered = stripAnsi(picker.render(80).join('\n'));

    expect(rendered).toMatch(/Rewind to a previous message/);
    expect(rendered).toContain('Latest prompt body');
    expect(rendered).toContain('Middle prompt body');
    expect(rendered).toContain('Older prompt body');
    expect(rendered).toMatch(/1m/);
    expect(rendered).toMatch(/3 files/);
    expect(rendered.indexOf('Latest prompt body')).toBeLessThan(
      rendered.indexOf('Middle prompt body'),
    );
    expect(rendered.indexOf('Middle prompt body')).toBeLessThan(
      rendered.indexOf('Older prompt body'),
    );
    expect(rendered).toMatch(/1 turn affected/);
    expect(rendered).toMatch(/2 turns affected/);
    expect(rendered).toMatch(/3 turns affected/);

    // Selection defaults to the latest summary.
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(latest);
  });

  it('does not offer incomplete inputs without an assistant boundary', () => {
    const complete = makeSummary({ userMessageId: 'msg-user-complete' });
    const incomplete = makeSummary({
      userMessageId: 'msg-user-incomplete',
      assistantMessageId: undefined,
      contentHead: 'Still running',
    });
    const onSelect = vi.fn();
    const picker = new TuiSessionMutationHistoryPicker({
      summaries: [complete, incomplete],
      mode: 'fork',
      onSelect,
      onCancel: vi.fn(),
      nowMs: NOW_MS,
    });

    const rendered = stripAnsi(picker.render(100).join('\n'));
    expect(rendered).toContain('Investigate flaky login tests');
    expect(rendered).not.toContain('Still running');
    expect(rendered).toMatch(/1 incomplete message hidden/);

    picker.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith(complete);
  });

  it('truncates the displayed prompt head but keeps the full summary object on select', () => {
    const longHead = 'word '.repeat(80).trim();
    const summary = makeSummary({
      userMessageId: 'msg-user-long',
      contentHead: longHead,
      fileChangeCount: 0,
    });
    const onSelect = vi.fn();
    const picker = new TuiSessionMutationHistoryPicker({
      summaries: [summary],
      mode: 'fork',
      onSelect,
      onCancel: vi.fn(),
    });

    const rendered = stripAnsi(picker.render(60).join('\n'));
    expect(rendered).toContain('Fork from a previous message');
    // Rendered line should not contain the full long head; it should be truncated with ellipsis.
    expect(rendered).not.toContain(longHead);
    expect(rendered).toMatch(/\u2026/);

    picker.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith(summary);
  });

  it('does not split an emoji at the prompt-head boundary', () => {
    const head = `${'a'.repeat(46)}😀z`;

    expect(formatPromptHead(head, 48)).toBe(head);
    expect(formatPromptHead(`${head}tail`, 48)).not.toContain('\uFFFD');
  });

  it('renders a safe empty state when there are no summaries', () => {
    const onSelect = vi.fn();
    const picker = new TuiSessionMutationHistoryPicker({
      summaries: [],
      mode: 'rewind',
      onSelect,
      onCancel: vi.fn(),
    });

    const rendered = stripAnsi(picker.render(80).join('\n'));
    expect(rendered).toMatch(/No previous user messages/i);
    expect(rendered).toMatch(/Esc cancel/);
    // No summaries means there is nothing to select, so onSelect must not fire.
    picker.handleInput('\r');
    picker.handleInput('\u001b');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('routes Escape to onCancel exactly once and never invokes the mutation callback', () => {
    const summary = makeSummary();
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const picker = new TuiSessionMutationHistoryPicker({
      summaries: [summary],
      mode: 'rewind',
      onSelect,
      onCancel,
    });

    picker.handleInput('\u001b');
    picker.handleInput('\u001b');

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('exposes a stable surface id and pads renderViewport to the requested height', () => {
    const summary = makeSummary();
    const picker = new TuiSessionMutationHistoryPicker({
      summaries: [summary],
      mode: 'fork',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    expect(picker.id).toBe('session-mutation:history');

    const padded = picker.renderViewport(80, 24);
    expect(padded.length).toBe(24);
    expect(padded.some((line) => line.length > 0)).toBe(true);

    const clipped = picker.renderViewport(80, 4);
    expect(clipped.length).toBe(4);
    expect(clipped.length).toBeLessThanOrEqual(picker.render(80).length);
  });

  it('returns an empty viewport for zero width without crashing', () => {
    const picker = new TuiSessionMutationHistoryPicker({
      summaries: [makeSummary()],
      mode: 'fork',
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    expect(picker.renderViewport(0, 10)).toEqual([]);
  });
});

describe('TuiSessionMutationRewindPreviewPanel', () => {
  it.each([8, 24, 50])(
    'owns the complete regular viewport at %i rows and restores chat on cancel',
    async (rows) => {
      const terminal = new VirtualTerminal(80, rows);
      const tui = new TuiMainScreen(terminal);
      const messages = Array.from({ length: 80 }, (_, index) => `chat-marker-${index}`);
      const chat = () => [...messages, 'COMPOSER', 'STATUS'];
      tui.addChild({ render: chat, invalidate() {} });
      let close: () => void = () => undefined;
      const panel = new TuiSessionMutationRewindPreviewPanel({
        preview: { turns: [] },
        target: 'Target /example-skill',
        impact: '1 turn affected · 0 files',
        onCancel: () => close(),
        onContinue: vi.fn(),
        requestRender: () => tui.requestRender(),
      });
      tui.start();
      try {
        await terminal.waitForRender();
        const presenter = new TuiOverlayRegularFeaturePresenter(terminal, tui, () =>
          tui.requestRender(),
        );
        const handle = presenter.show(panel, panel);
        close = () => handle.close();
        tui.setFocus(handle.focus);
        for (let update = 0; update < 3; update++) {
          tui.renderNow();
          await terminal.flush();
          const viewport = terminal.getViewport().join('\n');
          expect(viewport).toContain('Rewind preview');
          expect(viewport).not.toContain('chat-marker-');
          expect(viewport).not.toContain('COMPOSER');
          expect(viewport).not.toContain('STATUS');
          if (update < 2) messages.push(`chat-marker-live-${update}`);
        }
        terminal.sendInput('\u001B');
        tui.renderNow();
        await terminal.flush();
        expect(terminal.getViewport()).toEqual(chat().slice(-rows));
        expect(terminal.getScrollBuffer()).toEqual(chat());
      } finally {
        tui.stop();
      }
    },
  );

  it('groups ready vs skipped files and shows modified/created/deleted actions', () => {
    const preview: TuiRewindPreview = {
      turns: [
        {
          turnId: 'turn-1',
          files: [
            { filePath: 'src/a.ts', action: 'modified', skipped: false },
            { filePath: 'src/b.ts', action: 'created', skipped: false },
            { filePath: 'src/c.ts', action: 'deleted', skipped: false },
            { filePath: 'src/skipped.ts', action: 'modified', skipped: true },
          ],
        },
      ],
    };
    const onCancel = vi.fn();
    const panel = new TuiSessionMutationRewindPreviewPanel({
      preview,
      onCancel,
    });

    const rendered = stripAnsi(panel.render(80).join('\n'));

    expect(rendered).toMatch(/Rewind preview/);
    expect(rendered).toMatch(/Ready to rewind/);
    expect(rendered).toMatch(/Skipped/);
    expect(rendered).toContain('src/a.ts');
    expect(rendered).toContain('src/b.ts');
    expect(rendered).toContain('src/c.ts');
    expect(rendered).toContain('src/skipped.ts');
    expect(rendered).toMatch(/modified/);
    expect(rendered).toMatch(/created/);
    expect(rendered).toMatch(/deleted/);
    expect(rendered).toMatch(/skipped/);
  });

  it('renders a no-diff message when no ready files remain', () => {
    const preview: TuiRewindPreview = {
      turns: [
        {
          turnId: 'turn-1',
          files: [{ filePath: 'src/already-clean.ts', action: 'modified', skipped: true }],
        },
      ],
    };
    const onCancel = vi.fn();
    const panel = new TuiSessionMutationRewindPreviewPanel({ preview, onCancel });

    const rendered = stripAnsi(panel.render(80).join('\n'));
    expect(rendered).toMatch(/no[- ]?diff/i);
  });

  it('treats repeated Escape presses as a single idempotent close', () => {
    const panel = new TuiSessionMutationRewindPreviewPanel({
      preview: { turns: [] },
      onCancel: vi.fn(),
    });

    panel.handleInput('\u001b');
    panel.handleInput('\u001b');

    expect(panel.isClosed()).toBe(true);
  });

  it('keeps scroll and confirmation controls visible when the file preview overflows', () => {
    const preview: TuiRewindPreview = {
      turns: [
        {
          turnId: 'turn-many-files',
          files: Array.from({ length: 20 }, (_, index) => ({
            filePath: `src/file-${String(index)}.ts`,
            action: 'modified',
            skipped: false,
          })),
        },
      ],
    };
    const onContinue = vi.fn();
    const panel = new TuiSessionMutationRewindPreviewPanel({
      preview,
      onCancel: vi.fn(),
      onContinue,
      continueHint: 'Enter rewind · Esc back',
      requestRender: vi.fn(),
    });

    const first = stripAnsi(panel.renderViewport(70, 10).join('\n'));
    expect(first).toContain('PgUp/PgDn scroll');
    expect(first).toContain('Enter rewind');
    expect(first).toContain('Esc back');

    panel.handleInput('\u001b[6~');
    const scrolled = stripAnsi(panel.renderViewport(70, 10).join('\n'));
    expect(scrolled).toContain('Enter rewind');
    expect(scrolled).not.toBe(first);
    panel.handleInput('\r');
    expect(onContinue).toHaveBeenCalledOnce();
  });
});

describe('TuiSessionMutationScopePicker', () => {
  it('only exposes the two Desktop-compatible rewind scopes', () => {
    const onSelect = vi.fn<(scope: TuiRewindScope) => void>();
    const picker = new TuiSessionMutationScopePicker({ onSelect, onCancel: vi.fn() });

    const rendered = stripAnsi(picker.render(80).join('\n'));

    expect(rendered).toMatch(/Choose what to rewind/);
    expect(rendered).toContain('Conversation only');
    expect(rendered).not.toContain('Files only');
    expect(rendered).toContain('Conversation and files');
    expect(rendered).not.toMatch(/partial/i);

    const compact = stripAnsi(picker.renderViewport(60, 4).join('\n'));
    expect(compact).toContain('Enter confirm');
    expect(compact).toContain('Esc cancel');

    picker.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith('conversation');
  });

  it('returns the selected scope when navigating down then confirming', () => {
    const onSelect = vi.fn<(scope: TuiRewindScope) => void>();
    const picker = new TuiSessionMutationScopePicker({ onSelect, onCancel: vi.fn() });

    picker.handleInput('\u001b[B');
    picker.handleInput('\r');

    expect(onSelect).toHaveBeenCalledWith('conversation_and_files');
  });

  it('cancels idempotently and never fires onSelect', () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const picker = new TuiSessionMutationScopePicker({ onSelect, onCancel });

    picker.handleInput('\u001b');
    picker.handleInput('\u001b');

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
