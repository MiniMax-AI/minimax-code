import {
  type GoalTurnSignal,
  type ThreadGoalDecisionStaleReason,
  type ThreadGoalSettleBoundTurnInput,
  type ThreadGoalState,
  type ThreadGoalStore,
  type ThreadGoalVerification,
  VerificationDispatchError,
  assembleVerificationEvidence,
  type TranscriptWindowReader,
  type VerificationAttempt,
  type VerifierPort,
  verificationModeForRoute,
} from '@mavis/goal';
import { resolveModelCallRoute } from '@mavis/config';

import { parseSourceQualifiedModelKey } from '../config/model-key.js';
import { loadUserImages } from '../messages/input.js';
import { classifyThreadGoalBindingStale } from './binding-stale.js';
import type { ThreadGoalRuntimeEvent } from './events.js';
import {
  threadGoalEvaluatorMaxTokens,
  threadGoalSubagentMaxTokens,
  threadGoalVerifierEvidenceMode,
  type ThreadGoalGateConfig,
} from './gate.js';
import type { ThreadGoalVerificationSettlementContext } from './verification-context.js';

interface ThreadGoalVerificationDispatchDeps {
  readonly store: Pick<ThreadGoalStore, 'getById'>;
  readonly nowMs: () => number;
  readonly configGetter: () => ThreadGoalGateConfig;
  readonly reportFailure: (sessionId: string, message: string) => void;
  readonly formatError: (error: unknown) => string;
  readonly emitRuntimeEvent: (event: ThreadGoalRuntimeEvent) => void;
  /**
   * Publish / retire the `verification` execution wait around one dispatch.
   *
   * Both are best-effort explanations, never gates: the owner swallows write
   * failures so a projection problem can never change whether a Goal gets
   * verified.
   */
  readonly projectVerificationWait: (attempt: VerificationAttempt) => Promise<void>;
  readonly clearVerificationWait: (attempt: VerificationAttempt) => Promise<void>;
}

export class ThreadGoalVerificationDispatcher {
  private verifier?: VerifierPort;
  private transcriptWindowReader?: TranscriptWindowReader;
  /**
   * In-flight verifier dispatches, keyed by session. A verification can run for
   * an unbounded amount of time when no timeout is configured, so the host must
   * be able to cancel it when the user stops the turn, the Goal is retracted, or
   * the Goal is deleted — none of which are visible to the adapter.
   */
  private readonly inFlight = new Map<string, Set<AbortController>>();

  constructor(private readonly deps: ThreadGoalVerificationDispatchDeps) {}

  bind(verifier: VerifierPort, transcriptWindowReader: TranscriptWindowReader): void {
    this.verifier = verifier;
    this.transcriptWindowReader = transcriptWindowReader;
  }

  /**
   * Cancel every verification still running for this session. Adapters surface
   * the cancellation as `aborted`, which settles as `paused(verifier_aborted)`
   * rather than being mistaken for a verifier defect.
   */
  abortSession(sessionId: string, reason: string): void {
    const controllers = this.inFlight.get(sessionId);
    if (!controllers) return;
    this.inFlight.delete(sessionId);
    for (const controller of controllers) {
      controller.abort(new VerificationAbortedError(reason));
    }
  }

  async applyPolicy(context: ThreadGoalVerificationSettlementContext): Promise<void> {
    const verification = this.resolveMode(context);
    if (verification === 'none' || !claimsCompletion(context)) {
      context.proposedTransition = workerProposalTransition(context.signal);
      return;
    }
    if (!this.verifier || !this.transcriptWindowReader) {
      context.proposedTransition = unavailableTransition();
      return;
    }
    if (!context.input.workerModelKey) {
      context.proposedTransition = routeUnavailableTransition();
      return;
    }

    const canDispatch = await this.preflight(context);
    if (!canDispatch) return;
    const maxTokens = this.verifierMaxTokens(verification);

    const transcriptWindow = await this.captureTranscript(context);
    if (!transcriptWindow) return;

    const attempt: VerificationAttempt = {
      goalId: context.goal.goalId,
      sessionId: context.input.sessionId,
      goalUpdatedAt: context.goal.updatedAt,
      hostContext: {
        completionProposal: {
          observed: true,
          status: 'complete',
          turnId: context.input.turnId,
        },
        settlement: {
          phase: 'awaiting_verifier',
          durableStatusAtDispatch: 'active',
          transitionOnMet: 'complete(verifier_met)',
        },
      },
      objective: context.goal.objective,
      objectiveResources: context.goal.objectiveResources,
      objectiveDigest: context.accounting.boundTurn.binding.objectiveDigest,
      turnId: context.input.turnId,
      transcriptWindow,
      evidence: assembleVerificationEvidence({
        mode: threadGoalVerifierEvidenceMode(this.deps.configGetter),
        objectiveDigest: context.accounting.boundTurn.binding.objectiveDigest,
        claim: context.signal?.summary?.trim() || context.input.finalAssistantText,
        transcriptWindow,
      }),
      ...(context.input.finalAssistantText !== undefined
        ? { finalAssistantText: context.input.finalAssistantText }
        : {}),
      ...(context.signal?.summary ? { completionSummary: context.signal.summary } : {}),
      backend: verification,
      workerModelKey: context.input.workerModelKey,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    };
    context.verificationAttempt = attempt;
    this.emitDispatched(attempt);
    // Announce the wait *before* awaiting. A verifier is a real child agent and
    // routinely runs for minutes, during which the Goal is `active` but running
    // no Turn — without this projection both clients render a Goal that looks
    // stuck. The write is epoch-stamped, so any decision that advances the epoch
    // (the verdict itself, a user PATCH, a pause) retires it automatically.
    await this.deps.projectVerificationWait(attempt);
    try {
      context.verificationOutcome = await this.dispatch(attempt);
    } finally {
      // Belt and braces for the paths that do *not* advance the epoch: a
      // dispatch failure settles later in the pipeline, and an abort may settle
      // nowhere at all. Clearing here is epoch-guarded, so when the verdict has
      // already moved the epoch this is a no-op rather than a second event.
      await this.deps.clearVerificationWait(attempt);
    }
  }

  private resolveMode(context: ThreadGoalVerificationSettlementContext): ThreadGoalVerification {
    const config = this.deps.configGetter();
    const configured = config.goal?.verification;
    if (configured !== undefined) return configured;

    const providerId = parseSourceQualifiedModelKey(context.input.workerModelKey)?.providerId;
    if (!providerId) return 'none';
    return verificationModeForRoute(resolveModelCallRoute(config, providerId));
  }

  private async preflight(context: ThreadGoalVerificationSettlementContext): Promise<boolean> {
    try {
      const current = await this.deps.store.getById(context.goal.goalId);
      if (
        current?.lastVerification?.turnId === context.input.turnId &&
        current.lastVerification.objectiveDigest ===
          context.accounting.boundTurn.binding.objectiveDigest
      ) {
        context.goal = current;
        context.verificationAlreadyRecorded = true;
        return false;
      }
      const staleReason = currentVerificationStaleReason(context, current);
      if (!staleReason) return true;
      context.verificationPreDispatchStale = {
        stage: 6,
        action: 'stale',
        reason: staleReason,
        ...(current ? { goalId: current.goalId, decisionEpoch: current.updatedAt } : {}),
      };
      return false;
    } catch (error) {
      this.report(context, 'thread_goal_verifier_preflight_failed', error);
      context.proposedTransition = unavailableTransition();
      return false;
    }
  }

  private async captureTranscript(
    context: ThreadGoalVerificationSettlementContext,
  ): Promise<Awaited<ReturnType<TranscriptWindowReader['capture']>> | undefined> {
    try {
      return await this.transcriptWindowReader?.capture(context.input.sessionId);
    } catch (error) {
      this.report(context, 'thread_goal_verifier_snapshot_failed', error);
      context.proposedTransition = unavailableTransition();
      return undefined;
    }
  }

  private async dispatch(
    attempt: VerificationAttempt,
  ): Promise<NonNullable<ThreadGoalVerificationSettlementContext['verificationOutcome']>> {
    const controller = this.registerInFlight(attempt.sessionId);
    try {
      // The evaluator has no tools. Reload the persisted screenshots under
      // the dispatch abort controller so restart and compaction lose no images.
      const resources = (attempt.objectiveResources ?? []).filter(
        (resource) => resource.type === 'image',
      );
      const images =
        attempt.backend === 'evaluator' && resources.length
          ? await loadUserImages(resources)
          : undefined;
      controller.signal.throwIfAborted();
      const objectiveImages = images?.flatMap((image) =>
        image.data ? [{ data: image.data, mimeType: image.mime }] : [],
      );
      if (attempt.backend === 'evaluator' && (objectiveImages?.length ?? 0) !== resources.length) {
        throw new VerificationDispatchError(
          'api_error',
          'A persisted Goal screenshot could not be loaded for verification.',
          { tokens: 0, activeSeconds: 0, incomplete: false },
        );
      }
      const result = await this.verifier?.dispatch(
        {
          ...attempt,
          ...(objectiveImages?.length ? { objectiveImages } : {}),
        },
        controller.signal,
      );
      if (!result) {
        return { type: 'failure', error: unavailableDispatchError() };
      }
      return result.backend === attempt.backend
        ? { type: 'result', result }
        : {
            type: 'failure',
            error: new VerificationDispatchError(
              'schema_error',
              `Verifier backend mismatch: expected ${attempt.backend}, received ${result.backend}.`,
              result.usage,
            ),
          };
    } catch (error) {
      return { type: 'failure', error: this.dispatchFailure(controller, error) };
    } finally {
      this.releaseInFlight(attempt.sessionId, controller);
    }
  }

  private dispatchFailure(controller: AbortController, error: unknown): VerificationDispatchError {
    if (error instanceof VerificationDispatchError) return error;
    // An adapter that rejects without classifying still tells us the truth via
    // our own controller: we only abort it on a host lifecycle event.
    const code = controller.signal.aborted ? 'aborted' : 'api_error';
    return new VerificationDispatchError(
      code,
      this.deps.formatError(error),
      { tokens: null, activeSeconds: 0, incomplete: true },
      { cause: error },
    );
  }

  private registerInFlight(sessionId: string): AbortController {
    const controller = new AbortController();
    const existing = this.inFlight.get(sessionId);
    if (existing) existing.add(controller);
    else this.inFlight.set(sessionId, new Set([controller]));
    return controller;
  }

  /**
   * Abort on the way out so the adapter's timeout timers and signal listeners
   * are released even on the success path; a settled verification can never be
   * cancelled retroactively because the result has already been returned.
   */
  private releaseInFlight(sessionId: string, controller: AbortController): void {
    const controllers = this.inFlight.get(sessionId);
    if (controllers) {
      controllers.delete(controller);
      if (controllers.size === 0) this.inFlight.delete(sessionId);
    }
    if (!controller.signal.aborted) controller.abort(new VerificationSettledError());
  }

  /**
   * The configured per-attempt output cap, and nothing else.
   *
   * The cap is a response-size ceiling for one verifier attempt, independent
   * of the Goal budget gate: a Goal that has burned its token budget still
   * gets verified — the budget gate stops the *worker*, and a Goal that
   * cannot be verified would only pause on a reason nobody can act on. What
   * the attempt actually spends is charged afterwards: subagent-backend usage
   * draws against `goal.tokensUsed` in
   * `ThreadGoalVerificationSettlement.chargeVerifierUsage`, evaluator-backend usage is
   * report-only.
   */
  private verifierMaxTokens(backend: VerificationAttempt['backend']): number | undefined {
    return backend === 'subagent'
      ? threadGoalSubagentMaxTokens(this.deps.configGetter)
      : threadGoalEvaluatorMaxTokens(this.deps.configGetter);
  }

  private emitDispatched(attempt: VerificationAttempt): void {
    this.deps.emitRuntimeEvent({
      type: 'goal.verification_dispatched',
      at: this.deps.nowMs(),
      payload: {
        goalId: attempt.goalId,
        sessionId: attempt.sessionId,
        turnId: attempt.turnId,
        backend: attempt.backend,
        goalUpdatedAt: attempt.goalUpdatedAt,
      },
    });
  }

  private report(
    context: ThreadGoalVerificationSettlementContext,
    code: string,
    error: unknown,
  ): void {
    this.deps.reportFailure(context.input.sessionId, `${code}:${this.deps.formatError(error)}`);
  }
}

/**
 * Verification adjudicates exactly one thing: the worker's claim that the
 * objective is done. A turn that makes no such claim has nothing to adjudicate,
 * so it settles on the worker's own proposal — `blocked(worker_reported)` for an
 * explicit block, otherwise another continuation.
 *
 * `collectSignal` only accepts a proposal on a `main` bound turn, so the kind
 * check that used to guard dispatch separately lives here now.
 */
function claimsCompletion(context: ThreadGoalVerificationSettlementContext): boolean {
  return (
    context.accounting.boundTurn.kind === 'main' && context.signal?.type === 'completion_proposed'
  );
}

function workerProposalTransition(
  signal: GoalTurnSignal | undefined,
): ThreadGoalSettleBoundTurnInput['next'] | undefined {
  if (signal?.type === 'block_proposed') {
    return { status: 'blocked', statusReason: 'blocked(worker_reported)' };
  }
  return signal?.type === 'completion_proposed'
    ? { status: 'complete', statusReason: 'complete(worker_proposal)' }
    : undefined;
}

function currentVerificationStaleReason(
  context: ThreadGoalVerificationSettlementContext,
  current: ThreadGoalState | undefined,
): ThreadGoalDecisionStaleReason | undefined {
  return classifyThreadGoalBindingStale(current, {
    expectedEpoch: context.goal.updatedAt,
    objectiveDigest: context.accounting.boundTurn.binding.objectiveDigest,
  });
}

function unavailableTransition(): ThreadGoalSettleBoundTurnInput['next'] {
  return { status: 'paused', statusReason: 'paused(verifier_unavailable)' };
}

function routeUnavailableTransition(): ThreadGoalSettleBoundTurnInput['next'] {
  return { status: 'paused', statusReason: 'paused(route_unavailable)' };
}

function unavailableDispatchError(): VerificationDispatchError {
  return new VerificationDispatchError('api_error', 'Goal verifier is unavailable.', {
    tokens: null,
    activeSeconds: 0,
    incomplete: true,
  });
}

/** Host lifecycle cancellation: the user stopped, retracted, or deleted the Goal. */
export class VerificationAbortedError extends Error {
  override readonly name = 'VerificationAbortedError';

  constructor(reason: string) {
    super(`Goal verification was aborted: ${reason}.`);
  }
}

/** Post-settlement cleanup abort. Never observed by a caller — see releaseInFlight. */
class VerificationSettledError extends Error {
  override readonly name = 'VerificationSettledError';

  constructor() {
    super('Goal verification already settled.');
  }
}
