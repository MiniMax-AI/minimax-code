import { randomUUID } from 'node:crypto';

import type {
  AgentCompactionInput,
  AgentHostExecutionRequest,
  AgentHostUserInput,
  CompactionOutcome,
} from '../agent-host/contracts.js';
import { normalizeAbortSource } from '@mavis/agent-core/pi-turn-runner';
import type {
  AbortTurnInput,
  AbortTurnResult,
  InitializeTurnSystemOptions,
  UserStopAcceptance,
  UserStopCascadePort,
  UserStopCascadeRun,
  ActivateTurnResult,
  DirectTurnSubmission,
  QueueTurnSubmission,
  RequestCompactionResult,
  TurnSubmissionPreparation,
  TurnSubmissionPreparationResult,
} from '../contracts.js';
import type {
  AcceptedAgentTurn,
  ExecutionCoordinator,
  TurnController,
  TurnExecutionService,
  TurnExecutionSubmission,
  TurnSessionCapabilities,
} from './contracts.js';
import type { SessionOperationGate } from '../lifecycle/session-operation-gate.js';
import type { AdmitTurnInput, AdmitTurnResult, TurnRepository } from '../persistence/contracts.js';
import { digestTurnInput } from './turn-input-identity.js';
import { isUserAuthoredSource } from './message-query-authorship.js';

export interface TurnExecutionServiceOptions {
  readonly repository: TurnRepository;
  readonly controller: TurnController;
  readonly coordinator: ExecutionCoordinator;
  readonly operations: Pick<SessionOperationGate, 'tryRun' | 'tryAcquireExclusive'>;
  readonly onInterruptSendReleased?: (sessionId: string) => Promise<void>;
  readonly sessions: Pick<TurnSessionCapabilities, 'has'>;
  readonly submissionPreparation?: TurnSubmissionPreparation;
  readonly nowMs?: () => number;
  readonly makeTurnId?: () => string;
  /**
   * Host-injected user-stop cascade. TurnSystem deliberately knows nothing about
   * background tasks; the local Runtime composition supplies this seam so an
   * explicit user stop can also tear down the Session's background work.
   */
  readonly userStop?: UserStopCascadePort;
  /**
   * Same logger TurnSystem already hands to its sibling components. Optional so
   * embeddings and tests stay silent; only the user-stop skip path uses it.
   */
  readonly logger?: Pick<NonNullable<InitializeTurnSystemOptions['logger']>, 'info'>;
}

/** Durable admission, in-process ownership, and AgentHost execution only. */
export function createTurnExecutionService(
  options: TurnExecutionServiceOptions,
): TurnExecutionService {
  const nowMs = options.nowMs ?? Date.now;
  const makeTurnId = options.makeTurnId ?? (() => `turn_${randomUUID()}`);
  const pending = new PendingSubmissions();
  const context = { options, nowMs, makeTurnId, pending };

  return {
    submit: async (input) => {
      // FIFO queue delivery keeps its original semantics. Explicit sends (including
      // activation of a legacy send-now claim) replace the active Turn instead.
      if (input.clientIntent === 'cloud-handoff' && !isQueueSubmission(input)) {
        return submitInterruptingHandoff(context, input);
      }
      const result = await options.operations.tryRun(input.sessionId, () =>
        submitTurn(context, input),
      );
      return result.entered ? result.value : { accepted: false, reason: 'session-deleting' };
    },
    submitTrusted: (input) =>
      submitTurn(context, input, { bypassPriorityFence: true, bypassSessionMutation: true }),
    requestCompaction: async (input) => {
      const result = await options.operations.tryRun(input.sessionId, () =>
        beginCompaction(options, input, nowMs, makeTurnId),
      );
      if (!result.entered) return { accepted: false, reason: 'session-deleting' };
      const handoff = result.value;
      if (!handoff.accepted) return handoff;
      return {
        accepted: true,
        turnId: handoff.turnId,
        outcome: await handoff.run(),
      };
    },
    steerActiveTurn: async (input) => {
      const result = await options.operations.tryRun(input.sessionId, () =>
        options.controller.steerActiveTurn(input),
      );
      return result.entered ? result.value : { status: 'closing' };
    },
    abort: async (input) => {
      const activeTurnId = options.controller.activeTurnId(input.sessionId);
      // One identity rule for everything a stop may touch: it targets the current
      // Turn when it names no Turn, nothing is running, or it names the running
      // one. A stop that names an older Turn is rejected by the controller as
      // `turn-mismatch` (HTTP 409) before any side effect, so it must not open a
      // window, pause the Goal or cascade either — otherwise it would kill the
      // background work of the newer Turn the user is actually looking at.
      const targetsCurrentTurn = !input.turnId || !activeTurnId || input.turnId === activeTurnId;
      if (targetsCurrentTurn) pending.stop(input);
      // Open the suppression window BEFORE aborting, so a task driven terminal by
      // the abort cannot slip a delivery through. The Goal is NOT paused here: only
      // an accepted stop may do that (controller `onAccepted`, or `not-running`).
      const cascade = targetsCurrentTurn
        ? await beginUserStopCascade(options, input)
        : skipStaleUserStopCascade(options, input, activeTurnId);
      let result: AbortTurnResult;
      try {
        result = await options.controller.abort(withUserStopAcceptance(input, cascade));
      } catch (error) {
        // `begin` already opened the Session's delivery window. Without a result
        // there is no cascade to run, but the window must still be released —
        // otherwise every later completion notice of this Session would be held
        // as `busy` for the life of the process, worse than having no cascade.
        // The stop request itself keeps failing exactly as it did before.
        releaseUserStopCascade(cascade, 'abort_failed');
        throw error;
      }
      if (result.status === 'turn-mismatch') {
        // Race: the check above saw no conflict, but a newer Turn took over before
        // the abort landed, so the controller rejected it. Same outcome as a
        // stale stop — release the window, cascade nothing, and never `accept`:
        // a rejected stop must leave the Goal exactly as it was.
        releaseUserStopCascade(cascade, 'turn_mismatch');
        return result;
      }
      if (result.status === 'not-running') {
        // Nothing was running, so the controller had no identity to check and
        // never ran `onAccepted` — the stop is accepted as is. The Goal must be
        // paused here, BEFORE the cascade stops tasks: a terminal task wakes the
        // queue, and a live Goal would otherwise start a new Turn on its own.
        await acceptUserStopCascade(cascade, 'not_running');
      }
      // Detached on purpose: the cascade is a follow-up action and the stop
      // response must not wait for background teardown. `not-running` still
      // cascades: that is exactly the "Turn already finished but background work
      // is still running" case this feature exists for.
      cascade?.complete(result);
      return result;
    },
    activeTurnId: (sessionId) => options.controller.activeTurnId(sessionId),
  };
}

interface TurnExecutionContext {
  readonly options: TurnExecutionServiceOptions;
  readonly nowMs: () => number;
  readonly makeTurnId: () => string;
  readonly pending: PendingSubmissions;
}

/**
 * Starts the user-stop cascade for an explicit stop only.
 *
 * `session_leave` (TUI `/clear` and Session switching) deliberately does NOT
 * cascade: it pauses the old Session's Goal and Queue exactly like today, but
 * leaving a conversation must not kill the background build still running in it.
 */
async function beginUserStopCascade(
  options: TurnExecutionServiceOptions,
  input: AbortTurnInput,
): Promise<UserStopCascadeRun | undefined> {
  if (!options.userStop) return undefined;
  if (normalizeAbortSource(input.reason) !== 'user_stop') return undefined;
  try {
    return await options.userStop.begin(input.sessionId);
  } catch {
    // The stop itself is authoritative and must succeed even if the cascade
    // cannot start; this degrades to today's behaviour (no cascade).
    return undefined;
  }
}

/**
 * A stop naming an older Turn never cascades. Logged only when it WOULD have
 * cascaded (an explicit `user_stop` with the seam wired): that is the case worth
 * explaining later — e.g. a phone that still shows the previous Turn — while
 * every other stale abort stays as quiet as before.
 */
function skipStaleUserStopCascade(
  options: TurnExecutionServiceOptions,
  input: AbortTurnInput,
  activeTurnId: string | undefined,
): undefined {
  if (!options.userStop || normalizeAbortSource(input.reason) !== 'user_stop') return undefined;
  try {
    options.logger?.info(
      {
        event: 'user_stop_cascade_skipped',
        session_id: input.sessionId,
        requested_turn_id: input.turnId,
        active_turn_id: activeTurnId,
        reason: 'stale_turn_id',
      },
      'User stop names an older Turn; not cascading',
    );
  } catch {
    // Diagnostics must never change the outcome of a stop.
  }
  return undefined;
}

/**
 * Runs the cascade's accepted-stop side effects from inside the controller's own
 * `onAccepted`, i.e. only after its identity check passed. The caller's original
 * `onAccepted` (ConversationApplication's Goal pause) runs first and unchanged;
 * the cascade's pause is idempotent, so the overlap is harmless, and paths that
 * pass no `onAccepted` at all (IM `/stop`) now pause the Goal too.
 */
function withUserStopAcceptance(
  input: AbortTurnInput,
  cascade: UserStopCascadeRun | undefined,
): AbortTurnInput {
  if (!cascade) return input;
  return {
    ...input,
    onAccepted: async () => {
      await input.onAccepted?.();
      await acceptUserStopCascade(cascade, 'controller_accepted');
    },
  };
}

/** The port contract says `accept` never throws; guard anyway so a stop cannot fail on it. */
async function acceptUserStopCascade(
  cascade: UserStopCascadeRun | undefined,
  how: UserStopAcceptance,
): Promise<void> {
  try {
    await cascade?.accept(how);
  } catch {
    // Swallowed on purpose: accepting is a best-effort side effect of the stop.
  }
}

/**
 * Releases a cascade whose abort failed. The port contract says `cancel` never
 * throws; guarding anyway keeps a contract violation from replacing the abort's
 * own error, which the caller rethrows unchanged. The implementation logs.
 */
function releaseUserStopCascade(cascade: UserStopCascadeRun | undefined, reason: string): void {
  try {
    cascade?.cancel(reason);
  } catch {
    // Swallowed on purpose: the original abort failure is what must surface.
  }
}

interface SubmitTurnPolicy {
  readonly bypassPriorityFence?: boolean;
  readonly bypassSessionMutation?: boolean;
}

interface PendingSubmission {
  readonly sessionId: string;
  readonly turnId: string;
  stopped: boolean;
  onStop?: () => void;
}

/**
 * `TurnController` owns a Turn only from `register()` on, so an abort that lands while a
 * submission is still inside product preparation has nothing to stop and answers
 * `not-running`. Cloud handoff preparation scans the Workspace and asks the recommendation
 * model, which holds that window open for seconds — long enough for a user stop to be lost
 * while the prepared Turn starts afterwards. Submissions publish their identity here for
 * exactly that window.
 */
class PendingSubmissions {
  private readonly submissions = new Set<PendingSubmission>();

  enroll(sessionId: string, turnId: string): PendingSubmission {
    const submission: PendingSubmission = { sessionId, turnId, stopped: false };
    this.submissions.add(submission);
    return submission;
  }

  release(submission: PendingSubmission): void {
    this.submissions.delete(submission);
  }

  /** An abort without a `turnId` stops whatever this Session is currently starting. */
  stop(input: AbortTurnInput): void {
    for (const submission of this.submissions) {
      if (submission.sessionId !== input.sessionId) continue;
      if (!input.turnId || input.turnId === submission.turnId) {
        submission.stopped = true;
        submission.onStop?.();
      }
    }
  }
}

class StoppedBeforeRegistrationError extends DOMException {
  constructor() {
    super('Turn stopped before execution', 'AbortError');
  }
}

/** Only submissions enrolled before the abort observe it, so the next request still starts. */
const STOPPED_BEFORE_ADMISSION = {
  accepted: false,
  reason: 'policy:turn-abort:pre-admission',
  queueDisposition: 'cancel',
} as const;

async function submitInterruptingHandoff(
  context: TurnExecutionContext,
  input: DirectTurnSubmission,
): Promise<ActivateTurnResult> {
  const { options } = context;
  const lease = options.operations.tryAcquireExclusive(input.sessionId);
  if (!lease) return { accepted: false, reason: 'session-mutating' };
  const turnId = input.requestedTurnId ?? context.makeTurnId();
  const submission = context.pending.enroll(input.sessionId, turnId);
  let releaseNotification: Promise<void> | undefined;
  const release = () => {
    if (releaseNotification) return;
    lease.release();
    // Wake is best effort and must not delay the response behind another queued
    // item's preparation, or turn an accepted handoff into a transport failure.
    releaseNotification = notifyInterruptSendReleased(options, input.sessionId);
  };
  submission.onStop = release;
  try {
    const unavailable = await sessionUnavailable(options, input.sessionId);
    if (unavailable) return unavailable;
    // Drain already-entered submissions before observing the controller. They may
    // still be registering a Turn; aborting before that would miss the new owner.
    const drained = await waitForHandoffDrain(lease.drained);
    if (submission.stopped) return STOPPED_BEFORE_ADMISSION;
    if (!drained) {
      return { accepted: false, reason: 'policy:cloud-handoff:interrupt-timeout' };
    }
    const replay = await handoffReplay(options.repository, input, turnId);
    if (replay) return replay;
    if (submission.stopped) return STOPPED_BEFORE_ADMISSION;
    const interruptFailure = await interruptForHandoff(options.controller, submission);
    if (submission.stopped) return STOPPED_BEFORE_ADMISSION;
    if (interruptFailure) return interruptFailure;
    // Only this exclusive owner may overtake the ordinary queue. Product admission
    // and persistent session-mutation checks still run, AFTER the old Turn stops.
    return await submitTurn(
      context,
      { ...input, requestedTurnId: turnId },
      { bypassPriorityFence: true },
      submission,
    );
  } finally {
    context.pending.release(submission);
    // Abort settlement can wake the queue while the gate is held. Wake once more
    // after release, including preparation failures; never change QueuePaused.
    release();
  }
}

async function interruptForHandoff(
  controller: TurnController,
  submission: PendingSubmission,
): Promise<ActivateTurnResult | undefined> {
  const activeTurnId = controller.activeTurnId(submission.sessionId);
  if (!activeTurnId) return undefined;
  const stopped = await controller.abort({
    sessionId: submission.sessionId,
    turnId: activeTurnId,
    reason: 'immediate_send',
  });
  if (submission.stopped) return STOPPED_BEFORE_ADMISSION;
  if (stopped.status === 'abort-timeout') {
    return { accepted: false, reason: 'policy:cloud-handoff:interrupt-timeout' };
  }
  if (controller.activeTurnId(submission.sessionId)) {
    return { accepted: false, reason: 'active-turn' };
  }
  return undefined;
}

async function notifyInterruptSendReleased(
  options: TurnExecutionServiceOptions,
  sessionId: string,
): Promise<void> {
  try {
    await options.onInterruptSendReleased?.(sessionId);
  } catch {
    // Queue wake failure must not turn an accepted handoff into a send failure.
  }
}

async function handoffReplay(
  repository: TurnRepository,
  input: DirectTurnSubmission,
  turnId: string,
): Promise<ActivateTurnResult | undefined> {
  const receipt =
    (input.requestedTurnId ? await repository.findReceipt(turnId) : undefined) ??
    (input.clientRequestId
      ? await repository.findSteeringReceipt({
          sessionId: input.sessionId,
          clientRequestId: input.clientRequestId,
        })
      : undefined);
  if (!receipt) return undefined;
  return receipt.sessionId === input.sessionId &&
    receipt.inputDigest === digestTurnInput(input.input, input.clientIntent)
    ? { accepted: false, reason: 'duplicate', turnId: receipt.turnId }
    : { accepted: false, reason: 'ingress-conflict' };
}

async function handoffDrained(drained: Promise<void>): Promise<true> {
  await drained;
  return true;
}

async function waitForHandoffDrain(drained: Promise<void>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      handoffDrained(drained),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 30_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function submitTurn(
  context: TurnExecutionContext,
  input: TurnExecutionSubmission,
  policy: SubmitTurnPolicy = {},
  pendingSubmission?: PendingSubmission,
): Promise<ActivateTurnResult> {
  const { options } = context;
  const turnId = input.requestedTurnId ?? context.makeTurnId();
  const submission = pendingSubmission ?? context.pending.enroll(input.sessionId, turnId);
  try {
    // Enroll before the first asynchronous check so an early stop is not lost.
    const unavailable = await sessionUnavailable(options, input.sessionId);
    if (unavailable) return unavailable;

    const admission = await admitTurnWithSubmissionPreparation({
      options,
      input,
      turnId,
      candidateCreatedAtMs: input.candidateCreatedAtMs ?? context.nowMs(),
      policy,
      submission,
    });
    if (admission.status === 'settled') return admission.result;

    return await startAcceptedTurn(options, {
      input,
      turnId,
      admitted: admission.admitted,
      preparation: admission.preparation,
      submission,
    });
  } finally {
    context.pending.release(submission);
  }
}

type ReadySubmissionPreparation = Extract<
  TurnSubmissionPreparationResult,
  { readonly status: 'ready' }
>;

type TurnAdmissionResult =
  | {
      readonly status: 'ready';
      readonly admitted: Extract<AdmitTurnResult, { readonly status: 'accepted' }>;
      readonly preparation?: ReadySubmissionPreparation;
    }
  | { readonly status: 'settled'; readonly result: ActivateTurnResult };

async function admitTurnWithSubmissionPreparation(request: {
  readonly options: TurnExecutionServiceOptions;
  readonly input: TurnExecutionSubmission;
  readonly turnId: string;
  readonly candidateCreatedAtMs: number;
  readonly policy: SubmitTurnPolicy;
  readonly submission: PendingSubmission;
}): Promise<TurnAdmissionResult> {
  const { options, input, turnId, candidateCreatedAtMs, policy, submission } = request;
  const preparation = submission.stopped
    ? undefined
    : await options.submissionPreparation?.prepare(submissionPreparationCandidate(input, turnId));
  if (preparation?.status === 'rejected') {
    return settleRejectedPreparation(preparation, submission.stopped);
  }
  // A stop observed during preparation settles before durable admission: nothing durable is
  // written, so a late preparation result cannot start the Turn, and a Queue claim is cancelled
  // rather than deferred back for another dispatch.
  if (submission.stopped) {
    await preparation?.rollback();
    return {
      status: 'settled',
      result: STOPPED_BEFORE_ADMISSION,
    };
  }
  let admitted;
  try {
    admitted = await options.repository.admit(
      admissionInput(input, { turnId, candidateCreatedAtMs, ...policy }),
    );
  } catch (error) {
    await preparation?.rollback();
    throw error;
  }
  if (admitted.status !== 'accepted') {
    await preparation?.rollback();
    return { status: 'settled', result: rejection(admitted) };
  }
  try {
    await preparation?.commit();
  } catch (error) {
    let failure = error;
    try {
      await preparation?.compensate();
    } catch (restoreError) {
      failure = new AggregateError(
        [error, restoreError],
        'Turn admission succeeded but submission compensation failed',
      );
    }
    return {
      status: 'settled',
      result: await failAcceptedBeforeRegistration(options, {
        input,
        turnId,
        admitted,
        error: failure,
      }),
    };
  }
  return { status: 'ready', admitted, ...(preparation ? { preparation } : {}) };
}

function settleRejectedPreparation(
  preparation: Extract<TurnSubmissionPreparationResult, { readonly status: 'rejected' }>,
  stopped: boolean,
): TurnAdmissionResult {
  return {
    status: 'settled',
    result: stopped
      ? STOPPED_BEFORE_ADMISSION
      : {
          accepted: false,
          reason: preparation.reason,
          ...(preparation.queueDisposition
            ? { queueDisposition: preparation.queueDisposition }
            : {}),
        },
  };
}

function submissionPreparationCandidate(
  input: TurnExecutionSubmission,
  turnId: string,
): Parameters<TurnSubmissionPreparation['prepare']>[0] {
  return {
    sessionId: input.sessionId,
    turnId,
    provenance: submissionProvenance(input),
    ...(isQueueSubmission(input) ? { queueItemId: input.ingress.itemId } : {}),
    ...(input.clientIntent ? { clientIntent: input.clientIntent } : {}),
    ...(input.genuineUserQueryText ? { genuineUserQueryText: input.genuineUserQueryText } : {}),
    ...(!isQueueSubmission(input) && input.resume ? { userInputResume: input.resume } : {}),
  };
}

async function failAcceptedBeforeRegistration(
  options: TurnExecutionServiceOptions,
  failure: {
    readonly input: TurnExecutionSubmission;
    readonly turnId: string;
    readonly admitted: Extract<AdmitTurnResult, { readonly status: 'accepted' }>;
    readonly error: unknown;
  },
): Promise<ActivateTurnResult> {
  const failed = await options.coordinator.failAdmission({
    admission: {
      sessionId: failure.input.sessionId,
      turnId: failure.turnId,
      leaseId: failure.admitted.leaseId,
      acceptedSequence: failure.admitted.acceptedSequence,
      acceptedAtMs: failure.admitted.acceptedAtMs,
      busyReason: 'turn',
      ...(failure.admitted.foreground ? { foreground: true as const } : {}),
    },
    error: failure.error,
  });
  return {
    accepted: true,
    turnId: failure.turnId,
    acceptedAtMs: failure.admitted.acceptedAtMs,
    completion: failed.completion,
  };
}

interface AcceptedTurnSubmission {
  readonly input: TurnExecutionSubmission;
  readonly turnId: string;
  readonly admitted: Extract<AdmitTurnResult, { readonly status: 'accepted' }>;
  readonly preparation?: ReadySubmissionPreparation;
  readonly submission: PendingSubmission;
}

async function rollbackAcceptedSubmission(
  options: TurnExecutionServiceOptions,
  accepted: AcceptedTurnSubmission,
  error: unknown,
): Promise<ActivateTurnResult> {
  const { input, turnId, admitted, preparation } = accepted;
  const failure = await compensateStartedPreparation(preparation, error);
  let revoked = false;
  try {
    revoked = await options.repository.revokeAdmission({
      sessionId: input.sessionId,
      turnId,
      leaseId: admitted.leaseId,
      ...(admitted.queuePauseRevokeToken
        ? { queuePauseRevokeToken: admitted.queuePauseRevokeToken }
        : {}),
    });
  } catch {
    // A failed revoke leaves the durable receipt in place so a replay cannot
    // turn an uncertain admission into a duplicate delivery.
  }
  if (revoked) {
    if (error instanceof StoppedBeforeRegistrationError && failure === error) {
      return STOPPED_BEFORE_ADMISSION;
    }
    throw failure;
  }
  return failAcceptedBeforeRegistration(options, {
    input,
    turnId,
    admitted,
    error: failure,
  });
}

async function startAcceptedTurn(
  options: TurnExecutionServiceOptions,
  accepted: AcceptedTurnSubmission,
): Promise<ActivateTurnResult> {
  const { input, turnId, admitted, preparation, submission } = accepted;
  const admission = {
    sessionId: input.sessionId,
    turnId,
    leaseId: admitted.leaseId,
    acceptedSequence: admitted.acceptedSequence,
    acceptedAtMs: admitted.acceptedAtMs,
    busyReason: 'turn' as const,
    ...(admitted.foreground ? { foreground: true as const } : {}),
  };
  try {
    if (submission.stopped) throw new StoppedBeforeRegistrationError();
    if (!isQueueSubmission(input)) {
      await input.preDelivery?.accept({ mode: 'activated', turnId });
    }
    if (submission.stopped) throw new StoppedBeforeRegistrationError();
  } catch (error) {
    return rollbackAcceptedSubmission(options, accepted, error);
  }
  let turn: AcceptedAgentTurn;
  try {
    turn = options.controller.register(admission);
  } catch (error) {
    const failure = await compensateStartedPreparation(preparation, error);
    const failed = await options.coordinator.failAdmission({ admission, error: failure });
    return {
      accepted: true,
      turnId,
      acceptedAtMs: admitted.acceptedAtMs,
      completion: failed.completion,
    };
  }
  try {
    const started = await options.coordinator.startTurn({
      turn,
      request: hostRequest(input),
      ...(input.executionStart ? { executionStart: input.executionStart } : {}),
    });
    return {
      accepted: true,
      turnId,
      acceptedAtMs: admitted.acceptedAtMs,
      completion: started.completion,
    };
  } catch (error) {
    const failure = await compensateStartedPreparation(preparation, error);
    const failed = await options.coordinator.failTurn({ turn, error: failure });
    return {
      accepted: true,
      turnId,
      acceptedAtMs: admitted.acceptedAtMs,
      completion: failed.completion,
    };
  }
}

async function compensateStartedPreparation(
  preparation: ReadySubmissionPreparation | undefined,
  error: unknown,
): Promise<unknown> {
  if (!preparation) return error;
  try {
    await preparation.compensate();
    return error;
  } catch (compensationError) {
    return new AggregateError(
      [error, compensationError],
      'Turn start failed and submission compensation also failed',
    );
  }
}

type CompactionHandoff =
  | Exclude<RequestCompactionResult, { readonly accepted: true }>
  | {
      readonly accepted: true;
      readonly turnId: string;
      readonly run: () => Promise<CompactionOutcome>;
    };

async function beginCompaction(
  options: TurnExecutionServiceOptions,
  input: Parameters<TurnExecutionService['requestCompaction']>[0],
  nowMs: () => number,
  makeTurnId: () => string,
): Promise<CompactionHandoff> {
  const unavailable = await sessionUnavailable(options, input.sessionId);
  if (unavailable) return unavailable;
  const turnId = input.requestedTurnId ?? makeTurnId();
  const admitted = await options.repository.admit(
    compactionAdmission(input, turnId, input.candidateCreatedAtMs ?? nowMs()),
  );
  if (admitted.status !== 'accepted') return rejection(admitted);
  const admission = {
    sessionId: input.sessionId,
    turnId,
    leaseId: admitted.leaseId,
    acceptedSequence: admitted.acceptedSequence,
    acceptedAtMs: admitted.acceptedAtMs,
    busyReason: 'compaction' as const,
  };
  let turn;
  try {
    turn = options.controller.register(admission);
  } catch (error) {
    return {
      accepted: true,
      turnId,
      run: async () => {
        const failed = await options.coordinator.failAdmission({ admission, error });
        return failed.completion;
      },
    };
  }
  return {
    accepted: true,
    turnId,
    run: () => runCompaction(options, input, turn),
  };
}

async function runCompaction(
  options: TurnExecutionServiceOptions,
  input: Parameters<TurnExecutionService['requestCompaction']>[0],
  turn: Parameters<ExecutionCoordinator['compact']>[0]['lease'],
): Promise<CompactionOutcome> {
  try {
    await input.onStarted?.();
  } catch {
    // Delivery acknowledgement is observational and cannot strand an admitted compaction lease.
  }
  return options.coordinator.compact(compactionInput(turn, input));
}

async function sessionUnavailable(
  options: TurnExecutionServiceOptions,
  sessionId: string,
): Promise<
  { readonly accepted: false; readonly reason: 'invalid-session' | 'session-deleting' } | undefined
> {
  if (!(await options.sessions.has(sessionId))) {
    return { accepted: false, reason: 'invalid-session' };
  }
  if (await options.repository.isSessionDeleting(sessionId)) {
    return { accepted: false, reason: 'session-deleting' };
  }
  return undefined;
}

function admissionInput(
  input: TurnExecutionSubmission,
  values: {
    readonly turnId: string;
    readonly candidateCreatedAtMs: number;
    readonly bypassPriorityFence?: boolean;
    readonly bypassSessionMutation?: boolean;
  },
): AdmitTurnInput {
  const base = admissionBase(input, values);
  if (isQueueSubmission(input)) {
    return {
      ...base,
      priority: queueAdmissionPriority(input, values.candidateCreatedAtMs),
      queueIngress: input.ingress,
      ...(input.ingress.clientRequestId ? { clientRequestId: input.ingress.clientRequestId } : {}),
    };
  }
  return {
    ...base,
    priority: directAdmissionPriority(input, values.candidateCreatedAtMs),
    ...(input.resume ? { userInputResume: input.resume } : {}),
    ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
  };
}

function admissionBase(
  input: TurnExecutionSubmission,
  values: {
    readonly turnId: string;
    readonly candidateCreatedAtMs: number;
    readonly bypassPriorityFence?: boolean;
    readonly bypassSessionMutation?: boolean;
  },
) {
  const foreground = isForegroundTurn(input);
  return {
    sessionId: input.sessionId,
    turnId: values.turnId,
    busyReason: 'turn' as const,
    inputDigest: digestTurnInput(input.input, input.clientIntent),
    inputMetadata: metadata(input.input),
    candidateCreatedAtMs: values.candidateCreatedAtMs,
    ...genuineUserAdmission(input),
    ...(foreground ? { foreground: true as const } : {}),
    ...(consumesQueuePause(input, foreground) ? { consumeQueuePause: true as const } : {}),
    ...(input.clientIntent ? { clientIntent: input.clientIntent } : {}),
    ...(values.bypassPriorityFence ? { bypassPriorityFence: true as const } : {}),
    ...(values.bypassSessionMutation ? { bypassSessionMutation: true as const } : {}),
  };
}

function queueAdmissionPriority(
  input: QueueTurnSubmission,
  candidateCreatedAtMs: number,
): AdmitTurnInput['priority'] {
  if (input.queueSelection === 'exact') {
    return { kind: 'selected-queue-item', queueClaimId: input.ingress.claimId };
  }
  // An exact claim already bypasses queue order, so the yield only has to reach
  // the two fenced selections.
  const yielded =
    input.yieldedQueueItemIds && input.yieldedQueueItemIds.length > 0
      ? { yieldedQueueItemIds: input.yieldedQueueItemIds }
      : {};
  if (input.queueSelection === 'continued-fifo') {
    return { kind: 'continued-queue-head', queueClaimId: input.ingress.claimId, ...yielded };
  }
  return { kind: 'fifo', candidateCreatedAtMs, queueClaimId: input.ingress.claimId, ...yielded };
}

function directAdmissionPriority(
  input: DirectTurnSubmission,
  candidateCreatedAtMs: number,
): AdmitTurnInput['priority'] {
  if (input.admissionPriority) return input.admissionPriority;
  if (isPausedQueueSend(input.clientIntent)) return { kind: 'paused-queue-send' };
  return { kind: 'fifo', candidateCreatedAtMs };
}

function consumesQueuePause(input: TurnExecutionSubmission, foreground: boolean): boolean {
  if (isQueueSubmission(input)) return input.queueSelection === 'continued-fifo';
  return (
    foreground &&
    input.clientIntent !== 'retry-continuation' &&
    input.clientIntent !== 'cloud-handoff'
  );
}

function isForegroundTurn(input: TurnExecutionSubmission): boolean {
  if (!isQueueSubmission(input)) {
    if (input.executionMode === 'continuation') return true;
    if (input.resume) return false;
    if (isPausedQueueSend(input.clientIntent)) return true;
  }
  const source = submissionProvenance(input).source;
  return source === 'conversation-mutation' || isUserAuthoredSource(source);
}

function isPausedQueueSend(clientIntent: string | undefined): boolean {
  return clientIntent === 'paused-queue-keep' || clientIntent === 'paused-queue-clear';
}

function genuineUserAdmission(
  input: TurnExecutionSubmission,
): Pick<AdmitTurnInput, 'genuineUserMessage'> {
  return isGenuineUserMessage(input) ? { genuineUserMessage: true } : {};
}

function isGenuineUserMessage(input: TurnExecutionSubmission): boolean {
  if (input.genuineUserQueryText.length > 0) return true;
  if (!input.input.attachments?.length) return false;
  const source = isQueueSubmission(input)
    ? input.ingress.provenance.source
    : input.provenance.source;
  return isUserAuthoredSource(source);
}

function compactionAdmission(
  input: Parameters<TurnExecutionService['requestCompaction']>[0],
  turnId: string,
  candidateCreatedAtMs: number,
): AdmitTurnInput {
  return {
    sessionId: input.sessionId,
    turnId,
    busyReason: 'compaction',
    inputDigest: digestTurnInput({
      text: input.reason ?? '',
      origin: input.customInstructions ?? '',
    }),
    inputMetadata: { attachmentCount: 0, hasContent: Boolean(input.reason) },
    candidateCreatedAtMs,
    priority: { kind: 'fifo', candidateCreatedAtMs },
  };
}

function compactionInput(
  lease: AgentCompactionInput['lease'],
  input: Parameters<TurnExecutionService['requestCompaction']>[0],
): AgentCompactionInput {
  return {
    lease,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.customInstructions ? { customInstructions: input.customInstructions } : {}),
  };
}

function hostRequest(input: TurnExecutionSubmission): AgentHostExecutionRequest {
  const common = commonHostRequest(input);
  if (isQueueSubmission(input)) {
    const userMessageId = queueUserMessageId(input);
    return {
      ...common,
      provenance: input.ingress.provenance,
      queueItemIds: [input.ingress.itemId],
      ...(input.ingress.clientRequestId ? { clientRequestId: input.ingress.clientRequestId } : {}),
      ...(userMessageId ? { userMessageId } : {}),
    };
  }
  return {
    ...common,
    provenance: input.provenance,
    ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
    ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
    ...(input.executionMode ? { executionMode: input.executionMode } : {}),
  };
}

function commonHostRequest(input: TurnExecutionSubmission) {
  return {
    input: input.input,
    ...(!isQueueSubmission(input) && input.outputContract
      ? { outputContract: input.outputContract }
      : {}),
    ...(!isQueueSubmission(input) && input.executionDeadlineAtMs !== undefined
      ? { executionDeadlineAtMs: input.executionDeadlineAtMs }
      : {}),
    ...(input.immediateSendBatch
      ? {
          immediateSendBatch: {
            id: input.immediateSendBatch.id,
            members: input.immediateSendBatch.members.map((member) => ({
              input: {
                text: member.message.content,
                attachments: member.message.attachments,
                ...(member.message.quotedMessage
                  ? { quotedMessage: member.message.quotedMessage }
                  : {}),
              },
              genuineUserQueryText: member.message.displayContent ?? member.message.content,
              userMessageId: member.userMessageId,
              messageKey: member.messageKey,
              createdAt: member.createdAt,
              provenance: member.provenance,
            })),
          },
        }
      : {}),
    genuineUserQueryText: input.genuineUserQueryText,
    ...(input.inputSafetyDecision ? { inputSafetyDecision: input.inputSafetyDecision } : {}),
    ...(input.requiresInputReview ? { requiresInputReview: true as const } : {}),
    ...(input.clientIntent ? { clientIntent: input.clientIntent } : {}),
  };
}

function queueUserMessageId(input: QueueTurnSubmission) {
  if (
    input.userMessageId &&
    input.ingress.userMessageId &&
    input.userMessageId !== input.ingress.userMessageId
  ) {
    throw new Error('Queue user message identity changed before AgentHost execution');
  }
  return input.userMessageId ?? input.ingress.userMessageId;
}

function isQueueSubmission(input: TurnExecutionSubmission): input is QueueTurnSubmission {
  return 'ingress' in input;
}

function submissionProvenance(input: TurnExecutionSubmission) {
  return isQueueSubmission(input) ? input.ingress.provenance : input.provenance;
}

function rejection(input: Exclude<AdmitTurnResult, { readonly status: 'accepted' }>) {
  if (input.status === 'duplicate') {
    return { accepted: false as const, reason: 'duplicate' as const, turnId: input.turnId };
  }
  return { accepted: false as const, reason: input.reason };
}

function metadata(input: AgentHostUserInput) {
  return {
    attachmentCount: input.attachments?.length ?? 0,
    hasContent: input.text.length > 0,
  };
}
