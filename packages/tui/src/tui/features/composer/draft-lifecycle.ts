import type { Editor, EditorDraftSnapshot } from '../../widgets/editor/editor.js';
import {
  TuiDraftRecovery,
  TuiDraftRecoveryError,
  type TuiRecoverableDraft,
} from './draft-recovery.js';
import type { TuiComposerDraft } from './draft.js';
import {
  createTuiSubmissionSnapshot,
  type TuiRetrySubmission,
  type TuiSubmissionSeed,
  type TuiSubmissionSnapshot,
} from './submission.js';

const ADOPTION_RETRY_DELAY_MS = 30_000;
const RESTORED_SUBMISSION_CODE = 'submission.restored';

export class TuiDraftLifecycle {
  private recovery?: TuiDraftRecovery;
  private sessionKey = 'new-session';
  private transitionTail: Promise<void> = Promise.resolve();
  private readonly pendingSubmissions = new Map<
    string,
    { sessionKey: string; retry: TuiRetrySubmission }
  >();
  private pendingSubmissionCounter = 0;
  private stopped = false;
  private adoptionAttempt?: { sessionId: string; retryAtMs: number };
  private readonly reportedErrors = new Map<string, string>();
  private readonly unsavedDrafts = new Map<string, TuiRecoverableDraft>();

  constructor(
    private readonly options: {
      readonly dataDir?: string;
      readonly workspaceDir: string;
      readonly editor: Pick<Editor, 'captureDraft' | 'restoreDraft' | 'restoreSubmittedDraft'>;
      readonly composerDraft: TuiComposerDraft;
      readonly onRestored: (message: string) => void;
      readonly onRetryRestored?: (submission: TuiSubmissionSnapshot) => void;
      readonly onError?: (error: unknown) => void;
    },
  ) {
    this.recovery = this.createRecovery(this.sessionKey);
  }

  async hydrate(): Promise<void> {
    const recovered = await this.loadRecovery();
    if (!recovered || this.stopped) return;
    const restoredEditor = this.restore(recovered);
    if (!restoredEditor && recovered.attachments.length === 0) return;
    const restoredParts = [
      recovered.editor.text ? 'text' : undefined,
      recovered.attachments.length > 0
        ? `${recovered.attachments.length} attachment${
            recovered.attachments.length === 1 ? '' : 's'
          }`
        : undefined,
    ].filter((part): part is string => Boolean(part));
    this.options.onRestored(`Draft restored · ${restoredParts.join(' + ')}`);
  }

  schedule(): void {
    if (this.stopped) return;
    this.recovery?.schedule(this.capture());
  }

  suspendForSubmission(content?: string, seed?: TuiSubmissionSeed): string | undefined {
    this.recovery?.suspend();
    if (!seed) return undefined;
    // Pending recovery follows the draft namespace until session adoption commits.
    const sessionKey =
      this.sessionKey === 'new-session' ? this.sessionKey : (seed.sessionId ?? this.sessionKey);
    for (const [token, pending] of this.pendingSubmissions) {
      if (pending.sessionKey === sessionKey) this.pendingSubmissions.delete(token);
    }
    this.pendingSubmissionCounter += 1;
    const submissionId = `pending-${String(Date.now())}-${String(this.pendingSubmissionCounter)}`;
    const snapshot = createTuiSubmissionSnapshot({
      submissionId,
      sessionId: seed.sessionId ?? sessionKey,
      editor: seed.editor,
      content: content?.trim() ?? '',
      resources: seed.resources,
      ...(seed.transportContent ? { transportContent: seed.transportContent } : {}),
      ...(seed.transportAttachments ? { transportAttachments: seed.transportAttachments } : {}),
    });
    const submissionToken = `retry:${submissionId}`;
    this.pendingSubmissions.set(submissionToken, {
      sessionKey,
      retry: {
        retryId: submissionToken,
        snapshot,
        failedReason: 'MCode stopped before Runtime admission completed.',
        failureCode: 'submission.interrupted',
      },
    });
    return submissionToken;
  }

  updatePendingSubmission(
    submissionToken: string | undefined,
    snapshot: TuiSubmissionSnapshot,
  ): void {
    if (!submissionToken) return;
    const pending = this.pendingSubmissions.get(submissionToken);
    if (!pending) return;
    this.pendingSubmissions.set(submissionToken, {
      ...pending,
      retry: { ...pending.retry, snapshot },
    });
  }

  settleSubmission(submissionToken?: string): void {
    if (this.stopped) return;
    const pending = submissionToken ? this.pendingSubmissions.get(submissionToken) : undefined;
    if (submissionToken && !pending) return;
    if (submissionToken) this.pendingSubmissions.delete(submissionToken);
    if (!this.recovery) return;
    if (pending && pending.sessionKey !== this.sessionKey) {
      this.persistDetachedSession(pending.sessionKey);
      return;
    }
    void this.recovery.flush(this.capture()).catch((error: unknown) => this.report(error));
  }

  /** Persist an aborted submission's opaque metadata without replaying its text on hydrate. */
  recordRestoredSubmission(snapshot: TuiSubmissionSnapshot): void {
    if (this.stopped) return;
    for (const [submissionToken, pending] of this.pendingSubmissions) {
      if (pending.sessionKey !== this.sessionKey) continue;
      this.pendingSubmissions.delete(submissionToken);
    }
    const hasTransportOnlyAttachment = snapshot.transportAttachments?.some(
      (attachment) =>
        !attachment.filePath ||
        !snapshot.attachments.some((draft) => draft.filePath === attachment.filePath),
    );
    if (
      snapshot.transportContent ||
      snapshot.clientIntent ||
      snapshot.reviewRequest ||
      hasTransportOnlyAttachment
    ) {
      const retryId = `retry:restored:${snapshot.submissionId}`;
      this.pendingSubmissions.set(retryId, {
        sessionKey: this.sessionKey,
        retry: {
          retryId,
          failureCode: RESTORED_SUBMISSION_CODE,
          failedReason: 'Aborted submission returned to the composer.',
          snapshot,
        },
      });
    }
    // This also removes the matching interrupted retry from the recovery file.
    void this.recovery?.flush(this.capture()).catch((error: unknown) => this.report(error));
  }

  switchSession(sessionKey: string): Promise<void> {
    return this.enqueueTransition(async () => {
      if (this.stopped || sessionKey === this.sessionKey) return;
      if (!this.recovery) {
        await this.discardComposer();
        this.options.editor.restoreDraft(emptyEditorDraft());
        this.sessionKey = sessionKey;
        return;
      }
      const draft = this.capture();
      try {
        await this.recovery.flush(draft, { materializeVolatileAttachments: true });
      } catch (error) {
        this.unsavedDrafts.set(this.sessionKey, draft);
        // Keep clipboard leases alive for the in-memory draft when the backup is unavailable.
        this.options.composerDraft.reserveSubmission(draft);
        this.report(error);
      }
      await this.discardComposer();
      this.options.editor.restoreDraft(emptyEditorDraft());
      try {
        await this.recovery.switchSession(sessionKey);
      } catch (error) {
        this.report(new TuiDraftRecoveryError('migrate', error));
        this.recovery.dispose();
        this.recovery = this.createRecovery(sessionKey);
      }
      this.sessionKey = sessionKey;
      this.adoptionAttempt = undefined;
      const recovered = this.unsavedDrafts.get(sessionKey) ?? (await this.loadRecovery());
      if (!recovered) {
        return;
      }
      this.unsavedDrafts.delete(sessionKey);
      this.restore(recovered);
    });
  }

  adoptCreatedSession(sessionId: string): void {
    if (!this.recovery || this.sessionKey !== 'new-session' || this.stopped) return;
    if (
      this.adoptionAttempt?.sessionId === sessionId &&
      Date.now() < this.adoptionAttempt.retryAtMs
    )
      return;
    this.adoptionAttempt = { sessionId, retryAtMs: Number.POSITIVE_INFINITY };
    void this.enqueueTransition(async () => {
      if (this.stopped || this.sessionKey !== 'new-session') return;
      await this.recovery?.switchSession(sessionId, { migrateCurrent: true });
      this.migratePendingSession('new-session', sessionId);
      this.sessionKey = sessionId;
      this.adoptionAttempt = undefined;
      this.reportedErrors.delete('migrate');
      await this.recovery?.flush(this.capture());
    }).catch((error: unknown) => {
      this.adoptionAttempt = { sessionId, retryAtMs: Date.now() + ADOPTION_RETRY_DELAY_MS };
      this.report(
        error instanceof TuiDraftRecoveryError
          ? error
          : new TuiDraftRecoveryError('migrate', error),
      );
    });
  }

  async suspend(): Promise<void> {
    if (!this.recovery || this.stopped) return;
    await this.transitionTail.catch(() => undefined);
    await this.recovery
      .flush(this.capture(), { materializeVolatileAttachments: true })
      .catch((error: unknown) => this.report(error));
    this.recovery.suspend();
  }

  resume(): void {
    if (!this.recovery || this.stopped) return;
    void this.recovery.flush(this.capture()).catch((error: unknown) => this.report(error));
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    // The app disposes the editor immediately after calling stop(); capture
    // placeholder metadata before its dispose() clears that state.
    const finalDraft = this.capture();
    this.stopped = true;
    await this.transitionTail.catch(() => undefined);
    let releaseDraft = true;
    if (this.recovery) {
      try {
        await this.recovery.flush(finalDraft, { materializeVolatileAttachments: true });
      } catch (error) {
        releaseDraft = false;
        this.report(error);
      }
      this.recovery.dispose();
    }
    if (!releaseDraft) return;
    await this.discardComposer();
  }

  private createRecovery(sessionKey: string): TuiDraftRecovery | undefined {
    if (!this.options.dataDir) return undefined;
    return new TuiDraftRecovery({
      dataDir: this.options.dataDir,
      workspaceDir: this.options.workspaceDir,
      sessionKey,
      onError: (error) => this.report(error),
      onPersisted: () => {
        this.reportedErrors.delete('save');
        this.reportedErrors.delete('cleanup');
      },
    });
  }

  private async loadRecovery(): Promise<TuiRecoverableDraft | undefined> {
    try {
      const recovered = await this.recovery?.load();
      this.reportedErrors.delete('load');
      return recovered;
    } catch (error) {
      this.report(new TuiDraftRecoveryError('load', error));
      return undefined;
    }
  }

  private async discardComposer(): Promise<void> {
    await this.options.composerDraft
      .discard()
      .catch((error: unknown) => this.report(new TuiDraftRecoveryError('cleanup', error)));
  }

  private capture() {
    const draft = this.options.composerDraft.snapshot();
    const editor = this.options.editor.captureDraft();
    // Clearing a visible restored draft also discards its hidden metadata.
    if (!editor.text && draft.attachments.length === 0) {
      for (const [token, pending] of this.pendingSubmissions) {
        if (
          pending.sessionKey === this.sessionKey &&
          pending.retry.failureCode === RESTORED_SUBMISSION_CODE &&
          (pending.retry.snapshot.editor.text || pending.retry.snapshot.content)
        ) {
          this.pendingSubmissions.delete(token);
        }
      }
    }
    return {
      editor,
      attachments: [...draft.attachments],
      retrySubmissions: this.captureRetrySubmissions(this.sessionKey),
    };
  }

  private restore(recovered: TuiRecoverableDraft): boolean {
    let restoredEditor = this.options.editor.restoreDraft(recovered.editor);
    this.options.composerDraft.restoreAttachments(recovered.attachments);
    for (const retry of recovered.retrySubmissions ?? []) {
      if (retry.failureCode === RESTORED_SUBMISSION_CODE) {
        this.pendingSubmissions.set(retry.retryId, { sessionKey: this.sessionKey, retry });
        this.options.onRetryRestored?.(retry.snapshot);
        continue;
      }
      if (retry.failureCode !== 'submission.interrupted') continue;
      restoredEditor =
        this.options.editor.restoreSubmittedDraft(retry.snapshot.editor) || restoredEditor;
      this.options.composerDraft.restoreAttachments(retry.snapshot.attachments);
      this.options.onRetryRestored?.(retry.snapshot);
    }
    return restoredEditor;
  }

  private captureRetrySubmissions(sessionKey: string): TuiRetrySubmission[] {
    return [...this.pendingSubmissions.values()]
      .filter((pending) => pending.sessionKey === sessionKey)
      .map((pending) => pending.retry);
  }

  private persistDetachedSession(sessionKey: string): void {
    const dataDir = this.options.dataDir;
    if (!dataDir || this.stopped) return;
    void this.enqueueTransition(async () => {
      const recovery = new TuiDraftRecovery({
        dataDir,
        workspaceDir: this.options.workspaceDir,
        sessionKey,
      });
      try {
        const cached = this.unsavedDrafts.get(sessionKey);
        const recovered = cached ?? (await recovery.load()) ?? emptyRecoverableDraft();
        const draft = {
          ...recovered,
          retrySubmissions: this.captureRetrySubmissions(sessionKey),
        };
        if (cached) this.unsavedDrafts.set(sessionKey, draft);
        await recovery.flush(draft);
      } finally {
        recovery.dispose();
      }
    }).catch((error: unknown) => this.report(error));
  }

  private migratePendingSession(previousSessionKey: string, sessionId: string): void {
    for (const [submissionToken, pending] of this.pendingSubmissions) {
      if (pending.sessionKey !== previousSessionKey) continue;
      this.pendingSubmissions.set(submissionToken, {
        sessionKey: sessionId,
        retry: {
          ...pending.retry,
          snapshot: { ...pending.retry.snapshot, sessionId },
        },
      });
    }
  }

  private enqueueTransition(operation: () => Promise<void>): Promise<void> {
    const transition = this.transitionTail.catch(() => undefined).then(operation);
    this.transitionTail = transition.catch(() => undefined);
    return transition;
  }

  private report(error: unknown): void {
    const operation = error instanceof TuiDraftRecoveryError ? error.operation : 'save';
    const message = error instanceof Error ? error.message : String(error);
    if (this.reportedErrors.get(operation) === message) return;
    this.reportedErrors.set(operation, message);
    this.options.onError?.(error);
  }
}

function emptyEditorDraft(): EditorDraftSnapshot {
  return {
    schemaVersion: 1,
    text: '',
    cursor: 0,
    pastes: [],
    pasteCounter: 0,
  };
}

function emptyRecoverableDraft(): TuiRecoverableDraft {
  return {
    editor: emptyEditorDraft(),
    attachments: [],
    retrySubmissions: [],
  };
}
