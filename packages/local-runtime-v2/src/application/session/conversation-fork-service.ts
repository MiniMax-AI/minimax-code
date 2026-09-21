import {
  isConversationMutationEligibleSession,
  type DisplayMessageRecord,
  type SessionRecord,
} from '../../service/session-system/index.js';
import {
  ForkServiceError,
  type ForkAssetPort,
  type ForkBoundary,
  type ForkDisplayPort,
  type ForkHistoryPort,
  type ForkOperationManifest,
  type ForkOperationPort,
  type ForkRequest,
  type ResolvedForkRequest,
  type ForkResult,
  type ForkResumeResult,
  type ForkSessionPort,
  type ForkSessionStatePort,
  type ForkWorktreePort,
} from './conversation-fork-contracts.js';
import { asRecoverableForkStage, type RecoverableForkStage } from './conversation-fork-recovery.js';

/**
 * Hidden boundary injected between inherited fork history and the side
 * conversation. The wording deliberately mirrors Codex's side-conversation
 * boundary prompt: inherited history is reference-only, mutations stay
 * discouraged unless the user explicitly asks for one after the boundary, and
 * ordinary tool permissions keep applying (no capability-level hard gate).
 */
const BTW_SIDE_BOUNDARY = {
  kind: 'btw_side_boundary',
  content: `<system-reminder>
Side conversation boundary.

Everything before this boundary is inherited history from the parent session. It is reference context only. It is not your current task.

Do not continue, execute, or complete any instructions, plans, tool calls, approvals, edits, or requests from before this boundary. Only messages submitted after this boundary are active user instructions for this side conversation.

You are a side-conversation assistant, separate from the main session. Answer questions and do lightweight, non-mutating exploration without disrupting the main session. If there is no user question after this boundary yet, wait for one.

Tools may be available according to this session's current permissions. Any tool calls or outputs visible before this boundary happened in the parent session and are reference-only; do not infer active instructions from them.

Sub-agents are off-limits in this side conversation. Do not interact with any existing or new sub-agents, even if sub-agents were used before this boundary.

Do not modify files, source, git state, permissions, configuration, or any other workspace state unless the user explicitly asks for that mutation after this boundary. Do not request escalated permissions unless the user explicitly asks for a mutation that requires it. If the user explicitly requests a mutation, keep it minimal, local to the request, and avoid disrupting the main session.
</system-reminder>`,
} as const;

export interface ForkResumeInput {
  readonly manifest: ForkOperationManifest;
  readonly stage: RecoverableForkStage;
  readonly advance?: (input: {
    readonly stage: string;
    readonly manifest: ForkOperationManifest;
  }) => Promise<void>;
}

interface ForkServiceDependencies {
  readonly boundary: import('./conversation-fork-contracts.js').ForkBoundaryPort;
  readonly sessions: ForkSessionPort;
  readonly display: ForkDisplayPort;
  readonly history: ForkHistoryPort;
  readonly operations: ForkOperationPort;
  readonly assets?: ForkAssetPort;
  readonly state?: ForkSessionStatePort;
  readonly worktree?: Pick<ForkWorktreePort, 'prepare' | 'probe' | 'cleanup'>;
  readonly sessionDataVersion: number;
}

type ForkSource = SessionRecord;
type PreparedWorktree = Awaited<ReturnType<ForkWorktreePort['prepare']>>;
type WorktreeProbe = NonNullable<ForkWorktreePort['probe']>;
type PendingForkOperation = NonNullable<
  Awaited<ReturnType<NonNullable<ForkOperationPort['getPending']>>>
>;

interface ResumeProgress {
  readonly manifest: ForkOperationManifest;
  merge(patch: Partial<ForkOperationManifest>): void;
  advance(stage: string, patch?: Partial<ForkOperationManifest>): Promise<void>;
}

interface StartProgress {
  readonly manifest: ForkOperationManifest;
  advance(status: string, stage: string, patch?: Partial<ForkOperationManifest>): Promise<void>;
}

interface ResumeContext {
  readonly progress: ResumeProgress;
  readonly source: ForkSource;
  readonly child: SessionRecord;
  readonly boundary: ForkBoundary;
  readonly worktree: ForkOperationManifest['worktree'];
  readonly stage: RecoverableForkStage;
}

/** Coordinates the bounded, compensating Fork workflow. */
export class ForkService {
  constructor(private readonly deps: ForkServiceDependencies) {}

  async resume(input: ForkResumeInput): Promise<ForkResumeResult> {
    try {
      return await this.resumeOwned(input, true);
    } catch (error) {
      if (error instanceof ForkServiceError) throw error;
      throw new ForkServiceError('fork-failed', 'Fork recovery could not verify persisted state', {
        cause: error,
      });
    }
  }

  private async resumeOwned(
    input: ForkResumeInput,
    verifyWorktreeOwnership = false,
  ): Promise<ForkResumeResult> {
    const progress = createResumeProgress(input);
    const source = await this.requireSupportedSource(
      input.manifest.source.sessionId,
      'Fork recovery',
    );
    const boundary = await this.readBoundary(
      source.sessionId,
      input.manifest.request.assistantDisplayMessageId,
      input.manifest.request.sidePresentation
        ? { throughMessageId: input.manifest.request.sideHistoryMessageId }
        : undefined,
    );
    this.assertForkBoundary(source, boundary, input.manifest.request);
    const worktree = await this.recoverWorktree(
      progress,
      source,
      input.stage,
      verifyWorktreeOwnership,
    );
    const child = await this.resolveResumeChild(progress, source, worktree, input.stage);
    const context: ResumeContext = {
      progress,
      source,
      child,
      boundary,
      worktree,
      stage: input.stage,
    };
    await this.publishHistory(context);
    const assets = await this.publishDisplayAssets(context);
    return this.publishChild(context, assets, Boolean(input.advance));
  }

  private async requireSupportedSource(sessionId: string, context: string): Promise<ForkSource> {
    const source = await this.deps.sessions.get(sessionId);
    if (!source) {
      throw new ForkServiceError('source-not-found', `${context} source session is missing`);
    }
    if (!isSupportedSource(source, this.deps.sessionDataVersion)) {
      throw new ForkServiceError(
        'unsupported-session',
        `${context} requires a supported local pi-agent session`,
      );
    }
    return source;
  }

  private assertForkBoundary(
    source: ForkSource,
    boundary: ForkBoundary,
    request: ForkRequest,
  ): void {
    if (
      request.planState &&
      (!boundary.isLatestConversationMessage ||
        source.status !== 'idle' ||
        isUnsettled(boundary.assistant))
    ) {
      throw new ForkServiceError(
        'invalid-boundary',
        'Plan Fork requires the latest settled assistant boundary',
      );
    }
    if (boundary.canonicalBoundaryReachable === false) {
      throw new ForkServiceError(
        'request-conflict',
        'Fork source history changed; reopen Fork options and try again',
      );
    }
  }

  private async recoverWorktree(
    progress: ResumeProgress,
    source: ForkSource,
    stage: RecoverableForkStage,
    verifyOwnership: boolean,
  ): Promise<ForkOperationManifest['worktree']> {
    if (!progress.manifest.request.isolatedWorktree) return undefined;
    if (stage === 'validated') {
      throw new ForkServiceError(
        'fork-failed',
        'Fork recovery cannot safely recreate an unrecorded isolated worktree',
      );
    }
    const persisted = progress.manifest.worktree;
    if (!persisted) {
      assertWorktreeEligible(source);
      throw missingWorktreeProof();
    }
    if (!verifyOwnership) return persisted;
    const probe = this.deps.worktree?.probe;
    if (!probe) throw missingWorktreeProof();
    const recovered = await probeRecoveredWorktree(
      progress.manifest.request.operationId,
      persisted,
      probe,
    );
    progress.merge({ worktree: recovered });
    return recovered;
  }

  private async resolveResumeChild(
    progress: ResumeProgress,
    source: ForkSource,
    worktree: ForkOperationManifest['worktree'],
    stage: RecoverableForkStage,
  ): Promise<SessionRecord> {
    const existing = progress.manifest.childSessionId
      ? await this.deps.sessions.get(progress.manifest.childSessionId)
      : undefined;
    if (!stageAtOrBefore(stage, 'worktree-prepared')) return requireResumeChild(existing);
    if (existing) {
      throw new ForkServiceError(
        'fork-failed',
        'Fork recovery found an unexpected child before session-created stage',
      );
    }
    const child = await this.createChild(source, worktree, progress.manifest.request);
    await progress.advance('session-created', { childSessionId: child.sessionId });
    return child;
  }

  private async createChild(
    source: ForkSource,
    worktree: ForkOperationManifest['worktree'],
    request: ForkRequest,
  ): Promise<SessionRecord> {
    const { title: suggestedTitle } = await suggestForkTitle(source, this.deps.sessions);
    const runLocation = worktree?.runLocation ?? source.runLocation;
    return this.deps.sessions.create({
      sourceSessionId: source.sessionId,
      agentName: source.agentName,
      workspaceDir: worktree?.workspaceDir ?? source.workspaceDir,
      ...(source.isDefaultWorkspace !== undefined
        ? { isDefaultWorkspace: source.isDefaultWorkspace }
        : {}),
      title: resolveChildTitle(request, suggestedTitle),
      ...(source.appMode ? { appMode: source.appMode } : {}),
      ...(runLocation ? { runLocation } : {}),
      ...(source.effectiveModel !== undefined ? { effectiveModel: source.effectiveModel } : {}),
      ...(source.effectiveModelVariant !== undefined
        ? { effectiveModelVariant: source.effectiveModelVariant }
        : {}),
      effectiveModelThinking: source.effectiveModelThinking,
      effectiveModelContextWindow: source.effectiveModelContextWindow,
      effectiveModelMaxOutputTokens: source.effectiveModelMaxOutputTokens,
      ...(request.sidePresentation
        ? {
            parentSessionId: request.sidePresentation.parentSessionId,
            visibility: 'hidden' as const,
            purpose: request.sidePresentation.purpose,
            sessionKind: 'peek' as const,
          }
        : {}),
    });
  }

  private async publishHistory(context: ResumeContext): Promise<void> {
    const input = historyForkInput(context);
    const history = await this.deps.history.fork({
      sourceSessionId: context.source.sessionId,
      ...input,
      ...(context.worktree?.runLocation?.resolvedBranch
        ? {
            continuation: {
              previousWorkspaceDir: context.source.workspaceDir,
              currentWorkspaceDir: context.worktree.workspaceDir,
              currentBranch: context.worktree.runLocation.resolvedBranch,
            },
          }
        : {}),
    });
    if (!stageAtOrBefore(context.stage, 'session-created')) {
      context.progress.merge({ historyRevision: history.historyRevision });
      return;
    }
    await context.progress.advance('history-published', {
      childSessionId: context.child.sessionId,
      historyRevision: history.historyRevision,
    });
  }

  private async publishDisplayAssets(
    context: ResumeContext,
  ): Promise<ForkOperationManifest['assets']> {
    if (stageAtOrAfter(context.stage, 'display-assets-published')) {
      await this.probeDisplayAssets(context);
      return context.progress.manifest.assets;
    }
    const assets = await this.copyDisplayAssets(context);
    await context.progress.advance('display-assets-published', {
      childSessionId: context.child.sessionId,
      ...(assets ? { assets } : {}),
      forkOrigin: forkOrigin(context.progress.manifest.request),
    });
    return assets;
  }

  private async probeDisplayAssets(context: ResumeContext): Promise<void> {
    const { request } = context.progress.manifest;
    const throughMessageId = context.boundary.assistant.msg_id ?? request.assistantDisplayMessageId;
    const displayProbe = request.sidePresentation ? undefined : this.deps.display.probePrefix;
    if (displayProbe) {
      const displayOwned = await displayProbe({
        sourceSessionId: context.source.sessionId,
        targetSessionId: context.child.sessionId,
        throughMessageId,
      });
      if (!displayOwned) {
        throw new ForkServiceError('fork-failed', 'Fork recovery Display prefix probe failed');
      }
    }
    const assets = context.progress.manifest.assets;
    const assetPort = this.deps.assets;
    const assetProbe = assetPort?.probe;
    if (!assets || !assetProbe) return;
    const assetsOwned = await probeAssetsBestEffort(assetProbe, context.child.sessionId, assets);
    if (assetsOwned) return;
    await ignoreFailure(() =>
      assetPort.compensate({
        targetSessionId: context.child.sessionId,
        ...(assets.mode ? { mode: assets.mode } : {}),
        ...(assets.targetRoot ? { targetRoot: assets.targetRoot } : {}),
        copiedPaths: assets.copiedPaths,
      }),
    );
    context.progress.merge({ assets: undefined });
  }

  private async copyDisplayAssets(
    context: ResumeContext,
  ): Promise<ForkOperationManifest['assets']> {
    if (!context.progress.manifest.request.sidePresentation) {
      const targetMessages = await this.deps.display.list(context.child.sessionId);
      if (!hasForkOrigin(targetMessages, context.source.sessionId)) {
        await this.copyDisplayProjection(context);
      }
    }
    const assets = this.deps.assets;
    const copiedAssets =
      !assets || context.progress.manifest.assets
        ? context.progress.manifest.assets
        : await copyAssetsBestEffort(assets, {
            sourceSessionId: context.source.sessionId,
            targetSessionId: context.child.sessionId,
            messageIds: displayPrefixMessageIds(context.boundary),
            ...(context.progress.manifest.request.isolatedWorktree
              ? {
                  mode: 'workspace-copy' as const,
                  sourceWorkspaceDir: context.source.workspaceDir,
                  targetWorkspaceDir: context.child.workspaceDir,
                }
              : { mode: 'records-only' as const }),
          });
    await this.deps.state?.copy({
      operationId: context.progress.manifest.request.operationId,
      sourceSessionId: context.source.sessionId,
      targetSessionId: context.child.sessionId,
      latestBoundary: context.boundary.isLatestConversationMessage,
      ...(context.progress.manifest.request.planState
        ? { planState: context.progress.manifest.request.planState }
        : {}),
    });
    return copiedAssets;
  }

  private async copyDisplayProjection(context: ResumeContext): Promise<void> {
    const copy = displayCopyInput(context);
    const atomicCopy = this.deps.display.copyPrefixAndAppendForkOrigin;
    if (atomicCopy) {
      await atomicCopy(copy);
      return;
    }
    await this.deps.display.copyPrefix(copy);
    await this.deps.display.appendForkOrigin({
      sourceSessionId: copy.sourceSessionId,
      targetSessionId: copy.targetSessionId,
    });
  }

  private async publishChild(
    context: ResumeContext,
    assets: ForkOperationManifest['assets'],
    hasExternalAdvance: boolean,
  ): Promise<ForkResumeResult> {
    const isSideFork = Boolean(context.progress.manifest.request.sidePresentation);
    if (context.stage === 'child-visible') {
      if (!isSideFork && context.child.visibility !== 'visible') {
        throw new ForkServiceError(
          'fork-failed',
          'Fork recovery child is not visible at child-visible stage',
        );
      }
      return this.completeResumedChild(context.progress, context.child, hasExternalAdvance);
    }
    const published = isSideFork
      ? context.child
      : await this.deps.sessions.update(context.child.sessionId, {
          visibility: 'visible',
        });
    if (!published) {
      throw new ForkServiceError(
        'fork-failed',
        'Fork recovery child session disappeared before publish',
      );
    }
    await context.progress.advance('child-visible', {
      childSessionId: context.child.sessionId,
      ...(assets ? { assets } : {}),
      ...(context.progress.manifest.forkOrigin
        ? {}
        : { forkOrigin: forkOrigin(context.progress.manifest.request) }),
    });
    return this.completeResumedChild(context.progress, published, hasExternalAdvance);
  }

  private async completeResumedChild(
    progress: ResumeProgress,
    child: SessionRecord,
    hasExternalAdvance: boolean,
  ): Promise<ForkResumeResult> {
    const result: ForkResult = {
      status: 'created',
      child,
      sourceDisplayMessageId: progress.manifest.request.assistantDisplayMessageId,
      ...(progress.manifest.historyRevision
        ? { historyRevision: progress.manifest.historyRevision }
        : {}),
    };
    if (!hasExternalAdvance) {
      await this.deps.operations.put(progress.manifest.request.operationId, result);
    }
    return { result, manifest: progress.manifest };
  }

  private async readBoundary(
    sessionId: string,
    assistantDisplayMessageId?: string,
    sideHistory?: { readonly throughMessageId?: string },
  ): Promise<ForkBoundary> {
    const resolved = await this.deps.boundary.resolve({
      sessionId,
      ...(sideHistory ? { sideHistory } : {}),
      ...(assistantDisplayMessageId === undefined ? {} : { assistantDisplayMessageId }),
    });
    if (!resolved) {
      throw new ForkServiceError(
        'assistant-not-found',
        'Fork recovery assistant message is missing',
      );
    }
    const { assistant } = resolved;
    if (assistant.role !== 'assistant' || isInvalidForkAssistant(assistant)) {
      throw new ForkServiceError(
        'assistant-not-settled',
        'Fork recovery requires a persisted assistant message',
      );
    }
    if (!hasCanonicalForkBoundary(resolved) && !resolved.isLatestConversationMessage) {
      throw new ForkServiceError(
        'invalid-boundary',
        'Fork recovery assistant boundary is no longer valid',
      );
    }
    return resolved;
  }

  /**
   * Internal true-fork entry point for TUI BTW. It deliberately delegates to
   * the same durable Fork workflow as the user-facing `/fork`, including the
   * committed-assistant boundary check, history copy and compensation path.
   */
  async forkSideSession(input: {
    readonly operationId: string;
    readonly parentSessionId: string;
    readonly purpose: string;
    readonly title?: string;
  }): Promise<SessionRecord> {
    const result = await this.fork({
      operationId: input.operationId,
      sourceSessionId: input.parentSessionId,
      title: input.title ?? 'BTW',
      useSuggestedTitle: false,
      isolatedWorktree: false,
      sidePresentation: {
        parentSessionId: input.parentSessionId,
        purpose: input.purpose,
      },
    });
    return result.child;
  }

  async fork(input: ForkRequest): Promise<ForkResult> {
    const prior = await this.deps.operations.get(input.operationId, input);
    if (prior) return { ...prior, status: 'duplicate' };
    const pending = await this.deps.operations.getPending?.(input.operationId);
    if (pending) return this.resumePending(input, pending);
    return this.startForkOwned(input);
  }

  private async resumePending(
    input: ForkRequest,
    pending: PendingForkOperation,
  ): Promise<ForkResult> {
    const stage = asRecoverableForkStage(pending.stage);
    if (pending.status !== 'running' || !stage || !pending.intent) {
      throw new ForkServiceError('fork-failed', 'Fork operation cannot resume its persisted stage');
    }
    if (!sameRequest(pending.intent.request, input)) {
      throw new ForkServiceError(
        'request-conflict',
        'Operation ID was already used for a different Fork request',
      );
    }
    const resumed = await this.resume({
      manifest: pending.intent,
      stage,
      advance: async ({ stage: nextStage, manifest }) => {
        await this.deps.operations.advance?.({
          operationId: input.operationId,
          status: 'running',
          stage: nextStage,
          intent: manifest,
        });
      },
    });
    await this.deps.operations.put(input.operationId, resumed.result);
    return resumed.result;
  }

  private async startForkOwned(input: ForkRequest): Promise<ForkResult> {
    const source = await this.requireSupportedSource(input.sourceSessionId, 'Fork');
    const boundary = await this.readBoundary(
      source.sessionId,
      input.assistantDisplayMessageId,
      input.sidePresentation ? {} : undefined,
    );
    const resolvedRequest = resolveForkRequest(input, boundary);
    this.assertForkBoundary(source, boundary, resolvedRequest);
    const progress = createStartProgress(this.deps.operations, resolvedRequest);
    await progress.advance('running', 'validated');
    try {
      const stage = await this.prepareStartWorktree(progress, source, boundary);
      const resumed = await this.resumeOwned({
        manifest: progress.manifest,
        stage,
        advance: ({ stage: nextStage, manifest }) =>
          progress.advance('running', nextStage, manifest),
      });
      await this.deps.operations.put(input.operationId, resumed.result);
      await progress.advance('completed', 'published', resumed.manifest);
      return resumed.result;
    } catch (error) {
      await this.compensateStart(progress);
      throw normalizeStartError(error);
    }
  }

  private async prepareStartWorktree(
    progress: StartProgress,
    source: ForkSource,
    boundary: ForkBoundary,
  ): Promise<RecoverableForkStage> {
    if (!progress.manifest.request.isolatedWorktree) return 'validated';
    assertWorktreeEligible(source);
    const adapter = this.deps.worktree;
    if (!adapter) {
      throw new ForkServiceError('worktree-unavailable', 'Isolated worktree Fork is unavailable');
    }
    try {
      const prepared = await adapter.prepare({
        operationId: progress.manifest.request.operationId,
        source,
        ...(isHistoricalCanonicalForkBoundary(boundary) ? { allowTargetMutation: true } : {}),
      });
      await progress.advance('running', 'worktree-prepared', {
        worktree: worktreeManifest(prepared),
      });
      return 'worktree-prepared';
    } catch (error) {
      throw new ForkServiceError(
        isWorktreeSourceChanged(error) ? 'worktree-source-changed' : 'worktree-unavailable',
        'Isolated worktree preparation failed',
        { cause: error },
      );
    }
  }

  private async compensateStart(progress: StartProgress): Promise<void> {
    const { manifest } = progress;
    await ignoreFailure(() =>
      progress.advance(
        'compensating',
        manifest.childSessionId ? 'compensating-child' : 'compensating-preparation',
      ),
    );
    if (manifest.childSessionId) await this.compensateChild(manifest);
    const adapter = this.deps.worktree;
    const worktree = manifest.worktree;
    if (adapter && worktree) {
      await ignoreFailure(() =>
        adapter.cleanup({
          operationId: manifest.request.operationId,
          workspaceDir: worktree.workspaceDir,
          ...(worktree.ownershipToken ? { ownershipToken: worktree.ownershipToken } : {}),
        }),
      );
    }
    await ignoreFailure(() => progress.advance('failed', 'compensated'));
  }

  private async compensateChild(manifest: ForkOperationManifest): Promise<void> {
    const childSessionId = manifest.childSessionId;
    if (!childSessionId) return;
    const assets = manifest.assets;
    const assetPort = this.deps.assets;
    if (assets && assetPort) {
      await ignoreFailure(() =>
        assetPort.compensate({
          targetSessionId: childSessionId,
          ...(assets.mode ? { mode: assets.mode } : {}),
          ...(assets.targetRoot ? { targetRoot: assets.targetRoot } : {}),
          copiedPaths: assets.copiedPaths,
        }),
      );
    }
    await ignoreFailure(() => this.deps.display.deleteSession(childSessionId));
    const state = this.deps.state;
    if (state) {
      await ignoreFailure(() => state.compensate({ targetSessionId: childSessionId }));
    }
    await ignoreFailure(() => this.deps.sessions.delete(childSessionId));
  }
}

const FORK_STAGE_ORDER: Readonly<Record<RecoverableForkStage, number>> = {
  validated: 0,
  'worktree-prepared': 1,
  'session-created': 2,
  'history-published': 3,
  'display-assets-published': 4,
  'worktree-reminder-published': 5,
  'child-visible': 6,
};

function stageAtOrBefore(stage: RecoverableForkStage, expected: RecoverableForkStage): boolean {
  return FORK_STAGE_ORDER[stage] <= FORK_STAGE_ORDER[expected];
}

function stageAtOrAfter(stage: RecoverableForkStage, expected: RecoverableForkStage): boolean {
  return FORK_STAGE_ORDER[stage] >= FORK_STAGE_ORDER[expected];
}

function createResumeProgress(input: ForkResumeInput): ResumeProgress {
  let manifest = input.manifest;
  return {
    get manifest() {
      return manifest;
    },
    merge: (patch) => {
      manifest = mergeManifest(manifest, patch);
    },
    advance: async (stage, patch) => {
      manifest = mergeManifest(manifest, patch);
      if (input.advance) await input.advance({ stage, manifest });
    },
  };
}

function createStartProgress(
  operations: ForkOperationPort,
  request: ResolvedForkRequest,
): StartProgress {
  let manifest: ForkOperationManifest = {
    schemaVersion: 1,
    request,
    source: {
      sessionId: request.sourceSessionId,
      assistantDisplayMessageId: request.assistantDisplayMessageId,
    },
  };
  return {
    get manifest() {
      return manifest;
    },
    advance: async (status, stage, patch) => {
      manifest = mergeManifest(manifest, patch);
      if (operations.advance) {
        await operations.advance({
          operationId: request.operationId,
          status,
          stage,
          intent: manifest,
        });
      }
    },
  };
}

function mergeManifest(
  current: ForkOperationManifest,
  patch: Partial<ForkOperationManifest> | undefined,
): ForkOperationManifest {
  if (!patch) return current;
  return {
    ...current,
    ...patch,
    source: { ...current.source, ...patch.source },
    ...(patch.request ? { request: patch.request } : {}),
  };
}

function isSupportedSource(source: SessionRecord, minimumVersion: number): boolean {
  return isConversationMutationEligibleSession(source, minimumVersion);
}

function assertWorktreeEligible(source: SessionRecord): void {
  if (source.appMode !== 'coding') {
    throw new ForkServiceError(
      'worktree-unavailable',
      'Isolated worktree Fork requires a Coding session',
    );
  }
}

function requireResumeChild(child: SessionRecord | undefined): SessionRecord {
  if (child) return child;
  throw new ForkServiceError('fork-failed', 'Fork recovery child session is missing');
}

function missingWorktreeProof(): ForkServiceError {
  return new ForkServiceError(
    'fork-failed',
    'Fork recovery requires persisted worktree ownership proof',
  );
}

async function probeRecoveredWorktree(
  operationId: string,
  persisted: NonNullable<ForkOperationManifest['worktree']>,
  probe: WorktreeProbe,
): Promise<NonNullable<ForkOperationManifest['worktree']>> {
  const probed = await probe({
    operationId,
    workspaceDir: persisted.workspaceDir,
    ...(persisted.ownershipToken ? { ownershipToken: persisted.ownershipToken } : {}),
    ...(persisted.fingerprint ? { fingerprint: persisted.fingerprint } : {}),
    ...(persisted.runLocation ? { runLocation: persisted.runLocation } : {}),
  });
  return {
    ...persisted,
    workspaceDir: probed.workspaceDir,
    ...(probed.runLocation ? { runLocation: probed.runLocation } : {}),
  };
}

function historyForkInput(context: ResumeContext) {
  const historicalBoundary = isHistoricalCanonicalForkBoundary(context.boundary);
  const request = context.progress.manifest.request;
  return {
    targetSessionId: context.child.sessionId,
    targetWorkspaceDir: context.worktree?.workspaceDir ?? context.child.workspaceDir,
    ...canonicalHistoryBoundaryInput(context.boundary),
    ...(context.worktree && historicalBoundary ? { rewindTargetWorkspace: true } : {}),
    operationId: request.operationId,
    ...(request.sidePresentation ? { hiddenContextBoundary: BTW_SIDE_BOUNDARY } : {}),
  };
}

function canonicalHistoryBoundaryInput(boundary: ForkBoundary) {
  if (boundary.sideHistoryMessageId) {
    return { throughMessageId: boundary.sideHistoryMessageId };
  }
  if (boundary.assistantCanonicalMessageId) {
    return { throughAssistantMessageId: boundary.assistantCanonicalMessageId };
  }
  if (boundary.beforeUserMessageId) {
    return { beforeUserMessageId: boundary.beforeUserMessageId };
  }
  return {};
}

function hasCanonicalForkBoundary(boundary: ForkBoundary): boolean {
  return Boolean(
    boundary.sideHistoryMessageId ??
    boundary.assistantCanonicalMessageId ??
    boundary.beforeUserMessageId,
  );
}

function isHistoricalCanonicalForkBoundary(boundary: ForkBoundary): boolean {
  return !boundary.isLatestConversationMessage && hasCanonicalForkBoundary(boundary);
}

function forkOrigin(
  request: ResolvedForkRequest,
): NonNullable<ForkOperationManifest['forkOrigin']> {
  return {
    sourceDisplayMessageId: request.assistantDisplayMessageId,
    operationId: request.operationId,
  };
}

function hasForkOrigin(
  messages: readonly DisplayMessageRecord[],
  sourceSessionId: string,
): boolean {
  return messages.some(
    (message) =>
      (message.kind === 'fork-origin' || message.displayKind === 'fork-origin') &&
      message.forkOrigin?.sourceSessionId === sourceSessionId,
  );
}

function displayPrefixMessageIds(boundary: ForkBoundary): readonly string[] {
  return boundary.messages
    .slice(0, boundary.assistantIndex + 1)
    .flatMap((message) => (message.msg_id ? [message.msg_id] : []));
}

function displayCopyInput(context: ResumeContext) {
  const request = context.progress.manifest.request;
  return {
    sourceSessionId: context.source.sessionId,
    targetSessionId: context.child.sessionId,
    throughMessageId: context.boundary.assistant.msg_id ?? request.assistantDisplayMessageId,
  };
}

function resolveChildTitle(request: ForkRequest, suggestedTitle: string): string {
  return request.useSuggestedTitle === true ? suggestedTitle : (request.title ?? suggestedTitle);
}

export async function suggestForkTitle(
  source: Pick<SessionRecord, 'agentName' | 'sessionId' | 'title'>,
  sessions: Pick<ForkSessionPort, 'titleExists'>,
): Promise<{ readonly title: string; readonly ordinal: number }> {
  const sourceTitle = source.title ?? source.sessionId;
  let ordinal = 1;
  while (
    await sessions.titleExists?.({
      agentName: source.agentName,
      title: `${ordinal} - ${sourceTitle}`,
    })
  ) {
    ordinal += 1;
  }
  return { title: `${ordinal} - ${sourceTitle}`, ordinal };
}

function worktreeManifest(
  prepared: PreparedWorktree,
): NonNullable<ForkOperationManifest['worktree']> {
  return {
    workspaceDir: prepared.workspaceDir,
    ...(prepared.runLocation ? { runLocation: prepared.runLocation } : {}),
    ...(prepared.ownershipToken ? { ownershipToken: prepared.ownershipToken } : {}),
    ...(prepared.fingerprint ? { fingerprint: prepared.fingerprint } : {}),
  };
}

function normalizeStartError(error: unknown): ForkServiceError {
  if (error instanceof ForkServiceError) return error;
  return new ForkServiceError(
    'fork-failed',
    'Fork workflow failed and owned resources were compensated',
    { cause: error },
  );
}

async function ignoreFailure(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch {
    // Best-effort compensation continues so every owned resource gets a cleanup attempt.
  }
}

async function copyAssetsBestEffort(
  assets: NonNullable<ForkServiceDependencies['assets']>,
  input: Parameters<NonNullable<ForkServiceDependencies['assets']>['copyPrefix']>[0],
): Promise<ForkOperationManifest['assets']> {
  try {
    return await assets.copyPrefix(input);
  } catch {
    await ignoreFailure(() =>
      assets.compensate({
        targetSessionId: input.targetSessionId,
        mode: input.mode,
        ...(input.mode === 'workspace-copy' ? { targetRoot: input.targetWorkspaceDir } : {}),
      }),
    );
    return undefined;
  }
}

async function probeAssetsBestEffort(
  probe: NonNullable<NonNullable<ForkServiceDependencies['assets']>['probe']>,
  targetSessionId: string,
  assets: NonNullable<ForkOperationManifest['assets']>,
): Promise<boolean> {
  try {
    return await probe({
      targetSessionId,
      ...(assets.mode ? { mode: assets.mode } : {}),
      ...(assets.targetRoot ? { targetRoot: assets.targetRoot } : {}),
      copiedPaths: assets.copiedPaths,
    });
  } catch {
    return false;
  }
}

function isUnsettled(message: DisplayMessageRecord): boolean {
  return (
    message.source === 'optimistic' || message.source === 'streaming' || message.source === 'error'
  );
}

function isInvalidForkAssistant(message: DisplayMessageRecord): boolean {
  return message.source === 'optimistic' || message.source === 'error';
}

function sameRequest(left: ResolvedForkRequest, right: ForkRequest): boolean {
  return (
    left.operationId === right.operationId &&
    left.sourceSessionId === right.sourceSessionId &&
    sameAssistantSelector(left.assistantDisplayMessageId, right.assistantDisplayMessageId) &&
    (left.title ?? null) === (right.title ?? null) &&
    Boolean(left.useSuggestedTitle) === Boolean(right.useSuggestedTitle) &&
    Boolean(left.isolatedWorktree) === Boolean(right.isolatedWorktree) &&
    sameSidePresentation(left.sidePresentation, right.sidePresentation) &&
    samePlanState(left.planState, right.planState)
  );
}

function sameAssistantSelector(persisted: string, requested: string | undefined): boolean {
  return requested === undefined || persisted === requested;
}

function resolveForkRequest(request: ForkRequest, boundary: ForkBoundary): ResolvedForkRequest {
  const assistantDisplayMessageId = boundary.assistant.msg_id;
  if (!assistantDisplayMessageId) {
    throw new ForkServiceError(
      'assistant-not-found',
      'Fork recovery assistant message identity is missing',
    );
  }
  return {
    ...request,
    assistantDisplayMessageId,
    ...(boundary.sideHistoryMessageId
      ? { sideHistoryMessageId: boundary.sideHistoryMessageId }
      : {}),
  };
}

function sameSidePresentation(
  left: ForkRequest['sidePresentation'],
  right: ForkRequest['sidePresentation'],
): boolean {
  return (
    (left?.parentSessionId ?? null) === (right?.parentSessionId ?? null) &&
    (left?.purpose ?? null) === (right?.purpose ?? null)
  );
}

function samePlanState(left: ForkRequest['planState'], right: ForkRequest['planState']): boolean {
  return (left?.interactionMode ?? null) === (right?.interactionMode ?? null);
}

function isWorktreeSourceChanged(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Source workspace changed during Fork');
}
