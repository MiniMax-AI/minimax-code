import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

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
import { TranscriptStore } from '../../src/tui/transcript/store.js';
import { TuiTurnProjection } from '../../src/tui/controller/projection/turn-projection.js';

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

/**
 * A key reaches the TUI through the host terminal, which scrolls back to the
 * bottom before delivering it. Tests that call component handlers directly
 * model that delivery explicitly (L047).
 */
function deliverUserKey(terminal: VirtualTerminal, tui: TuiMainScreen): void {
  terminal.scrollLines(Number.MAX_SAFE_INTEGER);
  (tui as unknown as { onUserInput(): void }).onUserInput();
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
      deliverUserKey(terminal, tui);
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
        deliverUserKey(terminal, tui);
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

        expect(terminal.getViewport().join('\n')).not.toContain('Overlay contents');
        if (historyRows >= terminal.rows) {
          // #426: without recent input the rows revealed above the screen are only
          // repainted in place; the next key reconstructs native history (L047).
          if (cycle === 0) expect(terminal.takeWrites()).not.toContain('\x1b[3J');
          deliverUserKey(terminal, tui);
          tui.renderNow();
          await terminal.flush();
        }
        expect(terminal.getScrollBuffer()).toEqual(expected);
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
      deliverUserKey(terminal, tui);
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
      deliverUserKey(terminal, tui);
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
    // #426: output-driven history corrections wait for the next key (L047).
    expect(terminal.takeWrites()).not.toContain('\x1b[3J');
    deliverUserKey(terminal, tui);
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

    // #426: without recent input the screen is repainted in place and native
    // history keeps its stale rows until the next key (L047).
    expect(terminal.takeWrites()).not.toContain('\x1b[3J');
    expect(terminal.getViewport()).toEqual(['header', 'status', 'composer', '', '']);
    expect(terminal.getScrollBuffer()).toContain('activity-1');

    deliverUserKey(terminal, tui);
    tui.renderNow();
    await terminal.flush();
    const writes = terminal.takeWrites();
    expect(writes).toContain('\x1b[2J\x1b[H');
    expect(writes).toContain('\x1b[3J');
    expect(terminal.getScrollBuffer()).not.toContain('activity-1');
    expect(terminal.getViewport()).toEqual(['header', 'status', 'composer', '', '']);
    expect(terminal.getScrollBuffer().filter((line) => line === 'header')).toHaveLength(1);
    expect(tui.fullRedraws).toBe(3);
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
    // #426: without recent input only the screen (and any growth) is written; the
    // changed scrollback text is rebuilt after the next key (L047).
    expect(terminal.takeWrites()).not.toContain('\x1b[3J');
    expect(terminal.getViewport()).toEqual(expected.slice(-terminal.rows));
    expect(terminal.getScrollBuffer()[0]).toBe('Queued input 0');
    // Rows from the previous viewport origin (82 - 24) on, including growth, are current.
    expect(terminal.getScrollBuffer().slice(58)).toEqual(expected.slice(58));
    deliverUserKey(terminal, tui);
    tui.renderNow();
    await terminal.flush();
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

    // #426: without recent input the new document is painted at the top of the
    // screen; the old rows stay in native history until the next key (L047).
    expect(terminal.getViewport().filter(Boolean)).toEqual(['answer', 'composer']);
    expect(terminal.getCursorPosition()).toEqual({ x: 8, y: 1 });
    expect(terminal.getScrollBuffer()).toContain('Old line 0');

    deliverUserKey(terminal, tui);
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

  // #426: ED 3 + replay leaves a scrolled-up xterm.js host at the top of the
  // rebuilt history (it keeps its scrolled state), so reconstruction after an
  // output-driven layout shrink waits for user input, when hosts return to the
  // bottom (L047). Resize keeps its immediate replay after settling.
  describe('scrolled-up readers during output-driven layout shrink (#426)', () => {
    const started: TuiMainScreen[] = [];
    afterEach(() => {
      for (const tui of started.splice(0)) tui.stop();
    });
    const renderShrinkingTasks = async (terminal: RecordingVirtualTerminal) => {
      const tui = new TuiMainScreen(terminal);
      tui.start();
      started.push(tui);
      const parts = createMutableChatParts('conversation');
      const history = Array.from({ length: 40 }, (_, index) => `History ${index}`);
      parts.transcript.lines = history;
      parts.tasks.lines = Array.from({ length: 6 }, (_, index) => `Task ${index}`);
      const layout = new TuiChatLayout(terminal, parts);
      tui.addChild(layout);
      tui.renderNow();
      await terminal.flush();
      return { tui, parts, history, layout };
    };
    const collapseTasks = async (
      terminal: RecordingVirtualTerminal,
      tui: TuiMainScreen,
      parts: ReturnType<typeof createMutableChatParts>,
    ) => {
      parts.tasks.lines = [];
      tui.renderNow();
      await terminal.flush();
    };
    const logicalDocument = (layout: TuiChatLayout, terminal: RecordingVirtualTerminal) =>
      layout.render(terminal.columns).map((line) => line.replace(CURSOR_MARKER, ''));

    it('pads an output-driven layout shrink and reconstructs after the next key', async () => {
      const terminal = new RecordingVirtualTerminal(60, 16);
      const { tui, parts, history, layout } = await renderShrinkingTasks(terminal);
      terminal.scrollLines(-12);
      const before = terminal.getScrollPosition();
      expect(before.viewport).toBeGreaterThan(0);
      terminal.takeWrites();

      // Background tasks finish without user input while the reader is scrolled up.
      await collapseTasks(terminal, tui, parts);
      expect(terminal.takeWrites()).not.toContain('\x1b[3J');
      expect(terminal.getScrollPosition()).toEqual(before);
      for (const line of history) {
        expect(terminal.getScrollBuffer().filter((row) => row.trim() === line)).toHaveLength(1);
      }

      deliverUserKey(terminal, tui);
      tui.renderNow();
      await terminal.flush();
      expect(terminal.takeWrites()).toContain('\x1b[3J');
      expect(terminal.getViewport()).toEqual(logicalDocument(layout, terminal).slice(-terminal.rows));
      expect(terminal.getScrollBuffer()).toEqual(logicalDocument(layout, terminal));
    });

    it('keeps a tailing reader at the bottom when output ends and the task list collapses', async () => {
      const terminal = new RecordingVirtualTerminal(60, 16);
      const { tui, parts, history, layout } = await renderShrinkingTasks(terminal);
      expect(terminal.getScrollPosition().viewport).toBe(terminal.getScrollPosition().bottom);
      terminal.takeWrites();

      // The reply finishes streaming, then the task list collapses, with no input.
      parts.transcript.lines = [...history, 'Final answer line'];
      tui.renderNow();
      await terminal.flush();
      await collapseTasks(terminal, tui, parts);

      const position = terminal.getScrollPosition();
      expect(terminal.takeWrites()).not.toContain('\x1b[3J');
      expect(position.viewport).not.toBe(0);
      expect(position.viewport).toBe(position.bottom);
      expect(terminal.getViewport().slice(-2).map((row) => row.trim())).toEqual(['composer', 'status']);
      expect(terminal.getViewport().some((row) => row.trim() === 'Final answer line')).toBe(true);
      for (const line of [...history, 'Final answer line']) {
        expect(terminal.getScrollBuffer().filter((row) => row.trim() === line)).toHaveLength(1);
      }

      // The next key restores the complete viewport without leaving the bottom.
      deliverUserKey(terminal, tui);
      tui.renderNow();
      await terminal.flush();
      const after = terminal.getScrollPosition();
      expect(after.viewport).toBe(after.bottom);
      expect(terminal.getScrollBuffer()).toEqual(logicalDocument(layout, terminal));
    });

    it('reconstructs immediately when the shrink follows recent user input', async () => {
      const terminal = new RecordingVirtualTerminal(60, 16);
      const { tui, parts, layout } = await renderShrinkingTasks(terminal);
      terminal.takeWrites();
      deliverUserKey(terminal, tui);
      await collapseTasks(terminal, tui, parts);
      expect(terminal.takeWrites()).toContain('\x1b[3J');
      expect(terminal.getScrollBuffer()).toEqual(logicalDocument(layout, terminal));
    });

    it('keeps the immediate history replay after a resize settles', async () => {
      const terminal = new RecordingVirtualTerminal(60, 30);
      const tui = new TuiMainScreen(terminal);
      const component = new MutableLines();
      component.lines = [...Array.from({ length: 80 }, (_, index) => `Answer line ${index}`), `composer${CURSOR_MARKER}`];
      tui.addChild(component);
      try {
        tui.start();
        tui.renderNow();
        await terminal.flush();
        terminal.takeWrites();
        terminal.resize(59, 30);
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
        tui.renderNow();
        await terminal.flush();
        expect(terminal.takeWrites()).toContain('\x1b[3J');
        expect(terminal.getScrollBuffer()).toEqual([
          ...Array.from({ length: 80 }, (_, index) => `Answer line ${index}`),
          'composer',
        ]);
      } finally {
        tui.stop();
      }
    });

    it.each([
      ['focus in', '\x1b[I'],
      ['focus out', '\x1b[O'],
      ['window size report', '\x1b[8;16;60t'],
      ['cursor position report', '\x1b[12;40R'],
      ['extended cursor position report', '\x1b[?12;40;1R'],
      ['kitty keyboard flags', '\x1b[?1u'],
      ['device attributes', '\x1b[?62;22c'],
      ['device status', '\x1b[?997;1n'],
      ['mode report', '\x1b[?2026;2$y'],
      ['kitty key release', '\x1b[97;1:3u'],
      ['mixed reports in one chunk', '\x1b[I\x1b[12;40R\x1b[?62;22c\x1bP>|xterm(1)\x1b\\\x1b[O'],
    ])('does not treat a %s as user input', async (_name, report) => {
      const terminal = new RecordingVirtualTerminal(60, 16);
      const { tui, parts } = await renderShrinkingTasks(terminal);
      terminal.scrollLines(-12);
      await collapseTasks(terminal, tui, parts);
      terminal.takeWrites();
      const before = terminal.getScrollPosition();

      terminal.sendInput(report);
      tui.renderNow();
      await terminal.flush();
      expect(terminal.takeWrites()).not.toContain('\x1b[3J');
      expect(terminal.getScrollPosition()).toEqual(before);
    });

    it.each([
      ['a key after a cursor position report', '\x1b[12;40Rx'],
      ['a key between reports', '\x1b[I\x1b[?62;22cx\x1b[12;40R'],
      ['an arrow key after a focus report', '\x1b[I\x1b[A'],
      ['a paste after a report', '\x1b[12;40R\x1b[200~pasted\x1b[201~'],
      ['Escape', '\x1b'],
    ])('treats %s as user input', async (_name, chunk) => {
      const terminal = new RecordingVirtualTerminal(60, 16);
      const { tui, parts, layout } = await renderShrinkingTasks(terminal);
      terminal.scrollLines(-12);
      await collapseTasks(terminal, tui, parts);
      terminal.takeWrites();

      terminal.scrollLines(Number.MAX_SAFE_INTEGER);
      terminal.sendInput(chunk);
      tui.renderNow();
      await terminal.flush();
      expect(terminal.takeWrites()).toContain('\x1b[3J');
      expect(terminal.getScrollBuffer()).toEqual(logicalDocument(layout, terminal));
    });

    it('replays deferred history before stopping', async () => {
      const terminal = new RecordingVirtualTerminal(60, 16);
      const { tui, parts, layout } = await renderShrinkingTasks(terminal);
      started.splice(started.indexOf(tui), 1);
      terminal.scrollLines(-12);
      await collapseTasks(terminal, tui, parts);
      terminal.takeWrites();
      const expected = logicalDocument(layout, terminal);

      tui.stop();
      await terminal.flush();
      expect(terminal.takeWrites()).toContain('\x1b[3J');
      expect(terminal.getScrollBuffer().slice(0, expected.length).map((line) => line.trimEnd())).toEqual(
        expected.map((line) => line.trimEnd()),
      );
    });

    // #426 follow-up: every other reconstruction without recent input also repaints
    // the screen in place and waits for the next key instead of ED 3 + replay.
    const expectDeferredThenExact = async (
      terminal: RecordingVirtualTerminal,
      tui: TuiMainScreen,
      layout: TuiChatLayout,
      before: { viewport: number; bottom: number },
    ) => {
      // The engine strips OSC 133 zone sentinels before writing rows.
      const document = () =>
        logicalDocument(layout, terminal).map((line) =>
          line.replace(/^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/, '').trimEnd());
      expect(terminal.takeWrites()).not.toContain('\x1b[3J');
      expect(terminal.getScrollPosition().viewport).toBe(before.viewport);
      // The screen below the reader is already current.
      expect(terminal.getScrollBuffer().slice(-terminal.rows).map((line) => line.trimEnd()))
        .toEqual(document().slice(-terminal.rows));

      deliverUserKey(terminal, tui);
      tui.renderNow();
      await terminal.flush();
      expect(terminal.takeWrites()).toContain('\x1b[3J');
      expect(terminal.getScrollBuffer().map((line) => line.trimEnd())).toEqual(document());
      const after = terminal.getScrollPosition();
      expect(after.viewport).toBe(after.bottom);
    };

    it('keeps a scrolled-up reader in place when a scrollback row changes without input', async () => {
      const terminal = new RecordingVirtualTerminal(60, 16);
      const { tui, parts, layout } = await renderShrinkingTasks(terminal);
      terminal.scrollLines(-12);
      const before = terminal.getScrollPosition();
      terminal.takeWrites();

      parts.transcript.lines[3] = 'History 3 (updated)';
      tui.renderNow();
      await terminal.flush();
      // Native history keeps the old text until the deferred replay.
      expect(terminal.getScrollBuffer().map((line) => line.trim())).toContain('History 3');
      await expectDeferredThenExact(terminal, tui, layout, before);
    });

    it('keeps a scrolled-up reader in place when the document shrinks by more than a screen', async () => {
      const terminal = new RecordingVirtualTerminal(60, 16);
      const { tui, parts, layout } = await renderShrinkingTasks(terminal);
      parts.interaction.lines = Array.from({ length: 40 }, (_, index) => `Panel ${index}`);
      tui.renderNow();
      await terminal.flush();
      terminal.scrollLines(-12);
      const before = terminal.getScrollPosition();
      terminal.takeWrites();

      parts.interaction.lines = [];
      tui.renderNow();
      await terminal.flush();
      await expectDeferredThenExact(terminal, tui, layout, before);
    });

    it('keeps a scrolled-up reader in place when a tiny panel updates footer rows in scrollback', async () => {
      const terminal = new RecordingVirtualTerminal(60, 5);
      const { tui, parts, layout } = await renderShrinkingTasks(terminal);
      parts.tasks.lines = ['Task 0 running 10s', 'Task 1', 'Task 2', 'Task 3'];
      tui.renderNow();
      await terminal.flush();
      terminal.scrollLines(-12);
      const before = terminal.getScrollPosition();
      terminal.takeWrites();

      // A periodic footer refresh: the footer is taller than the screen.
      parts.tasks.lines = ['Task 0 running 40s', 'Task 1', 'Task 2', 'Task 3'];
      tui.renderNow();
      await terminal.flush();
      await expectDeferredThenExact(terminal, tui, layout, before);
    });

    it('keeps a scrolled-up reader in place at every turn end of a long session', async () => {
      const terminal = new RecordingVirtualTerminal(60, 16);
      const { tui, parts } = await renderShrinkingTasks(terminal);
      parts.tasks.lines = [];
      deliverUserKey(terminal, tui);
      tui.renderNow();
      await terminal.flush();
      (tui as unknown as { lastUserInputAt: number }).lastUserInputAt = Number.NEGATIVE_INFINITY;
      for (let turn = 0; turn < 3; turn++) {
        parts.followUp.lines = ['Queued follow-up'];
        parts.transcript.lines.push(`Answer ${turn}`);
        tui.renderNow();
        await terminal.flush();
        terminal.scrollLines(Number.MAX_SAFE_INTEGER);
        terminal.scrollLines(-6);
        const before = terminal.getScrollPosition();
        terminal.takeWrites();
        parts.followUp.lines = [];
        tui.renderNow();
        await terminal.flush();
        expect(terminal.takeWrites()).not.toContain('\x1b[3J');
        expect(terminal.getScrollPosition()).toEqual(before);
      }
    });

    it('keeps a scrolled-up reader in place when a queued turn removes the previous run duration', async () => {
      const terminal = new RecordingVirtualTerminal(60, 16);
      const tui = new TuiMainScreen(terminal);
      tui.start();
      started.push(tui);
      const cell = (fields: Partial<Parameters<typeof createTranscriptCell>[0]> & { id: string }) =>
        createTranscriptCell({ kind: 'assistant', status: 'succeeded', content: '', createdAtMs: 1, ...fields });
      let cells = [
        cell({ id: 'user:t1', kind: 'user', content: 'first question', turnId: 't1' }),
        cell({ id: 'a1', content: 'first answer', turnId: 't1' }),
        // TurnProjection keeps only the latest run duration and removes older ones
        // when the next turn begins, after this row has entered native history.
        cell({ id: 'turn-duration:t1', kind: 'turn-duration', durationMs: 4_000, turnId: 't1', ephemeral: true }),
        cell({ id: 'user:t2', kind: 'user', content: 'queued follow-up', turnId: 't2' }),
        cell({ id: 'a2', content: Array.from({ length: 40 }, (_, index) => `second answer ${index}`).join('\n\n'), turnId: 't2' }),
      ];
      const transcript = new TranscriptView(() => cells, { appendOnly: () => true });
      const parts = createMutableChatParts('conversation');
      const layout = new TuiChatLayout(terminal, { ...parts, transcript });
      tui.addChild(layout);
      tui.renderNow();
      await terminal.flush();
      terminal.scrollLines(-12);
      const before = terminal.getScrollPosition();
      terminal.takeWrites();
      expect(terminal.getScrollBuffer().some((line) => line.includes('Completed in 4s'))).toBe(true);

      cells = cells.filter((entry) => entry.id !== 'turn-duration:t1');
      tui.renderNow();
      await terminal.flush();
      await expectDeferredThenExact(terminal, tui, layout, before);
      expect(terminal.getScrollBuffer().some((line) => line.includes('Completed in 4s'))).toBe(false);
    });

    it.each([
      ['a queued follow-up', true],
      ['a goal continuation', false],
    ] as const)('starts %s turn without input without changing native history', async (_name, withPrompt) => {
      const terminal = new RecordingVirtualTerminal(60, 16);
      const tui = new TuiMainScreen(terminal);
      tui.start();
      started.push(tui);
      const store = new TranscriptStore();
      const projection = new TuiTurnProjection({ transcript: store, now: () => 10, onChange: () => undefined });
      const answer = (turnId: string, rows: number) => ({
        type: 'message' as const,
        message: {
          id: `answer:${turnId}`,
          role: 'assistant' as const,
          content: Array.from({ length: rows }, (_, index) => `${turnId} answer ${index}`).join('\n\n'),
          turnId,
        },
      });
      store.upsert({ id: 'user:t1', kind: 'user', status: 'succeeded', content: 'first question', turnId: 't1', createdAtMs: 1 });
      projection.beginTurn('t1', 1);
      projection.applyStreamEvent('t1', answer('t1', 20));
      projection.markTurn('t1', 'succeeded', 4_000);
      // Settled output after the run-duration note, e.g. a background task notice.
      store.upsert({ id: 'local:1', kind: 'final-summary', status: 'succeeded', content: 'Background task finished', ephemeral: true, createdAtMs: 2 });
      const transcript = new TranscriptView(store, { appendOnly: () => true });
      const parts = createMutableChatParts('conversation');
      const layout = new TuiChatLayout(terminal, { ...parts, transcript });
      tui.addChild(layout);
      tui.renderNow();
      await terminal.flush();
      (tui as unknown as { lastUserInputAt: number }).lastUserInputAt = Number.NEGATIVE_INFINITY;
      terminal.scrollLines(-12);
      const before = terminal.getScrollPosition();
      terminal.takeWrites();
      const document = () =>
        logicalDocument(layout, terminal).map((line) =>
          line.replace(/^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/, '').trimEnd());
      const expectHistoryUntouched = () => {
        expect(terminal.takeWrites()).not.toContain('\x1b[3J');
        expect(terminal.getScrollPosition().viewport).toBe(before.viewport);
        expect((tui as unknown as { historyReplayDeferred: boolean }).historyReplayDeferred).toBe(false);
        // No deferred repair is pending: native history is already exact.
        expect(terminal.getScrollBuffer().map((line) => line.trimEnd())).toEqual(document());
      };

      // The next run starts with no key press.
      if (withPrompt) {
        store.upsert({ id: 'user:t2', kind: 'user', status: 'pending', content: 'queued follow-up', turnId: 't2', createdAtMs: 3 });
      }
      projection.beginTurn('t2', 3);
      projection.applyStreamEvent('t2', answer('t2', 20));
      tui.renderNow();
      await terminal.flush();
      expectHistoryUntouched();

      projection.markTurn('t2', 'succeeded', 3_000);
      tui.renderNow();
      await terminal.flush();
      expectHistoryUntouched();
      const history = terminal.getScrollBuffer().join('\n');
      expect(history.match(/Completed in 4s/g)).toHaveLength(1);
      expect(history.match(/Completed in 3s/g)).toHaveLength(1);
    });

    it('logs the pid, the deferral and the changed row shape with PI_DEBUG_REDRAW', async () => {
      const logDirectory = mkdtempSync(path.join(tmpdir(), 'mcode-redraw-'));
      const previous = process.env.PI_DEBUG_REDRAW;
      process.env.PI_DEBUG_REDRAW = '1';
      try {
        const terminal = new RecordingVirtualTerminal(60, 16);
        const tui = new TuiMainScreen(terminal, undefined, logDirectory);
        tui.start();
        started.push(tui);
        const parts = createMutableChatParts('conversation');
        parts.transcript.lines = Array.from({ length: 40 }, (_, index) => `History ${index}`);
        tui.addChild(new TuiChatLayout(terminal, parts));
        tui.renderNow();
        await terminal.flush();
        parts.transcript.lines[3] = 'History 3 (updated)';
        tui.renderNow();
        await terminal.flush();
        deliverUserKey(terminal, tui);
        tui.renderNow();
        await terminal.flush();

        const log = readFileSync(path.join(logDirectory, 'pi-debug.log'), 'utf8');
        expect(log).toContain(`[pid ${process.pid}] fullRender: first render`);
        expect(log).toMatch(/fullRender: firstChanged < viewportTop \(3 < \d+\) .* deferred=yes row=3 old="\s*aaaaaaa 9" new="\s*aaaaaaa 9 \(aaaaaaa\)"/);
        expect(log).toContain('fullRender: deferred history replay after user input');
        expect(log).not.toContain('History');
      } finally {
        if (previous === undefined) delete process.env.PI_DEBUG_REDRAW;
        else process.env.PI_DEBUG_REDRAW = previous;
        rmSync(logDirectory, { recursive: true, force: true });
      }
    });
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

describe('regular-mode retained document', () => {
  it.each([
    ['too few', 3],
    ['too many', 7],
  ])('reconstructs instead of rebasing when %s rows are reported', async (_label, reported) => {
    const terminal = new RecordingVirtualTerminal(40, 8);
    const tui = new TuiMainScreen(terminal);
    let lines = Array.from({ length: 30 }, (_, index) => `row ${index}`);
    let pending = 0;
    tui.addChild({
      render: () => [...lines],
      invalidate: () => undefined,
      takeDiscardedRows: () => {
        const rows = pending;
        pending = 0;
        return rows;
      },
    });
    tui.renderNow();
    await terminal.flush();
    // Drop five rows but report a different count.
    lines = [...lines.slice(5), 'row 30'];
    pending = reported;
    terminal.takeWrites();
    tui.renderNow();
    await terminal.flush();
    // #426: the screen is right at once; without recent input the reconstruction
    // that removes misaligned history waits for the next key (L047).
    expect(terminal.getViewport().map((line) => line.trimEnd())).toEqual(lines.slice(-terminal.rows));
    expect(terminal.takeWrites()).not.toContain('\x1b[3J');
    deliverUserKey(terminal, tui);
    tui.renderNow();
    await terminal.flush();
    const history = terminal.getScrollBuffer().map((line) => line.trimEnd()).filter(Boolean);
    expect(history.slice(-lines.length)).toEqual(lines);
    expect(new Set(history).size).toBe(history.length);
  });

  it('drops final rows already in native history without rewriting it', async () => {
    const terminal = new RecordingVirtualTerminal(60, 12);
    const tui = new TuiMainScreen(terminal);
    const cells: ReturnType<typeof createTranscriptCell>[] = [];
    const transcript = new TranscriptView(() => cells, {
      appendOnly: () => true,
      retainedRows: { high: 60, low: 30 },
    });
    const welcome = new MutableLines();
    welcome.lines = ['BANNER'];
    const empty = new MutableLines();
    const composer = new MutableLines();
    composer.lines = [`composer${CURSOR_MARKER}`];
    const status = new MutableLines();
    status.lines = ['status'];
    const layout = new TuiChatLayout(terminal, {
      surface: () => 'conversation',
      welcome,
      transcript,
      interaction: empty,
      activity: empty,
      followUp: empty,
      composer,
      status,
    });
    tui.addChild(layout);
    const addTurn = (turn: number) => {
      cells.push(
        createTranscriptCell({
          id: `user-${turn}`,
          turnId: `turn-${turn}`,
          kind: 'user',
          status: 'succeeded',
          content: `question ${turn}`,
          createdAtMs: turn * 2,
        }),
        createTranscriptCell({
          id: `answer-${turn}`,
          turnId: `turn-${turn}`,
          kind: 'assistant',
          status: 'succeeded',
          content: `answer ${turn} first\n\nanswer ${turn} second`,
          createdAtMs: turn * 2 + 1,
        }),
      );
    };
    for (let turn = 0; turn < 60; turn += 1) {
      addTurn(turn);
      tui.renderNow();
      await terminal.flush();
    }

    expect(terminal.takeWrites()).not.toContain('\x1b[3J');
    expect(transcript.isTrimmed()).toBe(true);
    expect(layout.render(60).length).toBeLessThan(80);
    const plain = (lines: readonly string[]) =>
      lines.map((line) => line.trim()).filter((line) => line.length > 0);
    const history = plain(terminal.getScrollBuffer());
    const fullTranscript = new TranscriptView(() => cells, {
      maxInitialTurns: 1_000,
      maxProjectedTurns: 1_000,
    })
      .render(58)
      .map((line) => stripVTControlCharacters(line));
    expect(history).toEqual(
      plain(['BANNER', ...fullTranscript, 'composer', 'status']),
    );
  });
});
