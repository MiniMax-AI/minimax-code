import { describe, expect, it } from 'vitest';

import {
  CURSOR_MARKER,
  Editor,
  Input,
  SelectList,
  Text,
  TuiMainScreen,
  type Component,
  type TUI,
  visibleWidth,
} from '../../src/tui/engine/public.js';
import { TuiChatLayout, type TuiChatLayoutParts } from '../../src/tui/shell/chat-layout.js';
import { VirtualTerminal } from '../pi-084-upstream/virtual-terminal.js';

import { TuiInlinePanelHost } from '../../src/tui/shell/inline-panel.js';
import { TuiPermissionModePicker } from '../../src/tui/features/interaction/permission-mode-picker.js';
import { TranscriptView } from '../../src/tui/transcript/view.js';
import { createTranscriptCell } from '../../src/tui/transcript/model.js';

const passthrough = (value: string): string => value;
const selectListTheme = {
  selectedPrefix: passthrough,
  selectedText: passthrough,
  description: passthrough,
  scrollInfo: passthrough,
  noMatch: passthrough,
};

class RecordingVirtualTerminal extends VirtualTerminal {
  private writes: string[] = [];

  override write(data: string): void {
    this.writes.push(data);
    super.write(data);
  }

  takeWrites(): string {
    const output = this.writes.join('');
    this.writes = [];
    return output;
  }
}

// Apple Terminal preserves the old screen in scrollback on ED 2. Model that
// behavior explicitly: xterm's default erase implementation does not expose it.
class ClearToScrollbackTerminal extends RecordingVirtualTerminal {
  override write(data: string): void {
    super.write(data.replaceAll('\x1b[2J', `\x1b[${this.rows};1H${'\r\n'.repeat(this.rows)}\x1b[2J`));
  }
}

class MutableLines implements Component {
  lines: string[] = [];
  viewportLayoutKey: string | undefined;

  getViewportLayoutKey(): string | undefined {
    return this.viewportLayoutKey;
  }

  render(): string[] {
    return [...this.lines];
  }

  invalidate(): void {}
}

function createMutableChatParts(surface: 'welcome' | 'conversation') {
  const parts = {
    surface: () => surface,
    welcome: new MutableLines(),
    notice: new MutableLines(),
    transcript: new MutableLines(),
    interaction: new MutableLines(),
    activity: new MutableLines(),
    goal: new MutableLines(),
    followUp: new MutableLines(),
    tasks: new MutableLines(),
    composer: new MutableLines(),
    status: new MutableLines(),
  } satisfies TuiChatLayoutParts;
  parts.composer.lines = [`composer${CURSOR_MARKER}`];
  parts.status.lines = ['status'];
  return parts;
}

describe('MCode Pi Engine local deltas', () => {
  describe.each([
    ['xterm', RecordingVirtualTerminal],
    ['clear-to-scrollback host', ClearToScrollbackTerminal],
  ] as const)('%s permission table redraw', (_name, Terminal) => {
    it.each([
      [60, '\r'],
      [100, '\r'],
      [60, '\x1b'],
      [100, '\x1b'],
    ])('keeps tables contiguous at width %i after closing with %j', async (width, key) => {
      const terminal = new Terminal(width, 24);
      const tui = new TuiMainScreen(terminal);
      const interaction = new TuiInlinePanelHost();
      const cell = createTranscriptCell({
        id: 'table',
        kind: 'assistant',
        status: 'succeeded',
        createdAtMs: 1,
        content: [
          '## Cookbook',
          '',
          '| Cookbook | Description |',
          '| --- | --- |',
          ...Array.from({ length: 14 }, (_, index) => `| recipe-${index} | Example ${index} |`),
        ].join('\n'),
      });
      const transcript = new TranscriptView(() => [cell]);
      const empty = new MutableLines();
      const composer = new MutableLines();
      composer.lines = [`composer${CURSOR_MARKER}`];
      const status = new MutableLines();
      status.lines = ['status'];
      const layout = new TuiChatLayout(terminal, {
        surface: () => 'conversation',
        welcome: empty,
        transcript,
        interaction,
        activity: empty,
        followUp: empty,
        composer,
        status,
      });
      tui.addChild(layout);
      tui.renderNow();
      await terminal.flush();
      const original = terminal.getScrollBuffer();
      const picker = new TuiPermissionModePicker(
        'default',
        () => interaction.close(),
        () => interaction.close(),
      );
      interaction.show(picker);
      tui.renderNow();
      await terminal.flush();
      terminal.scrollLines(-5);
      terminal.takeWrites();
      picker.handleInput(key);
      tui.renderNow();
      await terminal.flush();
      const after = terminal.getScrollBuffer();
      expect(after).toEqual(original);
      expect(terminal.getCursorPosition().y).toBe(22);
      const tableStart = original.findIndex((line) => line.includes('┌'));
      const tableEnd = original.findIndex((line) => line.includes('└'));
      expect(tableStart).toBeGreaterThanOrEqual(0);
      expect(tableEnd).toBeGreaterThan(tableStart);
      expect(after.slice(tableStart, tableEnd + 1)).toEqual(
        original.slice(tableStart, tableEnd + 1),
      );
      expect(after.filter((line) => line.trim())).toEqual(original.filter((line) => line.trim()));
      tui.renderNow();
      await terminal.flush();
      expect(terminal.getScrollBuffer()).toEqual(after);
      // Continue streaming the same table while the freed panel rows are reused.
      cell.content += '\n| recipe-14 | Example 14 |';
      tui.renderNow();
      await terminal.flush();
      const grown = terminal.getScrollBuffer();
      const grownEnd = grown.findIndex((line) => line.includes('└'));
      expect(grown.filter((line) => line.includes('recipe-14'))).toHaveLength(1);
      expect(grownEnd).toBeGreaterThan(tableEnd);
      expect(grown.slice(tableStart, grownEnd + 1).every((line) => line.trim().length > 0)).toBe(
        true,
      );
    });
  });

  it('does not replay a submitted input frame after a synchronous render', async () => {
    const terminal = new RecordingVirtualTerminal(60, 12);
    const tui = new TuiMainScreen(terminal);
    let renderCount = 0;
    let content = 'old footer';
    let updateAfterSyncRender = false;
    const component: Component = {
      render: () => {
        renderCount += 1;
        return [content];
      },
      invalidate: () => undefined,
      handleInput: () => {
        content = 'new message';
        tui.renderNow();
        if (updateAfterSyncRender) {
          content = 'later status';
          tui.requestRender();
        }
      },
    };
    tui.addChild(component);
    tui.setFocus(component);
    tui.start();
    tui.renderNow();
    await new Promise<void>((resolve) => setImmediate(resolve));
    renderCount = 0;

    terminal.sendInput('\r');
    expect(renderCount).toBe(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(renderCount).toBe(1);
    await terminal.flush();
    expect(terminal.getViewport().join('\n')).toContain('new message');

    updateAfterSyncRender = true;
    renderCount = 0;
    terminal.sendInput('\r');
    expect(renderCount).toBe(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(renderCount).toBe(2);
    await terminal.flush();
    expect(terminal.getViewport().join('\n')).toContain('later status');
    tui.stop();
  });

  describe.each([
    ['xterm', RecordingVirtualTerminal],
    ['clear-to-scrollback host', ClearToScrollbackTerminal],
  ] as const)('%s viewport repaint', (_name, Terminal) => {
    it.each([0, 30])('keeps unique history after a style update and %i new rows', async (growth) => {
      const terminal = new Terminal(60, 12);
      const tui = new TuiMainScreen(terminal);
      const component = new MutableLines();
      const answer = Array.from({ length: 40 }, (_, index) => `Answer ${index}`);
      component.lines = [...answer, `old composer${CURSOR_MARKER}`, 'running'];
      tui.addChild(component);
      tui.renderNow();
      await terminal.flush();
      terminal.scrollLines(-10);
      const before = terminal.getScrollPosition();
      terminal.takeWrites();

      const more = Array.from({ length: growth }, (_, index) => `More ${index}`);
      component.lines = [...answer, ...more, `composer${CURSOR_MARKER}`, 'idle'];
      component.lines[0] = '\x1b[1mAnswer 0\x1b[0m';
      tui.renderNow();
      await terminal.flush();

      expect(terminal.getScrollBuffer()).toEqual([...answer, ...more, 'composer', 'idle']);
      expect(terminal.getScrollPosition().viewport).toBe(before.viewport);
      expect(terminal.getCursorPosition()).toEqual({ x: 8, y: 10 });
      const writes = terminal.takeWrites();
      expect(writes).not.toContain('\x1b[2J');
      expect(writes).not.toContain('\x1b[3J');

      // Subsequent differential output must still overwrite the current footer.
      component.lines.splice(-2, 0, 'Next response');
      tui.renderNow();
      await terminal.flush();
      expect(terminal.getScrollBuffer()).toEqual([...answer, ...more, 'Next response', 'composer', 'idle']);
      terminal.scrollLines(1000);
      expect(terminal.getViewport().slice(-3)).toEqual(['Next response', 'composer', 'idle']);
    });

    it('erases stale rows when a short document shrinks', async () => {
      const terminal = new Terminal(60, 12);
      const tui = new TuiMainScreen(terminal);
      tui.setClearOnShrink(true);
      const component = new MutableLines();
      component.lines = ['answer', 'activity 1', 'activity 2', `old composer${CURSOR_MARKER}`, 'running'];
      tui.addChild(component);
      tui.renderNow();
      await terminal.flush();
      terminal.takeWrites();

      component.lines = ['answer', `composer${CURSOR_MARKER}`, 'idle'];
      tui.renderNow();
      await terminal.flush();

      expect(terminal.getScrollBuffer()).toEqual(['answer', 'composer', 'idle', ...Array<string>(9).fill('')]);
      expect(terminal.getCursorPosition()).toEqual({ x: 8, y: 1 });
      const writes = terminal.takeWrites();
      expect(writes).not.toContain('\x1b[2J');
      expect(writes).not.toContain('\x1b[3J');
    });
  });

  it.each([1, 8, 30])('preserves a scrolled host viewport when %i visible activity rows settle', async (activityRows) => {
    const terminal = new RecordingVirtualTerminal(60, 44);
    const tui = new TuiMainScreen(terminal);
    const component = new MutableLines();
    component.viewportLayoutKey = 'stable-footer';
    const answer = Array.from({ length: 80 }, (_, index) => `Answer ${index}`);
    component.lines = [
      ...answer,
      ...Array.from({ length: activityRows }, (_, index) => `Activity ${index}`),
      `composer${CURSOR_MARKER}`,
      'running',
    ];
    tui.addChild(component);
    tui.renderNow();
    await terminal.flush();
    terminal.scrollLines(-10);
    const before = terminal.getScrollPosition();
    expect(before.viewport).toBeGreaterThan(0);
    expect(before.viewport).toBeLessThan(before.bottom);
    terminal.takeWrites();

    component.lines = [...answer, `composer${CURSOR_MARKER}`, 'idle'];
    tui.renderNow();
    await terminal.flush();

    expect(terminal.getScrollPosition()).toEqual(before);
    expect(terminal.takeWrites()).not.toContain('\x1b[3J');
    expect(terminal.getScrollBuffer().filter(Boolean)).toEqual([...answer, 'composer', 'idle']);
    expect(terminal.getCursorPosition()).toEqual({ x: 8, y: 42 });

    // Repeated idle redraws must not reset the view or duplicate the transcript.
    tui.renderNow();
    await terminal.flush();
    expect(terminal.getScrollPosition()).toEqual(before);
    expect(terminal.takeWrites()).not.toContain('\x1b[3J');

    terminal.scrollLines(1000);
    expect(terminal.getViewport().slice(-2)).toEqual(['composer', 'idle']);
  });

  describe.each([
    ['xterm', RecordingVirtualTerminal],
    ['clear-to-scrollback host', ClearToScrollbackTerminal],
  ] as const)('%s transient layout restoration', (_name, Terminal) => {
    const transientParts = ['welcome', 'interaction', 'composer', 'notice', 'followUp', 'goal', 'tasks', 'status'] as const;

    it.each(transientParts)('restores the document tail after repeated %s collapses', async (part) => {
      const terminal = new Terminal(60, 16);
      const tui = new TuiMainScreen(terminal);
      const parts = createMutableChatParts(part === 'notice' || part === 'welcome' ? 'welcome' : 'conversation');
      const history = Array.from({ length: 40 }, (_, index) => `History ${index}`);
      (part === 'notice' || part === 'welcome' ? parts.welcome : parts.transcript).lines = history;
      const layout = new TuiChatLayout(terminal, parts);
      tui.addChild(layout);
      tui.renderNow();
      await terminal.flush();
      const expected = terminal.getScrollBuffer();
      const baseline = [...parts[part].lines];

      for (let cycle = 0; cycle < 3; cycle++) {
        parts[part].lines = [
          ...(part === 'welcome' ? baseline : []),
          ...Array.from({ length: 8 }, (_, index) => `${part} ${cycle}-${index}`),
        ];
        tui.renderNow();
        await terminal.flush();
        parts[part].lines = [...baseline];
        tui.renderNow();
        await terminal.flush();

        const logicalDocument = layout.render(terminal.columns).map((line) => line.replace(CURSOR_MARKER, ''));
        expect(terminal.getViewport()).toEqual(logicalDocument.slice(-terminal.rows));
        expect(terminal.getScrollBuffer()).toEqual(expected);
        for (const line of history) {
          expect(terminal.getScrollBuffer().filter((row) => row.trim() === line)).toHaveLength(1);
        }
      }
    });

    it.each(transientParts)('erases a short %s without clearing host history', async (part) => {
      const terminal = new Terminal(60, 16);
      const tui = new TuiMainScreen(terminal);
      const parts = createMutableChatParts(part === 'notice' || part === 'welcome' ? 'welcome' : 'conversation');
      (part === 'notice' || part === 'welcome' ? parts.welcome : parts.transcript).lines = ['Short answer'];
      const layout = new TuiChatLayout(terminal, parts);
      tui.addChild(layout);
      tui.renderNow();
      await terminal.flush();
      const expected = terminal.getScrollBuffer();
      const baseline = [...parts[part].lines];
      parts[part].lines = [
        ...(part === 'welcome' ? baseline : []),
        ...Array.from({ length: 8 }, (_, index) => `${part} ${index}`),
      ];
      tui.renderNow();
      await terminal.flush();
      terminal.takeWrites();
      parts[part].lines = baseline;
      tui.renderNow();
      await terminal.flush();

      expect(terminal.getScrollBuffer()).toEqual(expected);
      expect(terminal.takeWrites()).not.toContain('\x1b[3J');
    });

    it.each([
      ['hide', 2],
      ['hide', 40],
      ['setHidden', 2],
      ['setHidden', 40],
    ] as const)('restores %s overlays after activity settles with %i history rows', async (close, historyRows) => {
      const terminal = new Terminal(60, 16);
      const tui = new TuiMainScreen(terminal);
      const parts = createMutableChatParts('conversation');
      parts.transcript.lines = Array.from({ length: historyRows }, (_, index) => `History ${index}`);
      const layout = new TuiChatLayout(terminal, parts);
      tui.addChild(layout);
      tui.renderNow();
      await terminal.flush();
      const expected = terminal.getScrollBuffer();
      const overlay = new MutableLines();
      overlay.lines = ['Overlay contents'];

      for (let cycle = 0; cycle < 2; cycle++) {
        // Background activity changes do not alter the chat's transient layout key.
        // The previous overlay frame must still prevent padding after it disappears.
        parts.activity.lines = Array.from({ length: 5 }, (_, index) => `Activity ${index}`);
        const handle = tui.showOverlay(overlay, { width: 24 });
        tui.renderNow();
        await terminal.flush();
        expect(terminal.getViewport().join('\n')).toContain('Overlay contents');
        terminal.takeWrites();
        if (close === 'hide') handle.hide();
        else handle.setHidden(true);
        parts.activity.lines = [];
        tui.renderNow();
        await terminal.flush();

        expect(terminal.getScrollBuffer()).toEqual(expected);
        expect(terminal.getViewport().join('\n')).not.toContain('Overlay contents');
        if (historyRows < terminal.rows) expect(terminal.takeWrites()).not.toContain('\x1b[3J');
        // Hidden overlays remain registered; removing one must keep the restored frame.
        handle.hide();
        tui.renderNow();
        await terminal.flush();
        expect(terminal.getScrollBuffer()).toEqual(expected);
      }
    });

    it.each([false, true])('reconstructs when any root lacks a layout key (mixed roots: %s)', async (mixedRoots) => {
      const terminal = new Terminal(60, 16);
      const tui = new TuiMainScreen(terminal);
      const component = new MutableLines();
      const history = Array.from({ length: 40 }, (_, index) => `History ${index}`);
      component.lines = [...history, 'composer', 'status'];
      tui.addChild(component);
      if (mixedRoots) {
        component.viewportLayoutKey = 'stable-footer';
        tui.addChild(new MutableLines());
      }
      tui.renderNow();
      await terminal.flush();
      const expected = terminal.getScrollBuffer();
      component.lines.splice(-2, 0, ...Array.from({ length: 8 }, (_, index) => `Transient ${index}`));
      tui.renderNow();
      await terminal.flush();
      component.lines = [...history, 'composer', 'status'];
      tui.renderNow();
      await terminal.flush();

      expect(terminal.getScrollBuffer()).toEqual(expected);
      expect(terminal.getViewport()).toEqual(component.lines.slice(-terminal.rows));
    });

    it('tracks layout changes even when they produce an identical frame', async () => {
      const terminal = new Terminal(60, 16);
      const tui = new TuiMainScreen(terminal);
      const component = new MutableLines();
      const history = Array.from({ length: 40 }, (_, index) => `History ${index}`);
      component.viewportLayoutKey = 'closed';
      component.lines = [...history, 'composer', 'status'];
      tui.addChild(component);
      tui.renderNow();
      await terminal.flush();
      const expected = terminal.getScrollBuffer();
      component.lines.splice(-2, 0, ...Array.from({ length: 8 }, (_, index) => `Transient ${index}`));
      tui.renderNow();
      await terminal.flush();

      // A selector can replace a same-height footer without changing any rows.
      component.viewportLayoutKey = 'open';
      tui.renderNow();
      await terminal.flush();
      component.viewportLayoutKey = 'closed';
      component.lines = [...history, 'composer', 'status'];
      tui.renderNow();
      await terminal.flush();

      expect(terminal.getScrollBuffer()).toEqual(expected);
      expect(terminal.getViewport()).toEqual(component.lines.slice(-terminal.rows));
    });

    it('preserves a scrolled host viewport when only chat activity settles', async () => {
      const terminal = new Terminal(60, 16);
      const tui = new TuiMainScreen(terminal);
      const parts = createMutableChatParts('conversation');
      parts.transcript.lines = Array.from({ length: 40 }, (_, index) => `History ${index}`);
      parts.activity.lines = ['Activity 1', 'Activity 2', 'Activity 3'];
      const layout = new TuiChatLayout(terminal, parts);
      tui.addChild(layout);
      tui.renderNow();
      await terminal.flush();
      terminal.scrollLines(-10);
      const before = terminal.getScrollPosition();
      terminal.takeWrites();
      parts.activity.lines = [];
      tui.renderNow();
      await terminal.flush();

      expect(terminal.getScrollPosition()).toEqual(before);
      expect(terminal.takeWrites()).not.toContain('\x1b[3J');
      expect(terminal.getScrollBuffer().filter((line) => line.trim().startsWith('History ')))
        .toHaveLength(40);
      terminal.scrollLines(1000);
      expect(terminal.getViewport().slice(-2).map((line) => line.trim())).toEqual(['composer', 'status']);
    });
  });

  it('ignores same-size resize notifications while the host is scrolled up', async () => {
    const terminal = new RecordingVirtualTerminal(60, 12);
    const tui = new TuiMainScreen(terminal);
    const component = new MutableLines();
    component.lines = Array.from({ length: 80 }, (_, index) => `Answer ${index}`);
    tui.addChild(component);
    try {
      tui.start();
      tui.renderNow();
      await terminal.flush();
      terminal.scrollLines(-10);
      const before = terminal.getScrollPosition();
      const redraws = tui.fullRedraws;
      terminal.takeWrites();
      terminal.resize(60, 12);
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      await terminal.flush();
      expect(terminal.getScrollPosition()).toEqual(before);
      expect(tui.fullRedraws).toBe(redraws);
      expect(terminal.takeWrites()).not.toContain('\x1b[3J');
    } finally {
      tui.stop();
    }
  });

  it('still reconstructs corrected history after a viewport shrink was absorbed', async () => {
    const terminal = new RecordingVirtualTerminal(60, 12);
    const tui = new TuiMainScreen(terminal);
    const component = new MutableLines();
    component.viewportLayoutKey = 'stable-footer';
    const answer = Array.from({ length: 80 }, (_, index) => `Answer ${index}`);
    component.lines = [...answer, 'activity', `composer${CURSOR_MARKER}`, 'status'];
    tui.addChild(component);
    tui.renderNow();
    await terminal.flush();
    terminal.takeWrites();

    component.lines = [...answer, `composer${CURSOR_MARKER}`, 'status'];
    tui.renderNow();
    await terminal.flush();
    expect(terminal.takeWrites()).not.toContain('\x1b[3J');

    component.lines[0] = 'Corrected answer';
    tui.renderNow();
    await terminal.flush();
    expect(terminal.takeWrites()).toContain('\x1b[3J');
    expect(terminal.getScrollBuffer()).toEqual(['Corrected answer', ...answer.slice(1), 'composer', 'status']);
    expect(terminal.getCursorPosition()).toEqual({ x: 8, y: 10 });
  });

  it('fits Text padding within narrow terminal widths', () => {
    const text = new Text('content', 2, 0);

    for (const width of [1, 2, 3, 4]) {
      expect(text.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });

  it('rebuilds when a transient collapse changes rows already in scrollback', async () => {
    const terminal = new RecordingVirtualTerminal(40, 5);
    const tui = new TuiMainScreen(terminal);
    const component = new MutableLines();
    component.lines = [
      'header',
      'activity-1',
      'activity-2',
      'activity-3',
      'activity-4',
      'status',
      'composer',
    ];
    tui.addChild(component);

    tui.renderNow();
    await terminal.flush();
    terminal.takeWrites();

    component.lines = ['header', 'status', 'composer'];
    tui.renderNow();
    await terminal.flush();

    const writes = terminal.takeWrites();
    expect(writes).toContain('\x1b[2J\x1b[H');
    expect(writes).toContain('\x1b[3J');
    expect(terminal.getScrollBuffer()).not.toContain('activity-1');
    expect(terminal.getViewport()).toEqual(['header', 'status', 'composer', '', '']);
    expect(terminal.getScrollBuffer().filter((line) => line === 'header')).toHaveLength(1);
    expect(tui.fullRedraws).toBe(2);
  });

  it('does not replay scrolled answer rows after a narrow terminal frame shrinks', async () => {
    const terminal = new RecordingVirtualTerminal(67, 44);
    const tui = new TuiMainScreen(terminal);
    const component = new MutableLines();
    component.viewportLayoutKey = 'stable-footer';
    const answer = Array.from({ length: 80 }, (_, index) => `Answer line ${index}`);
    component.lines = [...answer, 'activity', `composer${CURSOR_MARKER}`, 'status'];
    tui.addChild(component);
    tui.renderNow();
    await terminal.flush();

    // Settle the activity row, then repaint a historical line (for example Markdown styling).
    terminal.takeWrites();
    component.lines = [...answer, `composer${CURSOR_MARKER}`, 'status'];
    component.lines[0] = '\x1b[1mAnswer line 0\x1b[0m';
    tui.renderNow();
    await terminal.flush();
    expect(terminal.takeWrites()).not.toContain('\x1b[3J');
    component.lines[0] = '\x1b[1mAnswer line 0\x1b[0m';
    tui.renderNow();
    await terminal.flush();

    expect(terminal.takeWrites()).not.toContain('\x1b[3J');
    expect(terminal.getScrollBuffer()).toEqual([
      ...answer.slice(0, 39), '', ...answer.slice(39), 'composer', 'status',
    ]);
    expect(terminal.getViewport().at(-1)).toBe('status');
    expect(terminal.getCursorPosition()).toEqual({ x: 8, y: 42 });

    // A later burst must continue from the same logical/physical boundary.
    component.lines.splice(80, 0, ...Array.from({ length: 50 }, (_, index) => `More ${index}`));
    tui.renderNow();
    await terminal.flush();
    expect(terminal.getScrollBuffer()).toEqual([
      ...answer,
      ...Array.from({ length: 50 }, (_, index) => `More ${index}`),
      'composer',
      'status',
    ]);
  });

  it.each([1, 8, 30])(
    'keeps the composer and status at the bottom as %i running rows settle and new output grows',
    async (activityRows) => {
      const terminal = new RecordingVirtualTerminal(60, 44);
      const tui = new TuiMainScreen(terminal);
      const component = new MutableLines();
      component.viewportLayoutKey = 'stable-footer';
      const answer = Array.from({ length: 80 }, (_, index) => `Answer ${index}`);
      component.lines = [
        ...answer,
        ...Array.from({ length: activityRows }, (_, index) => `Activity ${index}`),
        `composer${CURSOR_MARKER}`,
        'running',
      ];
      tui.addChild(component);
      tui.renderNow();
      await terminal.flush();
      terminal.takeWrites();

      component.lines = [...answer, `composer${CURSOR_MARKER}`, 'idle'];
      for (let added = 0; added <= activityRows + 1; added++) {
        tui.renderNow();
        await terminal.flush();
        // Native history keeps its original boundary. Freed rows remain visible
        // until new output consumes them, rather than replaying historical text.
        const expected = component.lines.map((line) => line.replace(CURSOR_MARKER, ''));
        const remainingSpace = Math.max(0, activityRows - added);
        if (remainingSpace > 0) expected.splice(38 + activityRows, 0, ...Array<string>(remainingSpace).fill(''));
        expect(terminal.getViewport()).toEqual(
          expected.slice(-terminal.rows),
        );
        expect(terminal.getCursorPosition()).toEqual({ x: 8, y: 42 });
        expect(terminal.takeWrites()).not.toContain('\x1b[3J');
        expect(terminal.getScrollBuffer()).toEqual(expected);
        if (added <= activityRows) component.lines.splice(-2, 0, `New answer ${added}`);
      }
      expect(terminal.getScrollBuffer()).not.toContain('');
    },
  );

  it('keeps every appended row when a historical row changes in the same frame', async () => {
    const terminal = new RecordingVirtualTerminal(67, 44);
    const tui = new TuiMainScreen(terminal);
    const component = new MutableLines();
    const answer = Array.from({ length: 80 }, (_, index) => `Answer line ${index}`);
    component.lines = [...answer, 'composer'];
    tui.addChild(component);
    tui.renderNow();
    await terminal.flush();
    terminal.takeWrites();

    const more = Array.from({ length: 50 }, (_, index) => `More ${index}`);
    component.lines = [...answer, ...more, 'composer'];
    component.lines[0] = '\x1b[1mAnswer line 0\x1b[0m';
    tui.renderNow();
    await terminal.flush();

    expect(terminal.takeWrites()).not.toContain('\x1b[3J');
    expect(terminal.getScrollBuffer()).toEqual([...answer, ...more, 'composer']);
  });

  it.each([0, 30])('rebuilds changed scrollback text even when the document grows by %i rows', async (growth) => {
    const terminal = new RecordingVirtualTerminal(67, 24);
    const tui = new TuiMainScreen(terminal);
    const component = new MutableLines();
    const input = Array.from({ length: 80 }, (_, index) => `Queued input ${index}`);
    component.lines = [...input, `composer${CURSOR_MARKER}`, 'status'];
    tui.addChild(component);
    tui.renderNow();
    await terminal.flush();
    terminal.takeWrites();

    component.lines = [
      'Recovered context',
      ...Array.from({ length: growth }, (_, index) => `Recovered row ${index}`),
      ...input.slice(1),
      `composer${CURSOR_MARKER}`,
      'status',
    ];
    tui.renderNow();
    await terminal.flush();

    const expected = component.lines.map((line) => line.replace(CURSOR_MARKER, ''));
    expect(terminal.takeWrites()).toContain('\x1b[3J');
    expect(terminal.getScrollBuffer()).toEqual(expected);
    expect(terminal.getViewport()).toEqual(expected.slice(-terminal.rows));
    expect(terminal.getCursorPosition()).toEqual({ x: 8, y: 22 });

    // Subsequent streaming must overwrite the current footer, not append a second one.
    component.lines.splice(-2, 0, 'Next response');
    tui.renderNow();
    await terminal.flush();
    expect(terminal.takeWrites()).not.toContain('\x1b[3J');
    expect(terminal.getScrollBuffer()).toEqual([
      ...expected.slice(0, -2), 'Next response', 'composer', 'status',
    ]);
  });

  it('rebuilds the document when shrinking leaves no rows in the previous viewport', async () => {
    const terminal = new RecordingVirtualTerminal(67, 44);
    const tui = new TuiMainScreen(terminal);
    const component = new MutableLines();
    component.lines = Array.from({ length: 100 }, (_, index) => `Old line ${index}`);
    tui.addChild(component);
    tui.renderNow();
    await terminal.flush();

    component.lines = ['answer', `composer${CURSOR_MARKER}`];
    tui.renderNow();
    await terminal.flush();

    expect(terminal.getScrollBuffer().filter(Boolean)).toEqual(['answer', 'composer']);
    expect(terminal.getCursorPosition()).toEqual({ x: 8, y: 1 });
  });

  it.each([
    ['xterm', RecordingVirtualTerminal],
    ['clear-to-scrollback host', ClearToScrollbackTerminal],
  ] as const)('previews the resized tail and restores ordered scrollback on %s', async (_name, Terminal) => {
    const terminal = new Terminal(67, 44);
    const tui = new TuiMainScreen(terminal);
    const component = new MutableLines();
    component.lines = [
      ...Array.from({ length: 80 }, (_, index) => `Answer line ${index}`),
      `composer${CURSOR_MARKER}`,
    ];
    tui.addChild(component);
    try {
      tui.start();
      tui.renderNow();
      await terminal.flush();
      terminal.takeWrites();

      terminal.resize(60, 30);
      tui.renderNow();
      await terminal.flush();
      const previewWrites = terminal.takeWrites();
      expect(previewWrites).not.toContain('\x1b[2J');
      expect(previewWrites).not.toContain('\x1b[3J');
      expect(terminal.getScrollBuffer()).toEqual([
        ...Array.from({ length: 80 }, (_, index) => `Answer line ${index}`),
        'composer',
      ]);
      expect(terminal.getViewport()).toEqual([
        ...Array.from({ length: 29 }, (_, index) => `Answer line ${index + 51}`),
        'composer',
      ]);

      // A redundant notification must not discard the pending genuine resize replay.
      terminal.resize(60, 30);

      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      tui.renderNow();
      await terminal.flush();
      expect(terminal.takeWrites()).toContain('\x1b[3J');
      expect(terminal.getScrollBuffer()).toEqual([
        ...Array.from({ length: 80 }, (_, index) => `Answer line ${index}`),
        'composer',
      ]);
      expect(terminal.getCursorPosition()).toEqual({ x: 8, y: 29 });
    } finally {
      tui.stop();
    }
  });

  it('renders an urgent product interaction without resetting Main diff state', async () => {
    const terminal = new RecordingVirtualTerminal(40, 5);
    const tui = new TuiMainScreen(terminal);
    const component = new MutableLines();
    component.lines = ['stable', 'tail'];
    tui.addChild(component);

    tui.renderNow();
    await terminal.flush();
    terminal.takeWrites();

    component.lines.push('interaction');
    tui.requestImmediateRender();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await terminal.flush();

    const writes = terminal.takeWrites();
    expect(writes).toContain('interaction');
    expect(writes).not.toContain('\x1b[2J');
    expect(writes).not.toContain('\x1b[3J');
  });

  it('keeps OSC 133 zone sentinels out of regular-mode terminal writes', async () => {
    const terminal = new RecordingVirtualTerminal(40, 5);
    const tui = new TuiMainScreen(terminal);
    const component = new MutableLines();
    const zoneStart = '\x1b]133;A\x07';
    const zoneClose = '\x1b]133;B\x07\x1b]133;C\x07';
    component.lines = [`${zoneStart}user prompt`, `${zoneClose}assistant reply`, 'composer'];
    tui.addChild(component);

    tui.renderNow();
    await terminal.flush();
    const initialWrites = terminal.takeWrites();
    expect(initialWrites).toContain('user prompt');
    expect(initialWrites).toContain('assistant reply');
    expect(initialWrites).not.toContain('\x1b]133;');

    component.lines = [`${zoneStart}user prompt`, `${zoneClose}assistant reply updated`, 'composer'];
    tui.renderNow();
    await terminal.flush();
    const diffWrites = terminal.takeWrites();
    expect(diffWrites).toContain('assistant reply updated');
    expect(diffWrites).not.toContain('\x1b]133;');
  });

  it('limits Input extensions to prompt, mask, and paste transformation', () => {
    const input = new Input({
      prompt: 'Search: ',
      mask: '•',
      transformPaste: (value) => value.replace(/\s+/gu, ' '),
    });

    input.handleInput('\u001B[200~secret\nvalue\u001B[201~');
    input.focused = true;

    const rendered = input.render(30)[0] ?? '';
    expect(input.getValue()).toBe('secret value');
    expect(rendered).toContain('Search: ');
    expect(rendered).toContain('•');
    expect(rendered).not.toContain('secret');
    expect(rendered).toContain(CURSOR_MARKER);
  });

  it('retains grouped SelectList headings while using Pi filtering and single-line descriptions', () => {
    const list = new SelectList(
      [
        {
          value: 'docs',
          label: 'Documents',
          description: 'Create, edit, search and share documents.',
          groupLabel: 'Files',
        },
        {
          value: 'code',
          label: 'Code',
          description: 'Inspect and modify source code.',
          groupLabel: 'Files',
        },
      ],
      2,
      selectListTheme,
    );

    list.setFilter('docs');
    const rendered = list.render(48);

    expect(rendered.join('\n')).toContain('Files');
    expect(rendered.join('\n')).toContain('Documents');
    expect(rendered.join('\n')).not.toContain('Code');
    expect(rendered).toHaveLength(2);
    expect(rendered.every((line) => visibleWidth(line) <= 48)).toBe(true);
  });

  it('exposes only the generic Editor hooks required by a product Draft adapter', () => {
    const tui = {
      terminal: { rows: 24 },
      requestRender: () => undefined,
    } as TUI;
    const editor = new Editor(tui, { borderColor: passthrough, selectList: selectListTheme }, {
      transformPaste: (value) => value.replaceAll('\r', ''),
    });
    let extensionState = 'empty';
    editor.captureUndoExtensionState = () => extensionState;
    editor.restoreUndoExtensionState = (state) => {
      extensionState = String(state);
    };

    editor.handleInput('a');
    extensionState = 'typed';
    editor.handleInput('\x1f');
    expect(editor.getText()).toBe('');
    expect(extensionState).toBe('empty');

    editor.onPaste = (value) => value.endsWith('.png');
    editor.handleInput('\u001B[200~/tmp/image.png\r\u001B[201~');
    expect(editor.getText()).toBe('');

    const pasted = 'x'.repeat(1_001);
    editor.onPaste = undefined;
    editor.handleInput(`\u001B[200~${pasted}\u001B[201~`);
    const snapshot = editor.captureState();
    editor.setText('replacement');
    expect(editor.restoreState(snapshot)).toBe(true);
    expect(editor.getExpandedText()).toBe(pasted);

    let submitted = '';
    editor.onSubmit = (value) => {
      submitted = value;
    };
    editor.submit();
    expect(submitted).toBe(pasted);
  });
});
