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
import { VirtualTerminal } from '../pi-084-upstream/virtual-terminal.js';

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

class MutableLines implements Component {
  lines: string[] = [];

  render(): string[] {
    return [...this.lines];
  }

  invalidate(): void {}
}

describe('MCode Pi Engine local deltas', () => {
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
    expect(terminal.takeWrites()).toContain('\x1b[3J');
    component.lines[0] = '\x1b[1mAnswer line 0\x1b[0m';
    tui.renderNow();
    await terminal.flush();

    expect(terminal.takeWrites()).not.toContain('\x1b[3J');
    expect(terminal.getScrollBuffer()).toEqual([...answer, 'composer', 'status']);
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
        expect(terminal.getViewport()).toEqual(
          component.lines.slice(-terminal.rows).map((line) => line.replace(CURSOR_MARKER, '')),
        );
        expect(terminal.getCursorPosition()).toEqual({ x: 8, y: 42 });
        if (added === 0) expect(terminal.takeWrites()).toContain('\x1b[3J');
        else expect(terminal.takeWrites()).not.toContain('\x1b[3J');
        expect(terminal.getScrollBuffer()).toEqual(
          component.lines.map((line) => line.replace(CURSOR_MARKER, '')),
        );
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

  it('still previews the resized tail and restores ordered scrollback after resize settles', async () => {
    const terminal = new RecordingVirtualTerminal(67, 44);
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
      expect(terminal.takeWrites()).not.toContain('\x1b[3J');
      expect(terminal.getViewport()).toEqual([
        ...Array.from({ length: 29 }, (_, index) => `Answer line ${index + 51}`),
        'composer',
      ]);

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
