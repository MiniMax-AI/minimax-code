import { TuiHistorySearchPanel } from '../../src/tui/features/history/search-panel.js';
import { TuiQueueFlow } from '../../src/tui/controller/run/queue-flow.js';
import { TuiRunProjection } from '../../src/tui/state/run-projection.js';
import { TuiCommandFlow } from '../../src/tui/controller/product/command-flow.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serializePluginMention, parsePluginMentions } from '@mavis/shared/plugin-mention';
import { createTuiAutocomplete } from '../../src/tui/controller/run/active-run-flow.js';
import {
  Editor,
  submittedEditorTransport,
  submittedEditorContent,
} from '../../src/tui/widgets/editor/editor.js';
import { TuiDraftRecovery } from '../../src/tui/features/composer/draft-recovery.js';
import { createTuiSubmissionSnapshot } from '../../src/tui/features/composer/submission.js';
import { stripTerminalSequences } from '../../src/tui/engine/public.js';

const identity = (value: string) => value;
const makePlugin = (name = 'notes', marketplace: 'local' | 'official' = 'local') => ({
  pluginId: `${name}@${marketplace}`,
  name,
  displayName: 'My Notes',
  marketplace,
  installed: true,
  enabled: true,
  capabilities: { appCount: 0, mcpServerCount: 0, skillCount: 1 },
});
const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.dispose();
});
function createEditor() {
  const editor = new Editor(
    { terminal: { rows: 24 }, requestRender: vi.fn() },
    {
      borderColor: identity,
      selectList: {
        selectedPrefix: identity,
        selectedText: identity,
        description: identity,
        scrollInfo: identity,
        noMatch: identity,
      },
    },
  );
  editors.push(editor);
  editor.focused = true;
  editor.setAutocompleteProvider(
    createTuiAutocomplete([], [], '/workspace', {
      listInstalledPlugins: async () => [makePlugin()],
      listWorkspaceFileTree: async () => [],
      searchWorkspaceFiles: async () => [],
    }),
  );
  return editor;
}
async function selectPlugin(editor: Editor) {
  editor.handleInput('@');
  await vi.waitFor(() =>
    expect(stripTerminalSequences(editor.render(80).join('\n'))).toContain('Plugin · local'),
  );
  editor.handleInput('\t');
  expect(editor.getText()).toBe('@My Notes ');
  expect(editor.captureDraft().pluginMentions).toEqual([
    { pluginId: 'notes@local', label: '@My Notes', start: 0, end: 9 },
  ]);
}

describe('Plugin mentions from Composer to durable text', () => {
  it('offers enabled plugins alongside files, refreshes state, and preserves file completion', async () => {
    const listInstalledPlugins = vi.fn(async () => [
      makePlugin(),
      { ...makePlugin('off'), enabled: false },
    ]);
    const provider = createTuiAutocomplete([], [], '/workspace', {
      listInstalledPlugins,
      listWorkspaceFileTree: async () => [
        { name: 'notes.md', path: 'notes.md', type: 'file' as const },
      ],
    });
    const request = { signal: new AbortController().signal };
    const result = await provider.getSuggestions(['@'], 0, 1, request);
    expect(result?.items).toHaveLength(2);
    expect(result?.items[0]).toMatchObject({ pluginId: 'notes@local' });
    expect(result?.items[1]?.value).toContain('notes.md');
    listInstalledPlugins.mockResolvedValue([{ ...makePlugin(), enabled: false }]);
    expect((await provider.getSuggestions(['@'], 0, 1, request))?.items).toHaveLength(1);
    expect(provider.applyCompletion(['see @ suffix'], 0, 5, result!.items[0]!, '@').lines).toEqual([
      'see @My Notes  suffix',
    ]);
  });

  it('renders a label, submits stable identity, and preserves history through multiple recalls', async () => {
    const editor = createEditor();
    await selectPlugin(editor);
    editor.handleInput('整理笔记');
    const submitted = vi.fn();
    editor.onSubmit = submitted;
    editor.handleInput('\r');
    const [content, draft] = submitted.mock.calls[0]!;
    expect(content).toBe('@My Notes 整理笔记');
    const transport = submittedEditorTransport(draft);
    expect(transport).toBe('[@My Notes](plugin://notes%40local) 整理笔记');
    editor.addToHistory(content);
    editor.addToHistory('another prompt');
    editor.handleInput('\x1b[A');
    expect(editor.getText()).toBe('another prompt');
    editor.handleInput('\x1b[A');
    expect(editor.getText()).toBe(content);
    expect(submittedEditorTransport(editor.captureDraft())).toBe(transport);
    editor.handleInput('\x1b[B');
    expect(editor.getText()).toBe('another prompt');
    expect(editor.captureDraft().pluginMentions).toEqual([]);
  });

  it('deletes a selected mention atomically and restores its exact identity with undo', async () => {
    const editor = createEditor();
    await selectPlugin(editor);
    editor.handleInput('\x7f');
    expect(editor.getText()).toBe('');
    expect(editor.captureDraft().pluginMentions).toEqual([]);
    editor.handleInput('\x1f');
    expect(editor.getText()).toBe('@My Notes ');
    expect(submittedEditorTransport(editor.captureDraft())).toBe(
      '[@My Notes](plugin://notes%40local)',
    );
  });

  it('restores the working draft identity after browsing history', async () => {
    const editor = createEditor();
    await selectPlugin(editor);
    editor.addToHistory('older');
    editor.handleInput('\x01');
    editor.handleInput('\x1b[A');
    expect(editor.getText()).toBe('older');
    editor.handleInput('\x1b[B');
    expect(submittedEditorTransport(editor.captureDraft())).toBe(
      '[@My Notes](plugin://notes%40local)',
    );
  });

  it('keeps identities distinct when history labels are identical', () => {
    const editor = createEditor();
    editor.addToHistory(serializePluginMention('notes@local', 'My Notes'));
    editor.addToHistory(serializePluginMention('notes@official', 'My Notes'));
    editor.handleInput('\x1b[A');
    expect(editor.captureDraft().pluginMentions?.[0]?.pluginId).toBe('notes@official');
    editor.handleInput('\x1b[A');
    expect(editor.captureDraft().pluginMentions?.[0]?.pluginId).toBe('notes@local');
  });

  it('preserves mentions with attachments, merged retries and persisted drafts', async () => {
    const editor = createEditor();
    await selectPlugin(editor);
    editor.syncAttachmentPlaceholders([{ id: '/image.png', label: '[Image #1]' }]);
    editor.handleInput('summarize');
    const snapshot = editor.captureDraft();
    expect(submittedEditorTransport(snapshot)).toBe(
      '[@My Notes](plugin://notes%40local) summarize',
    );
    const submission = createTuiSubmissionSnapshot({
      submissionId: 's1',
      editor: snapshot,
      content: submittedEditorContent(snapshot),
      resources: { attachments: [] },
    });
    const directory = await mkdtemp(join(tmpdir(), 'plugin-mention-test-'));
    try {
      const store = new TuiDraftRecovery({ dataDir: directory, workspaceDir: '/workspace' });
      const plain = {
        ...snapshot,
        text: '@My Notes summarize',
        cursor: 19,
        attachmentPlaceholders: [],
      };
      await store.flush({
        editor: plain,
        attachments: [],
        retrySubmissions: [
          {
            retryId: 'retry:r1',
            failedReason: 'offline',
            snapshot: { ...submission, editor: plain },
          },
        ],
      });
      const loaded = await new TuiDraftRecovery({
        dataDir: directory,
        workspaceDir: '/workspace',
      }).load();
      expect(loaded?.editor.pluginMentions).toEqual(snapshot.pluginMentions);
      expect(loaded?.retrySubmissions?.[0]?.snapshot.editor.pluginMentions).toEqual(
        snapshot.pluginMentions,
      );
      editor.setText('new draft');
      expect(editor.restoreSubmittedDraft(loaded!.editor)).toBe(true);
      expect(submittedEditorTransport(editor.captureDraft())).toBe(
        '[@My Notes](plugin://notes%40local) summarize\nnew draft',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('shows human-readable history search and restores the canonical identity', () => {
    const entry = serializePluginMention('notes@official', 'My Notes');
    const editor = createEditor();
    const panel = new TuiHistorySearchPanel({
      entries: [entry],
      initialQuery: 'My Notes',
      onSelect: (text) => editor.setText(text),
      onCancel: vi.fn(),
      requestRender: vi.fn(),
    });
    const rendered = stripTerminalSequences(panel.render(100).join('\n'));
    expect(rendered).toContain('@My Notes');
    expect(rendered).not.toContain('plugin://');
    panel.handleInput('\r');
    expect(editor.captureDraft().pluginMentions?.[0]?.pluginId).toBe('notes@official');
  });

  it('rejects corrupt restored ranges and malformed IDs without binding another plugin', () => {
    const editor = createEditor();
    expect(
      editor.restoreDraft({
        schemaVersion: 1,
        text: '@Notes',
        cursor: 6,
        pastes: [],
        pasteCounter: 0,
        pluginMentions: [{ pluginId: 'notes@local', label: '@Wrong', start: 0, end: 6 }],
      }),
    ).toBe(false);
    expect(parsePluginMentions('[@Notes](plugin://%ZZ)')).toEqual([]);
  });
  it('submits bound text through the real command flow and restores the binding on failure', async () => {
    const editor = createEditor();
    await selectPlugin(editor);
    editor.handleInput('summarize');
    const draft = editor.captureDraft();
    const content = submittedEditorContent(draft);
    const submit = vi.fn(
      async (
        _text: string,
        options: {
          onSessionResolved?: (id: string) => void;
          onRuntimeAccepted?: (id: string) => void;
        },
      ) => {
        options.onSessionResolved?.('session-a');
        options.onRuntimeAccepted?.('session-a');
        return 'succeeded' as const;
      },
    );
    const flow = new TuiCommandFlow({
      workspaceDir: '/workspace',
      controller: {
        snapshot: () => ({ status: 'idle', sessions: [], session: { sessionId: 'session-a' } }),
        submit,
        refreshSessionMetadata: async () => undefined,
      } as never,
      activeRunFlow: {} as never,
      featureFlow: {
        skillCommands: () => [],
        waitForWelcomeModelSelection: async () => undefined,
        applyPendingModelSelection: async () => undefined,
      } as never,
      feedbackFlow: {} as never,
      updateFlow: {} as never,
      interactionFlow: { handleCommand: async () => false, hasPending: () => false } as never,
      sessionFlow: {} as never,
      queueFlow: {} as never,
      composerDraft: {
        hasContent: () => false,
        capture: () => ({ attachments: [] }),
        reserveSubmission: vi.fn(),
        restoreSubmission: vi.fn(),
        completeSubmission: async () => undefined,
      } as never,
      workspaceRoots: { additionalDirectories: () => [] } as never,
      runProjection: new TuiRunProjection(),
      editor,
      surface: {} as never,
      surfaceHost: { setChatFocus: vi.fn() } as never,
      queueEnabled: true,
      liveRunId: () => undefined,
      runtimeStopping: () => false,
      abortLiveTurn: async () => false,
      leaveUi: async () => undefined,
      whenReady: async () => undefined,
      append: vi.fn(),
      setHint: vi.fn(),
      onChanged: vi.fn(),
    });
    const seed = flow.captureSubmissionSeed(draft);
    editor.setText('');
    await expect(flow.submit(content, seed)).resolves.toBe('consumed');
    expect(submit).toHaveBeenCalledWith(
      '[@My Notes](plugin://notes%40local) summarize',
      expect.objectContaining({ displayContent: content }),
    );
    flow.restoreRecoverableSubmission({
      submissionId: 'recovered',
      sessionId: 'session-a',
      editor: draft,
      content,
      attachments: [],
      createdAtMs: 1,
      transportContent:
        '<user-provided-context>context</user-provided-context>\n\n[@My Notes](plugin://notes%40local) summarize',
    });
    editor.restoreDraft(draft);
    editor.handleInput(' tomorrow');
    const retrySeed = flow.captureSubmissionSeed();
    await flow.submit('@My Notes summarize tomorrow', retrySeed);
    expect(submit).toHaveBeenLastCalledWith(
      '<user-provided-context>context</user-provided-context>\n\n[@My Notes](plugin://notes%40local) summarize tomorrow',
      expect.objectContaining({ displayContent: '@My Notes summarize tomorrow' }),
    );
    editor.setText('');
    await flow.restoreFailedSeed(content, seed);
    expect(submittedEditorTransport(editor.captureDraft())).toBe(
      '[@My Notes](plugin://notes%40local) summarize',
    );
  });

  it.each(['', '<user-provided-context>synthetic context</user-provided-context>\n\n'])(
    'reconstructs queued bindings and context after reload: %s',
    async (context) => {
      let item = {
        itemId: 'q1',
        sessionId: 's1',
        status: 'queued',
        source: 'user',
        content: `${context}[@My Notes](plugin://notes%40local) summarize`,
        attachments: [],
      };
      const projection = new TuiRunProjection();
      const updateQueuedMessageContent = vi.fn(
        async (_session: string, _item: string, content: string) => {
          item = { ...item, content };
          return item;
        },
      );
      let removed = false;
      const queue = new TuiQueueFlow({
        runtime: {
          getQueueSnapshot: async () => ({
            items: removed ? [] : [item],
            paused: true,
            pendingCount: removed ? 0 : 1,
          }),
          deleteQueuedMessage: async () => {
            removed = true;
            return true;
          },
          updateQueuedMessageContent,
        } as never,
        controller: { snapshot: () => ({ session: { sessionId: 's1' } }) } as never,
        composerDraft: { restoreQueuedSubmission: vi.fn(), releaseQueueItem: vi.fn() } as never,
        runProjection: projection,
        transcript: { get: vi.fn(), remove: vi.fn(), upsert: vi.fn() } as never,
        followUp: { setQueueSummary: vi.fn(), setItems: vi.fn() } as never,
        surface: {} as never,
        enabled: true,
        setHint: vi.fn(),
        onChanged: vi.fn(),
        requestRender: vi.fn(),
      });
      await queue.refresh('s1');
      expect(projection.snapshot().queuedItems[0]?.content).toBe('@My Notes summarize');
      await queue.updateContent('q1', '@My Notes summarize tomorrow');
      expect(updateQueuedMessageContent).toHaveBeenCalledWith(
        's1',
        'q1',
        `${context}[@My Notes](plugin://notes%40local) summarize tomorrow`,
      );
      const restored = await queue.restoreLatest();
      expect(restored?.content).toBe('@My Notes summarize tomorrow');
      expect(submittedEditorTransport(restored!.editor)).toBe(
        '[@My Notes](plugin://notes%40local) summarize tomorrow',
      );
    },
  );
});
