import { describe, expect, it, vi } from 'vitest';
import {
  CURSOR_MARKER,
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  stripTerminalSequences,
  TUI_KEYBINDINGS,
  visibleWidth,
} from '../../../../../src/tui/engine/public.js';
import { TuiComposerDraft } from '../../../../../src/tui/features/composer/draft.js';
import { Editor, type EditorOptions } from '../../../../../src/tui/widgets/editor/editor.js';

function createEditor(options: EditorOptions = {}) {
  const ui = {
    terminal: { rows: 24 },
    requestRender: vi.fn(),
  };
  const passthrough = (value: string): string => value;
  const editor = new Editor(
    ui,
    {
      borderColor: passthrough,
      selectList: {
        selectedPrefix: passthrough,
        selectedText: passthrough,
        description: passthrough,
        scrollInfo: passthrough,
        noMatch: passthrough,
      },
    },
    options,
  );
  return { editor, ui };
}

describe('Editor behavior', () => {
  it('restores submitted image elements at their original positions with new runtime identities', () => {
    const { editor } = createEditor();
    editor.focused = true;
    editor.setText('before');
    editor.syncAttachmentPlaceholders([{ id: '/a.png', label: '[Image #1]' }]);
    editor.handleInput('between');
    editor.syncAttachmentPlaceholders([
      { id: '/a.png', label: '[Image #1]' },
      { id: '/b.png', label: '[Image #2]' },
    ]);
    editor.handleInput('after [Image #1]');
    const original = editor.captureDraft();
    const submitted = vi.fn();
    editor.onSubmit = submitted;
    editor.handleInput('\r');
    const content = submitted.mock.calls[0]?.[0] as string;
    editor.restoreMessageDraft(content, [
      { id: 'edit:a', label: '[Image #1]' },
      { id: 'edit:b', label: '[Image #2]' },
    ]);
    expect(editor.getText()).toBe(original.text);
    expect(editor.captureDraft().attachmentPlaceholders?.map(({ id }) => id)).toEqual([
      'edit:a',
      'edit:b',
    ]);
    editor.handleInput('\r');
    expect(submitted.mock.calls[1]?.[0]).toBe(content);
    expect(content).toContain('after [Image #1]');
  });

  it('overrides placeholder per frame without changing draft, history or submitted text', () => {
    const { editor } = createEditor({ paddingX: 1, placeholder: 'Ask Mcode to do anything' });
    editor.focused = true;
    const before = editor.captureDraft();
    const rendered = editor.render(80, 'Ask a side question…').join('\n');

    expect(rendered).toContain(CURSOR_MARKER);
    expect(stripTerminalSequences(rendered)).toContain('Ask a side question…');
    expect(stripTerminalSequences(rendered)).not.toContain('Ask Mcode to do anything');
    expect(editor.captureDraft()).toEqual(before);
    expect(editor.getHistoryEntries()).toEqual([]);
    expect(stripTerminalSequences(editor.render(80).join('\n'))).toContain(
      'Ask Mcode to do anything',
    );

    const submitted: string[] = [];
    editor.onSubmit = (value) => submitted.push(value);
    editor.handleInput('中文');
    expect(
      stripTerminalSequences(editor.render(80, 'Ask a side question…').join('\n')),
    ).not.toContain('Ask a side question…');
    editor.handleInput('\r');
    expect(submitted).toEqual(['中文']);
  });

  it('previews a fresh attachment, dismisses on typing, and previews again on cursor navigation', () => {
    const { editor } = createEditor();
    editor.focused = true;
    editor.syncAttachmentPlaceholders([{ id: '/a.png', label: '[Image #1]' }]);
    expect(editor.getAttachmentPreview()?.id).toBe('/a.png');
    editor.dismissAttachmentPreview();
    expect(editor.getAttachmentPreview()).toBeUndefined();
    editor.handleInput('x');
    expect(editor.getAttachmentPreview()).toBeUndefined();
    editor.handleInput('\x1b[D');
    editor.handleInput('\x1b[D');
    expect(editor.getAttachmentPreview()?.id).toBe('/a.png');
    const onSubmit = vi.fn();
    editor.onSubmit = onSubmit;
    editor.handleInput('\r');
    expect(onSubmit).toHaveBeenCalledWith('x', expect.anything());
    expect(editor.getAttachmentPreview()).toBeUndefined();
    editor.dispose();
  });

  it('hides the preview while typing immediately before an image chip', () => {
    const { editor } = createEditor();
    editor.focused = true;
    editor.syncAttachmentPlaceholders([{ id: '/a.png', label: '[Image #1]' }]);
    editor.handleInput('\x01');
    expect(editor.getAttachmentPreview()?.id).toBe('/a.png');
    editor.handleInput('x');
    expect(editor.getAttachmentPreview()).toBeUndefined();
    editor.handleInput('\x1b[C');
    editor.handleInput('\x1b[D');
    expect(editor.getAttachmentPreview()?.id).toBe('/a.png');
    editor.dispose();
  });

  it('uses attachment identity after relabeling and clears a deleted preview', () => {
    const { editor } = createEditor();
    editor.focused = true;
    editor.syncAttachmentPlaceholders([{ id: '/a.png', label: '[Image #1]' }]);
    editor.syncAttachmentPlaceholders([{ id: '/a.png', label: '[Image #1 1 MB]' }]);
    editor.handleInput('\x1b[D');
    expect(editor.getAttachmentPreview()?.label).toBe('[Image #1 1 MB]');
    editor.handleInput('\x1b[3~');
    expect(editor.getAttachmentPreview()).toBeUndefined();
    editor.dispose();
  });

  it('renders a display-only placeholder until the user starts typing', () => {
    const placeholder = 'Ask Mcode to do anything';
    const { editor } = createEditor({ placeholder });
    editor.focused = true;

    const emptyRender = editor.render(80).join('\n');
    expect(stripTerminalSequences(emptyRender)).toContain(placeholder);
    expect(editor.getText()).toBe('');

    editor.handleInput('R');

    expect(stripTerminalSequences(editor.render(80).join('\n'))).not.toContain(placeholder);
    expect(editor.getText()).toBe('R');
  });

  it('truncates the placeholder inside narrow editor bounds', () => {
    const { editor } = createEditor({ placeholder: 'Ask Mcode to do anything' });

    expect(editor.render(12).every((line) => visibleWidth(line) <= 12)).toBe(true);
  });

  it('publishes Shift+Enter and Ctrl+J as the default newline bindings', () => {
    const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);

    expect(keybindings.getKeys('tui.input.newLine')).toEqual(['shift+enter', 'ctrl+j']);
  });

  it('inserts a newline with Ctrl+J without submitting', () => {
    const { editor } = createEditor();
    const submitted: string[] = [];
    editor.onSubmit = (value) => submitted.push(value);
    editor.setText('first');

    editor.handleInput('\n');

    expect(editor.getText()).toBe('first\n');
    expect(submitted).toEqual([]);
  });

  it.each(['\u001B\r', '\u001B[13;2~', '\u001B[27;2;13~'])(
    'uses Pi newline compatibility for %j',
    (input) => {
      const { editor } = createEditor();
      editor.setText('first');

      editor.handleInput(input);

      expect(editor.getText()).toBe('first\n');
    },
  );

  it('uses the Pi backslash plus Enter fallback when Shift+Enter is unavailable', () => {
    const { editor } = createEditor();
    editor.setText('first\\');

    editor.handleInput('\r');

    expect(editor.getText()).toBe('first\n');
  });

  it.each(['\u001B[32;2u', '\u001B[27;2;32~'])(
    'inserts Shift+Space as a regular space for %j',
    (input) => {
      const { editor } = createEditor();
      editor.setText('a');

      editor.handleInput(input);

      expect(editor.getText()).toBe('a ');
    },
  );

  it('decodes printable modifyOtherKeys input through the Pi decoder', () => {
    const { editor } = createEditor();

    editor.handleInput('\u001B[27;2;65~');

    expect(editor.getText()).toBe('A');
  });

  it.each([
    ['xterm', '\u001B[3;2~'],
    ['legacy', '\u001B[3$'],
    ['Kitty', '\u001B[57426;2u'],
  ])('uses Pi Shift+Delete behavior for %s input', (_terminal, input) => {
    const { editor } = createEditor();
    editor.setText('abc');
    editor.handleInput('\u001B[D');

    editor.handleInput(input);

    expect(editor.getText()).toBe('ab');
  });

  it('supports Pi forward and backward character jump commands', () => {
    const { editor } = createEditor();
    editor.setText('one\ntwo one');
    editor.handleInput('\x01');

    editor.handleInput('\x1d');
    editor.handleInput('o');
    expect(editor.getCursor()).toEqual({ line: 1, col: 2 });

    editor.handleInput('\u001B\x1d');
    editor.handleInput('o');
    expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
  });

  it('keeps product attachment elements atomic while using Pi character jump', () => {
    const { editor } = createEditor();
    editor.setText('prompt');
    editor.syncAttachmentPlaceholders([{ id: '/tmp/image.png', label: '[Image #1]' }]);
    editor.handleInput('\x01');

    editor.handleInput('\x1d');
    editor.handleInput('I');

    expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
    expect(editor.getText()).toBe('prompt [Image #1] ');
  });

  it('uses Pi page commands to move by the visible editor page', () => {
    const { editor, ui } = createEditor();
    ui.terminal.rows = 10;
    editor.setText(Array.from({ length: 12 }, (_, index) => `line-${index}`).join('\n'));
    editor.render(40);

    editor.handleInput('\u001B[5~');
    expect(editor.getCursor().line).toBe(6);
    editor.handleInput('\u001B[6~');
    expect(editor.getCursor().line).toBe(11);
  });

  it('honors Pi dedicated history keybinding overrides', () => {
    const previous = getKeybindings();
    setKeybindings(
      new KeybindingsManager(TUI_KEYBINDINGS, {
        'tui.editor.historyPrevious': 'ctrl+p',
        'tui.editor.historyNext': 'ctrl+n',
      }),
    );
    try {
      const { editor } = createEditor();
      editor.addToHistory('first');
      editor.addToHistory('second');
      editor.setText('draft');

      editor.handleInput('\x10');
      expect(editor.getText()).toBe('second');
      editor.handleInput('\x0e');
      expect(editor.getText()).toBe('draft');
    } finally {
      setKeybindings(previous);
    }
  });

  it('honors Pi selection keybinding overrides inside autocomplete', async () => {
    const previous = getKeybindings();
    setKeybindings(
      new KeybindingsManager(TUI_KEYBINDINGS, {
        'tui.select.up': 'ctrl+p',
        'tui.select.down': 'ctrl+n',
        'tui.select.confirm': 'ctrl+o',
        'tui.select.cancel': 'ctrl+x',
      }),
    );
    try {
      const { editor } = createEditor();
      const selected = vi.fn();
      editor.onAutocompleteSelect = selected;
      editor.setAutocompleteProvider({
        triggerCharacters: ['@'],
        getSuggestions: async () => ({
          prefix: '@',
          items: [
            { value: 'first', label: 'first' },
            { value: 'second', label: 'second' },
          ],
        }),
        applyCompletion: (_lines, _line, _column, item) => ({
          lines: [`@${item.value} `],
          cursorLine: 0,
          cursorCol: item.value.length + 2,
        }),
      });
      editor.handleInput('@');
      await vi.waitFor(() => expect(editor.render(80).join('\n')).toContain('second'));

      editor.handleInput('\x0e');
      editor.handleInput('\x0f');

      expect(selected).toHaveBeenCalledWith(
        expect.objectContaining({ prefix: '@' }),
        expect.objectContaining({ value: 'second' }),
      );
      expect(editor.getText()).toBe('@second ');
    } finally {
      setKeybindings(previous);
    }
  });

  it.each([
    ['modifyOtherKeys', '\u001B[27;2;127~'],
    ['Kitty', '\u001B[127;2u'],
  ])('uses Pi Shift+Backspace behavior for %s input', (_terminal, input) => {
    const { editor } = createEditor();
    editor.setText('abc');

    editor.handleInput(input);

    expect(editor.getText()).toBe('ab');
  });

  it('reports autocomplete menu views once per open menu and selected items', async () => {
    const { editor } = createEditor();
    const onAutocompleteView = vi.fn();
    const onAutocompleteSelect = vi.fn();
    editor.onAutocompleteView = onAutocompleteView;
    editor.onAutocompleteSelect = onAutocompleteSelect;
    editor.setAutocompleteProvider({
      triggerCharacters: ['/'],
      getSuggestions: vi.fn(async () => ({
        prefix: '/',
        items: [{ value: 'help', label: 'help' }],
      })),
      applyCompletion: (_lines) => ({ lines: ['/help '], cursorLine: 0, cursorCol: 6 }),
    });

    editor.handleInput('/');
    await vi.waitFor(() => expect(onAutocompleteView).toHaveBeenCalledOnce());
    editor.handleInput('h');
    await vi.waitFor(() => expect(editor.render(80).join('\n')).toContain('help'));
    expect(onAutocompleteView).toHaveBeenCalledOnce();

    editor.handleInput('\r');
    expect(onAutocompleteSelect).toHaveBeenCalledWith(
      { prefix: '/', items: [{ value: 'help', label: 'help' }] },
      { value: 'help', label: 'help' },
    );
  });

  it('turns a long paste into one pasted-text element that Backspace removes and undo restores', async () => {
    const { editor } = createEditor();
    editor.focused = true;
    const draft = new TuiComposerDraft({
      workspaceDir: '/workspace',
      resolveAttachment: vi.fn(),
      append: vi.fn(),
      onChanged: vi.fn(),
      onAttachmentPlaceholdersChanged: (placeholders) =>
        editor.syncAttachmentPlaceholders(placeholders),
    });
    editor.onPaste = (text) => draft.pasteLongText(text, (value) => editor.pasteInline(value));
    editor.onAttachmentPlaceholderDeleted = (id) => void draft.removeAttachmentById(id);
    editor.onAttachmentPlaceholderRestored = (id) => draft.restoreAttachmentById(id);
    const pasted = `{\n${'  "panel": 1,\n'.repeat(400)}}`;

    editor.handleInput('Summarize ');
    editor.handleInput(`\u001B[200~${pasted}\u001B[201~`);
    await vi.waitFor(() => expect(draft.snapshot().attachments).toHaveLength(1));

    expect(editor.getText()).toBe('Summarize [Pasted text #1 +402 lines] ');
    expect(editor.getExpandedText()).not.toContain('"panel"');
    expect(editor.getAttachmentPreview()?.label).toBe('[Pasted text #1 +402 lines]');

    editor.handleInput('\x7f');
    expect(editor.getText()).toBe('Summarize ');
    expect(draft.snapshot().attachments).toEqual([]);

    editor.handleInput('\x1f');
    expect(editor.getText()).toContain('[Pasted text #1 +402 lines]');
    expect(draft.snapshot().attachments).toHaveLength(1);
    await draft.completeSubmission(draft.capture());
  });

  it('treats a large-paste marker as one atomic segment and restores its registry on undo', () => {
    const { editor } = createEditor();
    const pasted = `${'x'.repeat(1_001)}\nlast`;

    editor.handleInput(`\u001B[200~${pasted}\u001B[201~`);
    const marker = editor.getText();
    expect(marker).toMatch(/^\[paste #1 /u);
    expect(editor.getExpandedText()).toBe(pasted);

    editor.handleInput('\u001B[D');
    expect(editor.getCursor().col).toBe(0);
    editor.handleInput('\u001B[C');
    expect(editor.getCursor().col).toBe(marker.length);
    editor.handleInput('\x7f');

    expect(editor.getText()).toBe('');
    expect(editor.getExpandedText()).toBe('');

    editor.handleInput('\x1f');
    expect(editor.getText()).toBe(marker);
    expect(editor.getExpandedText()).toBe(pasted);
  });

  it('keeps a pasted image placeholder inside a multiline Draft and deletes it atomically', () => {
    const { editor } = createEditor();
    const deleted: string[] = [];
    editor.onAttachmentPlaceholderDeleted = (id) => deleted.push(id);
    editor.setText('first line\nsecond line');
    editor.syncAttachmentPlaceholders([
      { id: '/tmp/image.png', label: '[Image #1]' },
    ]);

    expect(editor.getText()).toContain('second line [Image #1]');
    editor.handleInput('\u001B[D');
    expect(editor.getCursor().col).toBe('second line '.length);
    editor.handleInput('\u001B[C');
    editor.handleInput('\x7f');

    expect(editor.getText().trimEnd()).toBe('first line\nsecond line');
    expect(deleted).toEqual(['/tmp/image.png']);
  });

  it('tracks an attachment element independently from identical user text and restores it on undo', () => {
    const { editor } = createEditor();
    const deleted: string[] = [];
    const restored: string[] = [];
    editor.onAttachmentPlaceholderDeleted = (id) => deleted.push(id);
    editor.onAttachmentPlaceholderRestored = (id) => restored.push(id);
    editor.setText('literal [Image #1] before paste');
    editor.syncAttachmentPlaceholders([{ id: '/tmp/image.png', label: '[Image #1]' }]);

    expect(editor.getText().match(/\[Image #1\]/gu)).toHaveLength(2);
    editor.handleInput('\x7f');

    expect(editor.getText()).toBe('literal [Image #1] before paste');
    expect(deleted).toEqual(['/tmp/image.png']);

    editor.handleInput('\x1f');

    expect(editor.getText().match(/\[Image #1\]/gu)).toHaveLength(2);
    expect(restored).toEqual(['/tmp/image.png']);
  });

  it('preserves identical user text when omitting the owned attachment element on submit', () => {
    const { editor } = createEditor();
    const submitted: string[] = [];
    editor.onSubmit = (value) => submitted.push(value);
    editor.setText('literal [Image #1] before paste');
    editor.syncAttachmentPlaceholders([{ id: '/tmp/image.png', label: '[Image #1]' }]);

    editor.handleInput('\r');

    expect(submitted).toEqual(['literal [Image #1] before paste']);
  });

  it('keeps an attachment element valid when its owned leading space is edited', () => {
    const { editor } = createEditor();
    editor.setText('prompt');
    editor.syncAttachmentPlaceholders([{ id: '/tmp/image.png', label: '[Image #1]' }]);

    editor.handleInput('\u001B[D');
    editor.handleInput('\x7f');
    const snapshot = editor.captureDraft();

    expect(editor.getText()).toBe('prompt[Image #1] ');
    expect(editor.restoreDraft(snapshot)).toBe(true);
  });

  it('keeps attachments visible when replacing the text through an external editor', () => {
    const { editor } = createEditor();
    editor.setText('before');
    editor.syncAttachmentPlaceholders([{ id: '/tmp/image.png', label: '[Image #1]' }]);

    editor.setText('after');

    expect(editor.getText()).toBe('after [Image #1] ');
    expect(editor.captureDraft().attachmentPlaceholders).toEqual([
      expect.objectContaining({ id: '/tmp/image.png', start: 'after '.length }),
    ]);
  });

  it('keeps spacing intact when an earlier attachment is removed', () => {
    const { editor } = createEditor();
    editor.setText('prompt');
    editor.syncAttachmentPlaceholders([
      { id: '/tmp/first.png', label: '[Image #1]' },
      { id: '/tmp/second.png', label: '[Image #2]' },
    ]);

    editor.syncAttachmentPlaceholders([{ id: '/tmp/second.png', label: '[Image #1]' }]);

    expect(editor.getText()).toBe('prompt [Image #1] ');
  });

  it('omits inline image placeholders from submitted prompt text', () => {
    const { editor } = createEditor();
    const submitted: string[] = [];
    editor.onSubmit = (value) => submitted.push(value);
    editor.setText('describe this');
    editor.syncAttachmentPlaceholders([
      { id: '/tmp/image.png', label: '[Image #1]' },
    ]);

    editor.handleInput('\r');

    expect(submitted).toEqual(['describe this']);
  });

  it('passes the complete pre-clear Draft snapshot with a submission', () => {
    const { editor } = createEditor();
    const pasted = `${'a'.repeat(1_001)}\nlast line`;
    editor.handleInput(`\u001B[200~${pasted}\u001B[201~`);
    editor.handleInput(' tail');
    editor.syncAttachmentPlaceholders([
      { id: '/tmp/image.png', label: '[Image #1]' },
    ]);
    editor.handleInput('\u001B[D');
    const expectedDraft = editor.captureDraft();
    const submitted: Array<{ text: string; draft: typeof expectedDraft }> = [];
    editor.onSubmit = (text, draft) => submitted.push({ text, draft });

    editor.handleInput('\r');

    expect(submitted).toEqual([{ text: `${pasted} tail`, draft: expectedDraft }]);
    expect(editor.getText()).toBe('');
  });

  it('restores a failed submission before text entered while the Turn was running', () => {
    const { editor } = createEditor();
    const submittedPaste = `${'a'.repeat(1_001)}\nlast submitted line`;
    editor.handleInput(`\u001B[200~${submittedPaste}\u001B[201~`);
    editor.handleInput(' submitted');
    const submittedDraft = editor.captureDraft();

    editor.setText('new draft');
    editor.restoreSubmittedDraft(submittedDraft);

    expect(editor.getExpandedText()).toBe(`${submittedPaste} submitted\nnew draft`);
    expect(editor.getText()).toContain('[paste #1');
    expect(editor.getCursor()).toEqual({ line: 1, col: 'new draft'.length });
  });

  it('keeps paste references distinct when restoring into a newer pasted Draft', () => {
    const { editor } = createEditor();
    const submittedPaste = 'submitted '.repeat(160);
    editor.handleInput(`\u001B[200~${submittedPaste}\u001B[201~`);
    const submittedDraft = editor.captureDraft();

    editor.setText('');
    const newerPaste = 'newer '.repeat(220);
    editor.handleInput(`\u001B[200~${newerPaste}\u001B[201~`);
    editor.restoreSubmittedDraft(submittedDraft);

    expect(editor.getExpandedText()).toBe(`${submittedPaste}\n${newerPaste}`);
    expect(editor.captureDraft().pastes).toEqual([
      { id: 1, content: submittedPaste },
      { id: 2, content: newerPaste },
    ]);
  });

  it('keeps current attachment elements valid while remapping multiple paste references', () => {
    const { editor } = createEditor();
    const firstMarker = '[paste #1 1100 chars]';
    const attachmentLabel = '[Image #1]';
    const secondMarker = '[paste #2 1200 chars]';
    const currentText = `${firstMarker} ${attachmentLabel} ${secondMarker}`;
    const attachmentStart = firstMarker.length + 1;
    editor.restoreDraft({
      schemaVersion: 1,
      text: currentText,
      cursor: currentText.length,
      pastes: [
        { id: 1, content: 'a'.repeat(1_100) },
        { id: 2, content: 'b'.repeat(1_200) },
      ],
      pasteCounter: 2,
      attachmentPlaceholders: [
        {
          id: '/tmp/current.png',
          label: attachmentLabel,
          start: attachmentStart,
          end: attachmentStart + attachmentLabel.length,
        },
      ],
    });

    editor.restoreSubmittedDraft({
      schemaVersion: 1,
      text: '[paste #1 1300 chars]',
      cursor: 21,
      pastes: [{ id: 1, content: 'c'.repeat(1_300) }],
      pasteCounter: 1,
    });

    expect(editor.captureDraft()).toMatchObject({
      pastes: [{ id: 1 }, { id: 2 }, { id: 3 }],
      attachmentPlaceholders: [
        expect.objectContaining({
          id: '/tmp/current.png',
          label: attachmentLabel,
        }),
      ],
    });
    editor.syncAttachmentPlaceholders([{ id: '/tmp/current.png', label: attachmentLabel }]);
    expect(editor.getText()).toContain(attachmentLabel);
  });

  it('keeps the cursor visible while moving through a long multiline Draft', () => {
    const { editor, ui } = createEditor();
    ui.terminal.rows = 10;
    editor.focused = true;
    editor.setText(Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join('\n'));

    for (let index = 0; index < 19; index += 1) editor.handleInput('\u001B[A');

    expect(editor.getCursor()).toEqual({ line: 0, col: 'line-1'.length });
    const rendered = editor.render(40).join('\n');
    expect(rendered).toContain('line-1');
    expect(rendered).not.toContain('line-20');
  });

  it('resolves editing keys into word, kill, yank and undo commands', () => {
    const { editor } = createEditor();
    editor.setText('alpha beta');

    editor.handleInput('\u001Bb');
    expect(editor.getCursor().col).toBe(6);
    editor.handleInput('\x17');
    expect(editor.getText()).toBe('beta');
    editor.handleInput('\x19');
    expect(editor.getText()).toBe('alpha beta');
    editor.handleInput('\x1f');
    expect(editor.getText()).toBe('beta');
    editor.handleInput('\x1a');
    expect(editor.getText()).toBe('beta');
  });

  it('accumulates consecutive kills and supports yank-pop across the kill ring', () => {
    const { editor } = createEditor();
    editor.setText('one two three');
    editor.handleInput('\x17');
    editor.handleInput('\x17');
    expect(editor.getText()).toBe('one ');
    editor.handleInput('\x19');
    expect(editor.getText()).toBe('one two three');

    editor.setText('alpha beta');
    editor.handleInput('\x17');
    editor.handleInput('\x19');
    expect(editor.getText()).toBe('alpha beta');
    editor.handleInput('\u001By');
    expect(editor.getText()).toBe('alpha two three');
  });

  it('deletes a newline at line end', () => {
    const { editor } = createEditor();

    editor.setText('one\ntwo');
    editor.handleInput('\x01');
    editor.handleInput('\u001B[D');
    editor.handleInput('\x0b');
    expect(editor.getText()).toBe('onetwo');
  });

  it('captures and restores folded paste payloads without expanding the visible Draft', () => {
    const { editor } = createEditor();
    const pasted = `${'a'.repeat(1_001)}\nlast line`;
    editor.handleInput(`\u001B[200~${pasted}\u001B[201~`);
    editor.handleInput(' tail');

    const saved = editor.captureDraft();
    const restored = createEditor().editor;
    expect(restored.restoreDraft(saved)).toBe(true);

    expect(restored.getText()).toBe(editor.getText());
    expect(restored.getExpandedText()).toBe(`${pasted} tail`);
    expect(restored.getCursor()).toEqual(editor.getCursor());
  });

  it('lets the product consume a bracketed paste before it becomes editor text', () => {
    const { editor } = createEditor();
    editor.onPaste = (value) => value.endsWith('.png');

    editor.handleInput('\u001B[200~/tmp/otty-paste/image-123.png\u001B[201~');

    expect(editor.getText()).toBe('');
  });

  it('sanitizes CSI-u controls and terminal sequences at the product Editor boundary', () => {
    const { editor } = createEditor();

    editor.handleInput(
      '\u001B[200~first\u001B[106;5usecond\u001B[31m red\u001B[0m\u001B[201~',
    );

    expect(editor.getText()).toBe('first\nsecond red');
  });

  it('submits normally typed text after Enter', () => {
    const submitted: string[] = [];
    const { editor } = createEditor();
    editor.onSubmit = (value) => submitted.push(value);

    for (const character of 'abcdefgh') {
      editor.handleInput(character);
    }
    editor.handleInput('\r');

    expect(submitted).toEqual(['abcdefgh']);
  });

  it('debounces attachment autocomplete while typing', async () => {
    vi.useFakeTimers();
    const provider = {
      triggerCharacters: ['@'],
      getSuggestions: vi.fn(async () => ({
        prefix: '@mai',
        items: [{ value: '@main.ts', label: 'main.ts' }],
      })),
      applyCompletion: vi.fn(),
    };
    const { editor } = createEditor();
    editor.setAutocompleteProvider(provider);

    editor.handleInput('@');
    editor.handleInput('m');
    editor.handleInput('a');
    editor.handleInput('i');

    expect(provider.getSuggestions).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(provider.getSuggestions).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('cancels autocomplete work when the editor is disposed', async () => {
    let activeSignal: AbortSignal | undefined;
    const provider = {
      getSuggestions: vi.fn(
        (
          _lines: string[],
          _cursorLine: number,
          _cursorCol: number,
          options: { signal: AbortSignal },
        ) => {
          activeSignal = options.signal;
          return new Promise<null>(() => undefined);
        },
      ),
      applyCompletion: vi.fn(),
    };
    const { editor } = createEditor();

    editor.setAutocompleteProvider(provider);
    editor.handleInput('/');
    await Promise.resolve();
    editor.dispose();

    expect(activeSignal?.aborted).toBe(true);
  });
});
