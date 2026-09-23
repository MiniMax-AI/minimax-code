import {
  decodePluginMentions,
  encodePluginMentions,
  transformPluginMentions,
  transformExternalPluginMentions,
  validPluginMentions,
  type EditorPluginMention,
} from './plugin-mentions.js';
import type { AutocompleteProvider, AutocompleteSuggestions } from '../autocomplete.js';
import {
  decodePrintableKey,
  Editor as PiEditor,
  findWordBackward,
  findWordForward,
  getKeybindings,
  matchesKey,
  type Component,
  type EditorOptions as PiEditorOptions,
  type EditorStateSnapshot,
  type EditorTheme,
  type Focusable,
  type TUI,
} from '../../engine/public.js';
import { normalizeComposerPasteText } from './paste.js';

export type EditorOptions = PiEditorOptions;
export type { EditorTheme };

export interface EditorDraftSnapshot extends EditorStateSnapshot {
  readonly attachmentPlaceholders?: readonly EditorAttachmentElement[];
  readonly pluginMentions?: readonly EditorPluginMention[];
}

export interface EditorAttachmentPlaceholder {
  readonly id: string;
  readonly label: string;
}

export interface EditorAttachmentElement extends EditorAttachmentPlaceholder {
  readonly start: number;
  readonly end: number;
  readonly leadingSpace?: boolean;
}

export class Editor implements Component, Focusable {
  onSubmit?: (text: string, draft: EditorDraftSnapshot) => void;
  onChange?: (text: string) => void;
  onPaste?: (text: string) => boolean;
  onAttachmentPlaceholderDeleted?: (id: string) => void;
  onAttachmentPlaceholderRestored?: (id: string) => void;
  onAutocompleteView?: (suggestions: AutocompleteSuggestions) => void;
  onAutocompleteSelect?: (
    suggestions: AutocompleteSuggestions,
    item: AutocompleteSuggestions['items'][number],
  ) => void;

  private readonly engine: PiEditor;
  private pluginMentions: EditorPluginMention[] = [];
  private pendingPluginMention: EditorPluginMention | undefined;
  private pendingPluginState: EditorPluginMention[] | undefined;
  private skipNextPluginTransform = false;
  private lastPluginSubmission: { content: string; transport: string } | undefined;
  private attachmentPlaceholders = new Map<string, EditorAttachmentElement>();
  private bindLegacyAttachmentPlaceholders = false;
  private lastText = '';
  private freshAttachmentPreview: { id: string; cursor: number } | undefined;
  private dismissedAttachmentPreview: { id: string; cursor: number } | undefined;
  private skipNextAttachmentTransform = false;
  private pendingAttachmentElements: Map<string, EditorAttachmentElement> | undefined;
  private pendingSubmission: EditorDraftSnapshot | undefined;
  private lastAttachmentSubmission: { content: string; draft: EditorDraftSnapshot } | undefined;
  private attachmentJumpMode: 'forward' | 'backward' | undefined;

  constructor(
    private readonly tui: Pick<TUI, 'terminal' | 'requestRender'>,
    theme: EditorTheme,
    options: EditorOptions = {},
  ) {
    this.engine = new PiEditor(tui as TUI, theme, {
      ...options,
      transformPaste: normalizeComposerPasteText,
    });
    this.engine.onChange = (text) => this.handleEngineChange(text);
    this.engine.onSubmit = (_text, snapshot) => this.handleEngineSubmit(snapshot);
    this.engine.onPaste = (text) => this.onPaste?.(text) ?? false;
    this.engine.onAutocompleteView = (suggestions) => this.onAutocompleteView?.(suggestions);
    this.engine.onAutocompleteSelect = (suggestions, item) => {
      if ('pluginId' in item && typeof item.pluginId === 'string') {
        const start = this.engine.captureState().cursor - suggestions.prefix.length;
        this.pendingPluginMention = {
          pluginId: item.pluginId,
          label: item.value,
          start,
          end: start + item.value.length,
        };
      }
      this.onAutocompleteSelect?.(suggestions, item);
    };
    this.engine.captureUndoExtensionState = () => ({
      attachments: [...this.attachmentPlaceholders.values()],
      plugins: this.pluginMentions.map((mention) => ({ ...mention })),
    });
    this.engine.restoreUndoExtensionState = (state) => {
      if (!state || typeof state !== 'object' || !('attachments' in state) || !('plugins' in state))
        return;
      this.restoreAttachmentUndoState(state.attachments);
      if (validPluginMentions(this.getText(), state.plugins)) {
        this.pluginMentions = (state.plugins ?? []).map((mention) => ({
          ...mention,
        }));
        this.skipNextPluginTransform = true;
      }
    };
    this.engine.transformHistoryText = (text) => {
      const decoded = decodePluginMentions(text);
      this.pluginMentions = decoded.mentions;
      this.skipNextPluginTransform = true;
      return decoded.text;
    };
  }

  get focused(): boolean {
    return this.engine.focused;
  }

  set focused(value: boolean) {
    this.engine.focused = value;
  }

  get disableSubmit(): boolean {
    return this.engine.disableSubmit;
  }

  set disableSubmit(value: boolean) {
    this.engine.disableSubmit = value;
  }

  get borderColor(): (text: string) => string {
    return this.engine.borderColor;
  }

  set borderColor(value: (text: string) => string) {
    this.engine.borderColor = value;
  }

  setAutocompleteProvider(provider: AutocompleteProvider): void {
    this.engine.setAutocompleteProvider(provider);
  }

  getAutocompleteMaxVisible(): number {
    return this.engine.getAutocompleteMaxVisible();
  }

  setAutocompleteMaxVisible(maxVisible: number): void {
    this.engine.setAutocompleteMaxVisible(maxVisible);
  }

  addToHistory(text: string): void {
    const current = this.captureDraft();
    const transport =
      this.lastPluginSubmission?.content === text.trim()
        ? this.lastPluginSubmission.transport
        : submittedEditorContent(current) === text.trim()
          ? submittedEditorTransport(current)
          : undefined;
    this.engine.addToHistory(transport ?? text);
    this.lastPluginSubmission = undefined;
  }

  getHistoryEntries(): readonly string[] {
    return this.engine.getHistoryEntries();
  }

  getText(): string {
    return this.engine.getText();
  }

  getExpandedText(): string {
    return this.engine.getExpandedText();
  }

  getLines(): string[] {
    return this.engine.getLines();
  }

  getCursor(): { line: number; col: number } {
    return this.engine.getCursor();
  }

  captureDraft(): EditorDraftSnapshot {
    return {
      ...this.engine.captureState(),
      pluginMentions: this.pluginMentions.map((mention) => ({ ...mention })),
      attachmentPlaceholders: [...this.attachmentPlaceholders.values()].map((element) => ({
        ...element,
      })),
    };
  }

  restoreDraft(snapshot: EditorDraftSnapshot): boolean {
    if (!isValidEditorDraftSnapshot(snapshot)) return false;
    const previous = this.attachmentPlaceholders;
    const previousPlugins = this.pluginMentions;
    this.pluginMentions = (snapshot.pluginMentions ?? []).map((mention) => ({
      ...mention,
    }));
    this.skipNextPluginTransform = true;
    this.attachmentPlaceholders = new Map(
      (snapshot.attachmentPlaceholders ?? []).map((element) => [element.id, { ...element }]),
    );
    this.bindLegacyAttachmentPlaceholders = snapshot.attachmentPlaceholders === undefined;
    this.pendingSubmission = undefined;
    this.skipNextAttachmentTransform = true;
    const restored = this.engine.restoreState(snapshot);
    if (!restored) {
      this.attachmentPlaceholders = previous;
      this.pluginMentions = previousPlugins;
      this.skipNextPluginTransform = false;
      this.skipNextAttachmentTransform = false;
    }
    return restored;
  }

  restoreSubmittedDraft(snapshot: EditorDraftSnapshot): boolean {
    if (!isValidEditorDraftSnapshot(snapshot)) return false;
    const current = this.captureDraft();
    if (!current.text) return this.restoreDraft(snapshot);
    if (!snapshot.text) return true;

    const remappedCurrent = remapEditorDraftPastes(current, snapshot.pasteCounter);
    const separator = '\n';
    const currentOffset = snapshot.text.length + separator.length;
    const submittedAttachmentIds = new Set(
      (snapshot.attachmentPlaceholders ?? []).map(({ id }) => id),
    );
    return this.restoreDraft({
      schemaVersion: 1,
      text: `${snapshot.text}${separator}${remappedCurrent.text}`,
      cursor: currentOffset + remappedCurrent.cursor,
      pastes: [...snapshot.pastes.map((paste) => ({ ...paste })), ...remappedCurrent.pastes],
      pasteCounter: remappedCurrent.pasteCounter,
      pluginMentions: [
        ...(snapshot.pluginMentions ?? []).map((mention) => ({ ...mention })),
        ...(remappedCurrent.pluginMentions ?? []).map((mention) => ({
          ...mention,
          start: mention.start + currentOffset,
          end: mention.end + currentOffset,
        })),
      ],
      attachmentPlaceholders: [
        ...(snapshot.attachmentPlaceholders ?? []).map((element) => ({
          ...element,
        })),
        ...(remappedCurrent.attachmentPlaceholders ?? [])
          .filter(({ id }) => !submittedAttachmentIds.has(id))
          .map((element) => ({
            ...element,
            start: element.start + currentOffset,
            end: element.end + currentOffset,
          })),
      ],
    });
  }

  restoreMessageDraft(content: string, placeholders: readonly EditorAttachmentPlaceholder[]): void {
    const existing = [...this.attachmentPlaceholders.values()];
    const previous = this.lastAttachmentSubmission;
    const elements = previous?.draft.attachmentPlaceholders ?? [];
    if (previous?.content === content.trim() && elements.length === placeholders.length) {
      this.restoreDraft({
        ...previous.draft,
        attachmentPlaceholders: elements.flatMap((element, index) => {
          const placeholder = placeholders[index];
          return placeholder ? [{ ...element, id: placeholder.id }] : [];
        }),
      });
    } else {
      this.setText(content);
    }
    this.syncAttachmentPlaceholders([...placeholders, ...existing]);
    this.dismissAttachmentPreview();
  }

  insertTextAtCursor(text: string): void {
    this.engine.insertTextAtCursor(text);
    this.dismissAttachmentPreview();
  }

  getAttachmentPreview(): EditorAttachmentPlaceholder | undefined {
    if (!this.focused) return undefined;
    const cursor = this.engine.captureState().cursor;
    const element =
      [...this.attachmentPlaceholders.values()].find(
        (item) => cursor >= item.start && cursor <= item.end,
      ) ??
      (this.freshAttachmentPreview?.cursor === cursor
        ? this.attachmentPlaceholders.get(this.freshAttachmentPreview.id)
        : undefined);
    if (!element || !attachmentElementMatches(this.getText(), element)) return undefined;
    if (
      this.dismissedAttachmentPreview?.id === element.id &&
      this.dismissedAttachmentPreview.cursor === cursor
    )
      return undefined;
    return element;
  }

  dismissAttachmentPreview(): void {
    const preview = this.getAttachmentPreview();
    if (!preview) return;
    this.dismissedAttachmentPreview = {
      id: preview.id,
      cursor: this.engine.captureState().cursor,
    };
    this.freshAttachmentPreview = undefined;
    this.tui.requestRender();
  }

  syncAttachmentPlaceholders(placeholders: readonly EditorAttachmentPlaceholder[]): void {
    const added = placeholders.filter(({ id }) => !this.attachmentPlaceholders.has(id)).at(-1);
    const next = new Map(placeholders.map(({ id, label }) => [id, label]));
    let text = this.getText();
    let cursor = this.engine.captureState().cursor;
    let changed = false;
    const elements = cloneAttachmentElements(this.attachmentPlaceholders);
    let pluginMentions = this.pluginMentions.map((mention) => ({ ...mention }));
    if (this.bindLegacyAttachmentPlaceholders) {
      const claimedRanges: Array<{ start: number; end: number }> = [];
      for (const [id, label] of next) {
        if (elements.has(id)) continue;
        const start = text.indexOf(label);
        const end = start + label.length;
        if (start >= 0 && !claimedRanges.some((range) => start < range.end && end > range.start)) {
          elements.set(id, { id, label, start, end, leadingSpace: false });
          claimedRanges.push({ start, end });
        }
      }
      this.bindLegacyAttachmentPlaceholders = false;
    }
    const replaceRange = (
      start: number,
      end: number,
      replacement: string,
      target?: { id: string; label: string },
    ): void => {
      const nextText = `${text.slice(0, start)}${replacement}${text.slice(end)}`;
      pluginMentions = transformPluginMentions(text, nextText, pluginMentions);
      text = nextText;
      if (cursor > end) cursor += replacement.length - (end - start);
      else if (cursor > start) cursor = start + replacement.length;
      const delta = replacement.length - (end - start);
      for (const [id, element] of elements) {
        if (id === target?.id) {
          elements.set(id, {
            ...element,
            label: target.label,
            start,
            end: start + replacement.length,
          });
        } else if (element.end <= start) {
          continue;
        } else if (element.start >= end) {
          const nextStart = element.start + delta;
          elements.set(id, {
            ...element,
            start: nextStart,
            end: element.end + delta,
            leadingSpace: element.leadingSpace === true && text[nextStart - 1] === ' ',
          });
        } else {
          elements.delete(id);
        }
      }
      changed = true;
    };

    for (const [id, element] of [...elements]) {
      if (next.has(id)) continue;
      elements.delete(id);
      replaceRange(attachmentElementStart(text, element), attachmentElementEnd(text, element), '');
    }

    for (const [id, label] of next) {
      const element = elements.get(id);
      if (!element || element.label === label) continue;
      replaceRange(element.start, element.end, label, { id, label });
    }

    for (const [id, label] of next) {
      if (elements.has(id)) continue;
      const prefix = cursor > 0 && !/\s/u.test(text[cursor - 1] ?? '') ? ' ' : '';
      const insertion = `${prefix}${label} `;
      const insertionStart = cursor;
      replaceRange(insertionStart, insertionStart, insertion);
      const start = insertionStart + prefix.length;
      elements.set(id, {
        id,
        label,
        start,
        end: start + label.length,
        leadingSpace: prefix.length > 0,
      });
      cursor = insertionStart + insertion.length;
    }

    for (const [id] of [...elements].sort(([, left], [, right]) => left.start - right.start)) {
      const element = elements.get(id);
      if (!element || element.start === 0 || /\s/u.test(text[element.start - 1] ?? '')) continue;
      replaceRange(element.start, element.start, ' ');
      const shifted = elements.get(id);
      if (shifted) elements.set(id, { ...shifted, leadingSpace: true });
    }

    if (!changed) {
      this.attachmentPlaceholders = elements;
      this.tui.requestRender();
      return;
    }
    this.pendingAttachmentElements = elements;
    this.pendingPluginState = pluginMentions;
    this.skipNextAttachmentTransform = true;
    this.engine.replaceRange(0, this.getText().length, text, cursor);
    if (added) {
      this.freshAttachmentPreview = {
        id: added.id,
        cursor: this.engine.captureState().cursor,
      };
      this.dismissedAttachmentPreview = undefined;
    }
  }

  pruneMissingAttachmentPlaceholders(): void {
    const removed = [...this.attachmentPlaceholders].filter(
      ([, element]) => !attachmentElementMatches(this.getText(), element),
    );
    for (const [id] of removed) this.attachmentPlaceholders.delete(id);
    for (const [id] of removed) this.onAttachmentPlaceholderDeleted?.(id);
  }

  setText(text: string): void {
    const decoded = decodePluginMentions(text.replace(/\r\n?/gu, '\n'));
    const value = decoded.text;
    const replaced = appendAttachmentElements(value, this.attachmentPlaceholders);
    if (replaced.text === this.getText()) {
      if (text !== value) {
        this.pluginMentions = decoded.mentions;
        this.onChange?.(this.getText());
      }
      return;
    }
    this.pendingPluginMention = undefined;
    this.pendingPluginState = decoded.mentions;
    this.pendingAttachmentElements = replaced.elements;
    this.skipNextAttachmentTransform = true;
    this.engine.replaceRange(0, this.getText().length, replaced.text, replaced.cursor);
  }

  replaceTextUndoable(text: string): void {
    // External editors edit expanded visible text, while setText loads a new draft.
    const draft = this.captureDraft();
    const previous = decodePluginMentions(
      expandDraftPastes(encodePluginMentions(draft.text, this.pluginMentions), draft.pastes),
    );
    const normalized = text.replace(/\r\n?/gu, '\n');
    const mentions = transformExternalPluginMentions(previous.text, normalized, previous.mentions);
    this.setText(encodePluginMentions(normalized, mentions));
  }

  invalidate(): void {
    this.engine.invalidate();
  }

  render(width: number, placeholder?: string): string[] {
    return this.engine.render(width, placeholder);
  }

  handleInput(data: string): void {
    this.freshAttachmentPreview = undefined;
    this.dismissedAttachmentPreview = undefined;
    const beforeText = this.getText();
    this.handleEditorInput(data);
    if (this.getText() !== beforeText) this.dismissAttachmentPreview();
  }

  private handleEditorInput(data: string): void {
    if (this.handleAttachmentJump(data) || this.handleAtomicAttachmentInput(data)) return;
    const beforeCursor = this.engine.captureState().cursor;
    const maySubmit = getKeybindings().matches(data, 'tui.input.submit');
    if (maySubmit && !this.disableSubmit) this.pendingSubmission = this.captureDraft();
    this.engine.handleInput(data);
    this.snapCursorOutsideAttachment(beforeCursor);
    if (this.pendingSubmission && this.getText() !== '') this.pendingSubmission = undefined;
  }

  submit(): boolean {
    if (this.disableSubmit) return false;
    this.pendingSubmission = this.captureDraft();
    this.engine.submit();
    return true;
  }

  dispose(): void {
    this.engine.dispose();
    this.attachmentPlaceholders.clear();
    this.pluginMentions = [];
    this.pendingSubmission = undefined;
    this.lastAttachmentSubmission = undefined;
    this.onAttachmentPlaceholderDeleted = undefined;
    this.onAttachmentPlaceholderRestored = undefined;
  }

  private handleEngineChange(text: string): void {
    if (this.pendingPluginState) {
      this.pluginMentions = this.pendingPluginState;
      this.pendingPluginState = undefined;
    } else if (this.skipNextPluginTransform) this.skipNextPluginTransform = false;
    else this.pluginMentions = transformPluginMentions(this.lastText, text, this.pluginMentions);
    if (this.pendingPluginMention) {
      if (
        text.slice(this.pendingPluginMention.start, this.pendingPluginMention.end) ===
        this.pendingPluginMention.label
      )
        this.pluginMentions.push(this.pendingPluginMention);
      this.pendingPluginMention = undefined;
    }
    if (this.pendingSubmission && text === '') {
      this.pluginMentions = [];
      this.attachmentPlaceholders.clear();
      this.lastText = '';
      this.skipNextAttachmentTransform = false;
      this.onChange?.('');
      return;
    }
    if (this.skipNextAttachmentTransform) {
      this.skipNextAttachmentTransform = false;
      if (this.pendingAttachmentElements) {
        this.attachmentPlaceholders = this.pendingAttachmentElements;
        this.pendingAttachmentElements = undefined;
      }
      this.lastText = text;
      this.onChange?.(text);
      return;
    }
    const transformed = transformAttachmentElements(
      this.lastText,
      text,
      this.attachmentPlaceholders,
    );
    this.attachmentPlaceholders = transformed.elements;
    this.lastText = text;
    this.onChange?.(text);
    for (const id of transformed.deletedIds) this.onAttachmentPlaceholderDeleted?.(id);
  }

  private handleEngineSubmit(snapshot: EditorStateSnapshot): void {
    const draft: EditorDraftSnapshot = {
      ...snapshot,
      pluginMentions: this.pendingSubmission?.pluginMentions?.map((mention) => ({ ...mention })),
      attachmentPlaceholders: (this.pendingSubmission?.attachmentPlaceholders ?? []).map(
        (element) => ({ ...element }),
      ),
    };
    this.pendingSubmission = undefined;
    const content = submittedEditorContent(draft);
    const transport = submittedEditorTransport(draft);
    this.lastPluginSubmission = transport ? { content, transport } : undefined;
    if (draft.attachmentPlaceholders?.length) this.lastAttachmentSubmission = { content, draft };
    this.onSubmit?.(content, draft);
  }

  private restoreAttachmentUndoState(state: unknown): void {
    if (!Array.isArray(state)) return;
    const previousIds = new Set(this.attachmentPlaceholders.keys());
    const restored = new Map<string, EditorAttachmentElement>();
    for (const candidate of state) {
      if (!isEditorAttachmentElement(candidate)) return;
      restored.set(candidate.id, { ...candidate });
    }
    const restoredIds = new Set(restored.keys());
    this.attachmentPlaceholders = restored;
    this.skipNextAttachmentTransform = true;
    for (const id of previousIds) {
      if (!restoredIds.has(id)) this.onAttachmentPlaceholderDeleted?.(id);
    }
    for (const id of restoredIds) {
      if (!previousIds.has(id)) this.onAttachmentPlaceholderRestored?.(id);
    }
  }

  private atomicElements(): EditorAttachmentElement[] {
    return [
      ...this.attachmentPlaceholders.values(),
      ...this.pluginMentions.map((mention) => ({
        ...mention,
        id: `plugin:${mention.start}`,
      })),
    ];
  }

  private handleAtomicAttachmentInput(data: string): boolean {
    if (this.atomicElements().length === 0) return false;
    const command = resolveAttachmentCommand(data);
    if (!command || command === 'jump-forward' || command === 'jump-backward') return false;
    const snapshot = this.engine.captureState();
    const cursor = snapshot.cursor;
    const text = snapshot.text;
    const elements = this.atomicElements();
    if (command === 'left' || command === 'word-left') {
      const element = elements.find(
        (candidate) => cursor > candidate.start && cursor <= attachmentElementEnd(text, candidate),
      );
      if (!element) return false;
      this.engine.setCursorOffset(element.start);
      return true;
    }
    if (command === 'right' || command === 'word-right') {
      const element = elements.find(
        (candidate) => cursor >= candidate.start && cursor < attachmentElementEnd(text, candidate),
      );
      if (!element) return false;
      this.engine.setCursorOffset(attachmentElementEnd(text, element));
      return true;
    }

    const range = editorDeletionRange(text, cursor, command);
    const intersecting = elements.filter(
      (element) => range.start < attachmentElementEnd(text, element) && range.end > element.start,
    );
    if (intersecting.length === 0) return false;
    const start = Math.min(
      range.start,
      ...intersecting.map((element) => attachmentElementStart(text, element)),
    );
    const end = Math.max(
      range.end,
      ...intersecting.map((element) => attachmentElementEnd(text, element)),
    );
    this.engine.replaceRange(start, end, '');
    return true;
  }

  private handleAttachmentJump(data: string): boolean {
    if (this.attachmentJumpMode) {
      const printable = decodePrintableKey(data) ?? printableText(data);
      const direction = this.attachmentJumpMode;
      this.attachmentJumpMode = undefined;
      if (!printable) return false;
      this.jumpOutsideAttachments(printable, direction);
      return true;
    }
    if (this.atomicElements().length === 0) return false;
    const command = resolveAttachmentCommand(data);
    if (command !== 'jump-forward' && command !== 'jump-backward') return false;
    this.attachmentJumpMode = command === 'jump-forward' ? 'forward' : 'backward';
    return true;
  }

  private jumpOutsideAttachments(character: string, direction: 'forward' | 'backward'): void {
    const snapshot = this.engine.captureState();
    let from = direction === 'forward' ? snapshot.cursor + 1 : snapshot.cursor - 1;
    while (from >= 0 && from < snapshot.text.length) {
      const target =
        direction === 'forward'
          ? snapshot.text.indexOf(character, from)
          : snapshot.text.lastIndexOf(character, from);
      if (target < 0) return;
      const element = this.atomicElements().find(
        (candidate) => target >= candidate.start && target < candidate.end,
      );
      if (!element) {
        this.engine.setCursorOffset(target);
        return;
      }
      from =
        direction === 'forward' ? attachmentElementEnd(snapshot.text, element) : element.start - 1;
    }
  }

  private snapCursorOutsideAttachment(previousCursor: number): void {
    const snapshot = this.engine.captureState();
    const element = this.atomicElements().find(
      (candidate) => snapshot.cursor > candidate.start && snapshot.cursor < candidate.end,
    );
    if (!element) return;
    this.engine.setCursorOffset(snapshot.cursor <= previousCursor ? element.start : element.end);
  }
}

type AttachmentCommand =
  | 'left'
  | 'right'
  | 'word-left'
  | 'word-right'
  | 'delete-backward'
  | 'delete-forward'
  | 'delete-word-backward'
  | 'delete-word-forward'
  | 'delete-line-start'
  | 'delete-line-end'
  | 'jump-forward'
  | 'jump-backward';

function resolveAttachmentCommand(data: string): AttachmentCommand | undefined {
  const keybindings = getKeybindings();
  const commands: ReadonlyArray<
    readonly [Parameters<typeof keybindings.matches>[1], AttachmentCommand]
  > = [
    ['tui.editor.cursorLeft', 'left'],
    ['tui.editor.cursorRight', 'right'],
    ['tui.editor.cursorWordLeft', 'word-left'],
    ['tui.editor.cursorWordRight', 'word-right'],
    ['tui.editor.deleteCharBackward', 'delete-backward'],
    ['tui.editor.deleteCharForward', 'delete-forward'],
    ['tui.editor.deleteWordBackward', 'delete-word-backward'],
    ['tui.editor.deleteWordForward', 'delete-word-forward'],
    ['tui.editor.deleteToLineStart', 'delete-line-start'],
    ['tui.editor.deleteToLineEnd', 'delete-line-end'],
    ['tui.editor.jumpForward', 'jump-forward'],
    ['tui.editor.jumpBackward', 'jump-backward'],
  ];
  for (const [keybinding, command] of commands) {
    if (keybindings.matches(data, keybinding)) return command;
  }
  if (matchesKey(data, 'shift+backspace')) return 'delete-backward';
  if (matchesKey(data, 'shift+delete')) return 'delete-forward';
  return undefined;
}

function editorDeletionRange(
  text: string,
  cursor: number,
  command: Exclude<
    AttachmentCommand,
    'left' | 'right' | 'word-left' | 'word-right' | 'jump-forward' | 'jump-backward'
  >,
): { start: number; end: number } {
  if (command === 'delete-backward')
    return { start: previousGraphemeIndex(text, cursor), end: cursor };
  if (command === 'delete-forward') return { start: cursor, end: nextGraphemeIndex(text, cursor) };
  if (command === 'delete-word-backward')
    return { start: findWordBackward(text, cursor), end: cursor };
  if (command === 'delete-word-forward') {
    return {
      start: cursor,
      end: text[cursor] === '\n' ? cursor + 1 : findWordForward(text, cursor),
    };
  }
  if (command === 'delete-line-start') {
    return {
      start: text.lastIndexOf('\n', Math.max(0, cursor - 1)) + 1,
      end: cursor,
    };
  }
  const lineEnd = text.indexOf('\n', cursor);
  return {
    start: cursor,
    end: lineEnd < 0 ? text.length : lineEnd === cursor ? lineEnd + 1 : lineEnd,
  };
}

function previousGraphemeIndex(text: string, cursor: number): number {
  return (
    [
      ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text.slice(0, cursor)),
    ].at(-1)?.index ?? 0
  );
}

function nextGraphemeIndex(text: string, cursor: number): number {
  const segment = [
    ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text.slice(cursor)),
  ][0]?.segment;
  return segment ? cursor + segment.length : cursor;
}

function isValidEditorDraftSnapshot(snapshot: EditorDraftSnapshot): boolean {
  if (
    !snapshot ||
    snapshot.schemaVersion !== 1 ||
    typeof snapshot.text !== 'string' ||
    !validPluginMentions(snapshot.text, snapshot.pluginMentions) ||
    !Number.isInteger(snapshot.cursor) ||
    snapshot.cursor < 0 ||
    snapshot.cursor > snapshot.text.length ||
    !Number.isInteger(snapshot.pasteCounter) ||
    snapshot.pasteCounter < 0 ||
    !Array.isArray(snapshot.pastes) ||
    (snapshot.attachmentPlaceholders !== undefined &&
      !Array.isArray(snapshot.attachmentPlaceholders))
  ) {
    return false;
  }
  const pasteIds = new Set<number>();
  if (
    !snapshot.pastes.every(({ id, content }) => {
      if (
        !Number.isInteger(id) ||
        id <= 0 ||
        id > snapshot.pasteCounter ||
        pasteIds.has(id) ||
        typeof content !== 'string'
      ) {
        return false;
      }
      pasteIds.add(id);
      return true;
    })
  ) {
    return false;
  }
  const attachmentIds = new Set<string>();
  const ranges: Array<{ start: number; end: number }> = [];
  return (snapshot.attachmentPlaceholders ?? []).every((element) => {
    if (
      !isEditorAttachmentElement(element) ||
      attachmentIds.has(element.id) ||
      element.end > snapshot.text.length ||
      snapshot.text.slice(element.start, element.end) !== element.label ||
      (element.leadingSpace === true && snapshot.text[element.start - 1] !== ' ') ||
      ranges.some(
        (range) =>
          attachmentElementStart(snapshot.text, element) < range.end && element.end > range.start,
      )
    ) {
      return false;
    }
    attachmentIds.add(element.id);
    ranges.push({
      start: attachmentElementStart(snapshot.text, element),
      end: element.end,
    });
    return true;
  });
}

function isEditorAttachmentElement(value: unknown): value is EditorAttachmentElement {
  if (!value || typeof value !== 'object') return false;
  const element = value as Partial<EditorAttachmentElement>;
  return (
    typeof element.id === 'string' &&
    element.id.length > 0 &&
    typeof element.label === 'string' &&
    element.label.length > 0 &&
    Number.isInteger(element.start) &&
    Number.isInteger(element.end) &&
    (element.start ?? -1) >= 0 &&
    (element.end ?? 0) > (element.start ?? -1) &&
    (element.leadingSpace === undefined || typeof element.leadingSpace === 'boolean')
  );
}

function remapEditorDraftPastes(
  draft: EditorDraftSnapshot,
  startingCounter: number,
): EditorDraftSnapshot {
  const replacements = [...draft.text.matchAll(PASTE_MARKER_PATTERN)]
    .flatMap((match) => {
      const id = Number(match[1]);
      const paste = draft.pastes.find((candidate) => candidate.id === id);
      if (!paste || match.index === undefined) return [];
      return [
        {
          start: match.index,
          end: match.index + match[0].length,
          paste,
          marker: match[0],
        },
      ];
    })
    .map((replacement, index) => {
      const id = startingCounter + index + 1;
      return {
        ...replacement,
        id,
        text: replacement.marker.replace(`#${String(replacement.paste.id)}`, `#${String(id)}`),
      };
    });
  const shiftPosition = (position: number) =>
    position +
    replacements
      .filter(({ end }) => end <= position)
      .reduce(
        (delta, replacement) => delta + replacement.text.length - replacement.marker.length,
        0,
      );
  let text = draft.text;
  for (const replacement of [...replacements].reverse()) {
    text = `${text.slice(0, replacement.start)}${replacement.text}${text.slice(replacement.end)}`;
  }
  return {
    schemaVersion: 1,
    text,
    cursor: shiftPosition(draft.cursor),
    pastes: replacements.map(({ id, paste }) => ({
      id,
      content: paste.content,
    })),
    pasteCounter: startingCounter + replacements.length,
    pluginMentions: draft.pluginMentions?.map((mention) => ({
      ...mention,
      start: shiftPosition(mention.start),
      end: shiftPosition(mention.end),
    })),
    attachmentPlaceholders: (draft.attachmentPlaceholders ?? []).map((element) => ({
      ...element,
      start: shiftPosition(element.start),
      end: shiftPosition(element.end),
    })),
  };
}

function cloneAttachmentElements(
  elements: ReadonlyMap<string, EditorAttachmentElement>,
): Map<string, EditorAttachmentElement> {
  return new Map([...elements].map(([id, element]) => [id, { ...element }]));
}

function attachmentElementMatches(text: string, element: EditorAttachmentElement): boolean {
  return text.slice(element.start, element.end) === element.label;
}

function attachmentElementStart(text: string, element: EditorAttachmentElement): number {
  return element.leadingSpace === true && text[element.start - 1] === ' '
    ? element.start - 1
    : element.start;
}

function attachmentElementEnd(text: string, element: EditorAttachmentElement): number {
  return element.end + (text[element.end] === ' ' ? 1 : 0);
}

function appendAttachmentElements(
  text: string,
  elements: ReadonlyMap<string, EditorAttachmentElement>,
): {
  text: string;
  cursor: number;
  elements: Map<string, EditorAttachmentElement>;
} {
  let output = text;
  let cursor = output.length;
  const appended = new Map<string, EditorAttachmentElement>();
  for (const [id, element] of elements) {
    const prefix = cursor > 0 && !/\s/u.test(output[cursor - 1] ?? '') ? ' ' : '';
    const start = cursor + prefix.length;
    output = `${output}${prefix}${element.label} `;
    appended.set(id, {
      id,
      label: element.label,
      start,
      end: start + element.label.length,
      leadingSpace: prefix.length > 0,
    });
    cursor = output.length;
  }
  return { text: output, cursor, elements: appended };
}

export function submittedEditorContent(draft: EditorDraftSnapshot): string {
  const visibleText = removeAttachmentElements(draft.text, draft.attachmentPlaceholders ?? []);
  return expandDraftPastes(visibleText, draft.pastes).trim();
}

/** Serialize identity bindings into the existing durable user-text transport. */
export function submittedEditorTransport(draft: EditorDraftSnapshot): string | undefined {
  if (!draft.pluginMentions?.length) return undefined;
  let text = draft.text;
  const replacements = [
    ...draft.pluginMentions.map((mention) => ({
      start: mention.start,
      end: mention.end,
      text: encodePluginMentions(mention.label, [
        { ...mention, start: 0, end: mention.label.length },
      ]),
    })),
    ...(draft.attachmentPlaceholders ?? []).map((element) => ({
      start: attachmentElementStart(text, element),
      end: attachmentElementEnd(text, element),
      text: '',
    })),
  ].sort((a, b) => b.start - a.start);
  for (const replacement of replacements)
    text = text.slice(0, replacement.start) + replacement.text + text.slice(replacement.end);
  return expandDraftPastes(text, draft.pastes).trim();
}

function removeAttachmentElements(
  text: string,
  elements: readonly EditorAttachmentElement[],
): string {
  let output = text;
  const ranges = elements
    .filter((element) => attachmentElementMatches(text, element))
    .map((element) => ({
      start: attachmentElementStart(text, element),
      end: attachmentElementEnd(text, element),
    }))
    .sort((left, right) => right.start - left.start);
  for (const range of ranges) output = `${output.slice(0, range.start)}${output.slice(range.end)}`;
  return output;
}

function transformAttachmentElements(
  previous: string,
  next: string,
  elements: ReadonlyMap<string, EditorAttachmentElement>,
): { elements: Map<string, EditorAttachmentElement>; deletedIds: Set<string> } {
  const output = new Map<string, EditorAttachmentElement>();
  const deletedIds = new Set<string>();
  const change = changedTextRange(previous, next);
  if (!change) return { elements: cloneAttachmentElements(elements), deletedIds };
  const delta = change.nextEnd - change.previousEnd;
  for (const [id, element] of elements) {
    if (element.end <= change.start) {
      output.set(id, { ...element });
      continue;
    }
    if (element.start >= change.previousEnd) {
      const start = element.start + delta;
      output.set(id, {
        ...element,
        start,
        end: element.end + delta,
        leadingSpace: element.leadingSpace === true && next[start - 1] === ' ',
      });
      continue;
    }
    deletedIds.add(id);
  }
  return { elements: output, deletedIds };
}

function changedTextRange(
  previous: string,
  next: string,
): { start: number; previousEnd: number; nextEnd: number } | undefined {
  if (previous === next) return undefined;
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start])
    start += 1;
  let previousEnd = previous.length;
  let nextEnd = next.length;
  while (
    previousEnd > start &&
    nextEnd > start &&
    previous[previousEnd - 1] === next[nextEnd - 1]
  ) {
    previousEnd -= 1;
    nextEnd -= 1;
  }
  return { start, previousEnd, nextEnd };
}

function expandDraftPastes(text: string, pastes: EditorDraftSnapshot['pastes']): string {
  let output = text;
  for (const { id, content } of pastes) {
    output = output.replace(
      new RegExp(`\\[paste #${id}(?: (?:\\+\\d+ lines|\\d+ chars))?\\]`, 'gu'),
      () => content,
    );
  }
  return output;
}

function printableText(data: string): string | undefined {
  if (!data || data.includes('\u001B')) return undefined;
  return [...data].every((value) => {
    const codepoint = value.codePointAt(0) ?? 0;
    return codepoint >= 32 && codepoint !== 127;
  })
    ? data
    : undefined;
}

const PASTE_MARKER_PATTERN = /\[paste #(\d+)(?: (?:\+\d+ lines|\d+ chars))?\]/gu;
