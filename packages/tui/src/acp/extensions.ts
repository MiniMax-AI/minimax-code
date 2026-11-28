import { randomUUID } from 'node:crypto';

import * as acp from '@agentclientprotocol/sdk';

import type { TuiDelegationSnapshot, TuiSession } from '../runtime/port.js';
import { projectTuiAcpHistoryMessage } from './history-updates.js';
import type { TuiAcpRuntime } from './runtime.js';
import { TuiAcpUpdateProjector } from './updates.js';

export const TUI_ACP_EXTENSION_VERSION = 1;

const DELEGATION_TRANSCRIPT_DEFAULT_LIMIT = 50;
const DELEGATION_TRANSCRIPT_MAX_LIMIT = 100;

const TUI_ACP_GOAL_METHODS = [
  'mcode/session/goal/get',
  'mcode/session/goal/create',
  'mcode/session/goal/patch',
  'mcode/session/goal/clear',
] as const;

export const TUI_ACP_EXTENSION_METHODS = [
  'session/activate',
  'mcode/session/activate',
  'mcode/session/steer',
  'mcode/session/queue/list',
  'mcode/session/queue/enqueue',
  'mcode/session/queue/update',
  'mcode/session/queue/delete',
  'mcode/session/queue/steer',
  ...TUI_ACP_GOAL_METHODS,
  'mcode/session/delegation/get',
  'mcode/session/delegation/stop',
  'mcode/session/delegation/message',
  'mcode/session/delegation/transcript',
] as const;

export const TUI_ACP_EXTENSION_NOTIFICATIONS = [
  'mcode/session/current_session_update',
  'mcode/session/queue_update',
  'mcode/session/goal_update',
  'mcode/session/delegation_update',
] as const;

export function tuiAcpExtensionCapabilities(runtime: Pick<TuiAcpRuntime, 'isGoalEnabled'>): {
  readonly methods: readonly string[];
  readonly notifications: readonly string[];
} {
  const goalEnabled = runtime.isGoalEnabled();
  return {
    methods: goalEnabled
      ? TUI_ACP_EXTENSION_METHODS
      : TUI_ACP_EXTENSION_METHODS.filter(
          (method) => !TUI_ACP_GOAL_METHODS.some((goalMethod) => goalMethod === method),
        ),
    notifications: goalEnabled
      ? TUI_ACP_EXTENSION_NOTIFICATIONS
      : TUI_ACP_EXTENSION_NOTIFICATIONS.filter(
          (notification) => notification !== 'mcode/session/goal_update',
        ),
  };
}

export interface RegisterTuiAcpExtensionsOptions {
  readonly app: acp.AgentApp;
  readonly runtime: TuiAcpRuntime;
  readonly resolveSession: (sessionId: string) => TuiSession | undefined;
  /**
   * Whether an attached ACP Session has no Runtime Session yet: session/new only reserves the
   * ID. Reads answer with the empty state such a Session has instead of creating it.
   */
  readonly isRuntimeSessionPending?: (sessionId: string) => boolean;
  /** Creates the Runtime Session of a pending ACP Session before a method changes its state. */
  readonly ensureRuntimeSession?: (sessionId: string) => Promise<void>;
  readonly activateSession: (sessionId: string) => void;
  readonly extensionNotificationsEnabled: () => boolean;
  readonly activePromptTurnId: (sessionId: string) => string | undefined;
  /** Distinguishes a questionnaire-waiting prompt from a cancelled prompt that is stopping. */
  readonly activePromptState?: (sessionId: string) => 'none' | 'waiting' | 'steerable' | 'stopping';
  /** Whether a Runtime Turn was started by the last ACP prompt of this Session (or its continuations). */
  readonly isLastPromptTurn?: (sessionId: string, turnId: string) => boolean;
  readonly createRequestId?: () => string;
}

export function registerTuiAcpExtensions(options: RegisterTuiAcpExtensionsOptions): void {
  const createRequestId = options.createRequestId ?? randomUUID;
  const resolve = (sessionId: string) => requireSession(options.resolveSession, sessionId);
  const isPending = (sessionId: string) => options.isRuntimeSessionPending?.(sessionId) === true;
  const resolveForWrite = async (sessionId: string) => {
    resolve(sessionId);
    await options.ensureRuntimeSession?.(sessionId);
    return resolve(sessionId);
  };
  const requireGoalEnabled = () => {
    if (!options.runtime.isGoalEnabled()) {
      throw acp.RequestError.invalidParams(
        undefined,
        'Goal extensions are disabled by the Runtime feature configuration.',
      );
    }
  };
  const activateSession = async (sessionId: string, client: acp.AgentContext) => {
    resolve(sessionId);
    options.activateSession(sessionId);
    if (options.extensionNotificationsEnabled()) {
      await client
        .notify('mcode/session/current_session_update', { sessionId })
        .catch(() => undefined);
    }
    return { sessionId };
  };

  options.app.onRequest('session/activate', parseSessionRequest, ({ params, client }) =>
    activateSession(params.sessionId, client),
  );
  options.app.onRequest('mcode/session/activate', parseSessionRequest, ({ params, client }) =>
    activateSession(params.sessionId, client),
  );

  options.app.onRequest('mcode/session/steer', parseTextRequest, async ({ params }) => {
    resolve(params.sessionId);
    const expectedTurnId = options.activePromptTurnId(params.sessionId);
    if (!expectedTurnId) throw await steerWithoutPromptTurnError(options, params.sessionId);
    const result = await options.runtime.steer({
      sessionId: params.sessionId,
      source: 'api',
      message: { content: params.text },
      producerId: 'mcode-acp',
      idempotencyKey: params.clientRequestId ?? createRequestId(),
      preDelivery: {
        accept: ({ mode, turnId }) => {
          if (
            mode !== 'steered' ||
            turnId !== expectedTurnId ||
            options.activePromptTurnId(params.sessionId) !== expectedTurnId
          ) {
            throw acp.RequestError.invalidParams(
              undefined,
              'The active ACP prompt Turn changed before steering was admitted.',
            );
          }
        },
      },
    });
    if (result.mode === 'activated') {
      void result.completion.catch(() => undefined);
      throw acp.RequestError.invalidParams(
        undefined,
        'Steering cannot activate a new Turn for an ACP prompt.',
      );
    }
    if (result.turnId !== expectedTurnId) {
      throw acp.RequestError.invalidParams(
        undefined,
        'The steer result did not match the active ACP prompt Turn.',
      );
    }
    return { turnId: result.turnId, mode: result.mode };
  });

  options.app.onRequest('mcode/session/queue/list', parseSessionRequest, async ({ params }) => {
    resolve(params.sessionId);
    if (isPending(params.sessionId)) return { items: [] };
    return { items: await options.runtime.listQueuedMessages(params.sessionId) };
  });

  options.app.onRequest('mcode/session/queue/enqueue', parseTextRequest, async ({ params }) => {
    await resolveForWrite(params.sessionId);
    return options.runtime.enqueueMessage(params.sessionId, params.text);
  });

  options.app.onRequest('mcode/session/queue/update', parseQueueTextRequest, async ({ params }) => {
    resolve(params.sessionId);
    if (isPending(params.sessionId)) return { item: null };
    return {
      item:
        (await options.runtime.updateQueuedMessageContent(
          params.sessionId,
          params.itemId,
          params.text,
        )) ?? null,
    };
  });

  options.app.onRequest('mcode/session/queue/delete', parseQueueItemRequest, async ({ params }) => {
    resolve(params.sessionId);
    if (isPending(params.sessionId)) return { item: null };
    return {
      item: (await options.runtime.deleteQueuedMessage(params.sessionId, params.itemId)) ?? null,
    };
  });

  options.app.onRequest('mcode/session/queue/steer', parseQueueItemRequest, async ({ params }) => {
    await resolveForWrite(params.sessionId);
    return options.runtime.steerQueuedMessage(params.sessionId, params.itemId);
  });

  options.app.onRequest('mcode/session/goal/get', parseSessionRequest, async ({ params }) => {
    requireGoalEnabled();
    resolve(params.sessionId);
    if (isPending(params.sessionId)) return { goal: null };
    return { goal: (await options.runtime.getGoal(params.sessionId)) ?? null };
  });

  options.app.onRequest('mcode/session/goal/create', parseGoalCreateRequest, async ({ params }) => {
    requireGoalEnabled();
    await resolveForWrite(params.sessionId);
    return {
      goal: await options.runtime.createGoal({
        sessionId: params.sessionId,
        objective: params.objective,
        ...(params.tokenBudget !== undefined ? { tokenBudget: params.tokenBudget } : {}),
      }),
    };
  });

  options.app.onRequest('mcode/session/goal/patch', parseGoalPatchRequest, async ({ params }) => {
    requireGoalEnabled();
    await resolveForWrite(params.sessionId);
    return {
      goal: await options.runtime.patchGoal(params.sessionId, {
        ...(params.status !== undefined ? { status: params.status } : {}),
        ...(params.objective !== undefined ? { objective: params.objective } : {}),
        ...(params.tokenBudget !== undefined ? { tokenBudget: params.tokenBudget } : {}),
      }),
    };
  });

  options.app.onRequest('mcode/session/goal/clear', parseSessionRequest, async ({ params }) => {
    requireGoalEnabled();
    resolve(params.sessionId);
    if (isPending(params.sessionId)) return { cleared: false };
    return { cleared: await options.runtime.clearGoal(params.sessionId) };
  });

  /** A delegated agent is addressed through an attached Session of the same delegation tree. */
  const requireDelegatedAgent = async (sessionId: string, targetSessionId: string) => {
    const session = resolve(sessionId);
    const rootSessionId = isPending(sessionId)
      ? session.sessionId
      : await resolveRootSessionId(options.runtime, session);
    const snapshot = isPending(sessionId)
      ? emptyDelegationSnapshot(rootSessionId)
      : await options.runtime.getDelegationSnapshot(rootSessionId);
    if (!snapshot.members.some((member) => member.sessionId === targetSessionId)) {
      throw acp.RequestError.invalidParams(
        undefined,
        `targetSessionId ${targetSessionId} is not a delegated agent of root Session ${rootSessionId}.`,
      );
    }
    return rootSessionId;
  };

  options.app.onRequest(
    'mcode/session/delegation/get',
    parseDelegationTreeRequest,
    async ({ params }) => {
      const session = resolve(params.sessionId);
      if (isPending(params.sessionId)) {
        return { snapshot: emptyDelegationSnapshot(session.sessionId) };
      }
      const rootSessionId = await resolveRootSessionId(options.runtime, session);
      return { snapshot: await options.runtime.getDelegationSnapshot(rootSessionId) };
    },
  );

  options.app.onRequest(
    'mcode/session/delegation/stop',
    parseDelegationStopRequest,
    async ({ params }) => {
      if (params.targetSessionId === undefined) {
        const session = await resolveForWrite(params.sessionId);
        const rootSessionId = await resolveRootSessionId(options.runtime, session);
        return { receipt: await options.runtime.stopDelegation(rootSessionId) };
      }
      const rootSessionId = await requireDelegatedAgent(params.sessionId, params.targetSessionId);
      return {
        receipt: await options.runtime.stopDelegation(rootSessionId, {
          targetSessionId: params.targetSessionId,
        }),
      };
    },
  );

  options.app.onRequest(
    'mcode/session/delegation/message',
    parseDelegationMessageRequest,
    async ({ params }) => {
      await requireDelegatedAgent(params.sessionId, params.targetSessionId);
      const noRunningTurn = () =>
        acp.RequestError.invalidParams(
          undefined,
          'The delegated agent has no running Turn to receive this message.',
        );
      // Like `mcode/session/steer`: join the running Turn only. Starting a Turn here would
      // bypass the delegation that owns the agent, so its parent would never get the answer.
      // Check first: steering an idle Session admits a Turn before pre-delivery runs, so a
      // rejection there would still leave a terminal on the agent's Session.
      const activeRun = await options.runtime.getActiveRun(params.targetSessionId);
      if (!activeRun.turnId || !activeRun.actions.steer) throw noRunningTurn();
      let result;
      try {
        result = await options.runtime.steer({
          sessionId: params.targetSessionId,
          source: 'api',
          message: { content: params.text },
          producerId: 'mcode-acp',
          idempotencyKey: params.clientRequestId ?? createRequestId(),
          preDelivery: {
            accept: ({ mode }) => {
              // The Turn ended after the check. Only an AbortError makes the Runtime withdraw
              // the admitted Turn as a cancellation instead of recording it as failed.
              if (mode !== 'steered') {
                throw new DOMException('The delegated agent Turn ended.', 'AbortError');
              }
            },
          },
        });
      } catch (error) {
        if (isAbortError(error)) throw noRunningTurn();
        throw error;
      }
      if (result.mode === 'activated') {
        void result.completion.catch(() => undefined);
        throw noRunningTurn();
      }
      return { targetSessionId: params.targetSessionId, turnId: result.turnId, mode: result.mode };
    },
  );

  options.app.onRequest(
    'mcode/session/delegation/transcript',
    parseDelegationTranscriptRequest,
    async ({ params }) => {
      await requireDelegatedAgent(params.sessionId, params.targetSessionId);
      const page = await options.runtime.listMessagePage(params.targetSessionId, {
        limit: params.limit ?? DELEGATION_TRANSCRIPT_DEFAULT_LIMIT,
        ...(params.before ? { before: params.before } : {}),
      });
      const projector = new TuiAcpUpdateProjector();
      const updates: acp.SessionUpdate[] = [];
      for (const message of page.messages) {
        updates.push(...(await projectTuiAcpHistoryMessage(message, projector)));
      }
      return {
        targetSessionId: params.targetSessionId,
        updates,
        hasMore: page.hasMore,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    },
  );
}

export function supportsTuiAcpExtensionNotifications(
  capabilities: acp.ClientCapabilities,
): boolean {
  const extension = capabilities._meta?.['minimax-code/extensions'];
  return (
    extension === true ||
    (isRecord(extension) &&
      extension.version === TUI_ACP_EXTENSION_VERSION &&
      extension.notifications === true)
  );
}

export async function resolveRootSessionId(
  runtime: Pick<TuiAcpRuntime, 'getSession'>,
  session: TuiSession,
): Promise<string> {
  let current = session;
  const visited = new Set<string>();
  while (current.parentSessionId) {
    if (visited.has(current.sessionId)) {
      throw acp.RequestError.internalError(undefined, 'Session parent chain contains a cycle.');
    }
    visited.add(current.sessionId);
    current = await runtime.getSession(current.parentSessionId);
  }
  return current.sessionId;
}

/** A Session that was never written has no delegated agents. */
function emptyDelegationSnapshot(rootSessionId: string): TuiDelegationSnapshot {
  return { schemaVersion: 1, rootSessionId, members: [] };
}

function requireSession(
  resolveSession: (sessionId: string) => TuiSession | undefined,
  sessionId: string,
): TuiSession {
  const session = resolveSession(sessionId);
  if (!session) throw acp.RequestError.resourceNotFound(sessionId);
  return session;
}

function parseSessionRequest(value: unknown): { sessionId: string } {
  const record = requireRecord(value);
  return { sessionId: requireText(record.sessionId, 'sessionId') };
}

/**
 * Delegation methods act on a tree or on one named member, so a field they do not read must
 * fail instead of being answered for a different target.
 */
function requireDelegationParams(
  value: unknown,
  supported: readonly string[],
): Record<string, unknown> {
  const record = requireRecord(value);
  for (const key of Object.keys(record)) {
    if (key !== '_meta' && !supported.includes(key)) {
      throw acp.RequestError.invalidParams(undefined, `${key} is not supported by this method.`);
    }
  }
  return record;
}

function parseDelegationTreeRequest(value: unknown): { sessionId: string } {
  const record = requireDelegationParams(value, ['sessionId']);
  return { sessionId: requireText(record.sessionId, 'sessionId') };
}

function parseDelegationStopRequest(value: unknown): {
  sessionId: string;
  targetSessionId?: string;
} {
  const record = requireDelegationParams(value, ['sessionId', 'targetSessionId']);
  return {
    sessionId: requireText(record.sessionId, 'sessionId'),
    ...(record.targetSessionId === undefined
      ? {}
      : { targetSessionId: requireText(record.targetSessionId, 'targetSessionId') }),
  };
}

function parseDelegationMessageRequest(value: unknown): {
  sessionId: string;
  targetSessionId: string;
  text: string;
  clientRequestId?: string;
} {
  const record = requireDelegationParams(value, [
    'sessionId',
    'targetSessionId',
    'text',
    'clientRequestId',
  ]);
  return {
    sessionId: requireText(record.sessionId, 'sessionId'),
    targetSessionId: requireText(record.targetSessionId, 'targetSessionId'),
    text: requireMessageText(record.text, 'text'),
    ...(record.clientRequestId === undefined
      ? {}
      : { clientRequestId: requireText(record.clientRequestId, 'clientRequestId') }),
  };
}

function parseDelegationTranscriptRequest(value: unknown): {
  sessionId: string;
  targetSessionId: string;
  limit?: number;
  before?: string;
} {
  const record = requireDelegationParams(value, [
    'sessionId',
    'targetSessionId',
    'limit',
    'before',
  ]);
  const limit = record.limit;
  if (
    limit !== undefined &&
    (typeof limit !== 'number' ||
      !Number.isInteger(limit) ||
      limit <= 0 ||
      limit > DELEGATION_TRANSCRIPT_MAX_LIMIT)
  ) {
    throw acp.RequestError.invalidParams(
      undefined,
      `limit must be an integer from 1 to ${DELEGATION_TRANSCRIPT_MAX_LIMIT}.`,
    );
  }
  return {
    sessionId: requireText(record.sessionId, 'sessionId'),
    targetSessionId: requireText(record.targetSessionId, 'targetSessionId'),
    ...(limit === undefined ? {} : { limit }),
    ...(record.before === undefined ? {} : { before: requireText(record.before, 'before') }),
  };
}

function parseTextRequest(value: unknown): {
  sessionId: string;
  text: string;
  clientRequestId?: string;
} {
  const record = requireRecord(value);
  const text = requireMessageText(record.text, 'text');
  return {
    sessionId: requireText(record.sessionId, 'sessionId'),
    text,
    ...(record.clientRequestId === undefined
      ? {}
      : { clientRequestId: requireText(record.clientRequestId, 'clientRequestId') }),
  };
}

function parseQueueItemRequest(value: unknown): { sessionId: string; itemId: string } {
  const record = requireRecord(value);
  return {
    sessionId: requireText(record.sessionId, 'sessionId'),
    itemId: requireText(record.itemId, 'itemId'),
  };
}

function parseQueueTextRequest(value: unknown): {
  sessionId: string;
  itemId: string;
  text: string;
} {
  return {
    ...parseQueueItemRequest(value),
    text: requireMessageText(requireRecord(value).text, 'text'),
  };
}

function parseGoalCreateRequest(value: unknown): {
  sessionId: string;
  objective: string;
  tokenBudget?: number | null;
} {
  const record = requireRecord(value);
  return {
    sessionId: requireText(record.sessionId, 'sessionId'),
    objective: requireText(record.objective, 'objective'),
    ...(record.tokenBudget === undefined
      ? {}
      : { tokenBudget: optionalBudget(record.tokenBudget, 'tokenBudget') }),
  };
}

const GOAL_STATUSES = ['active', 'paused', 'blocked', 'complete', 'budget_limited'] as const;
type GoalStatus = (typeof GOAL_STATUSES)[number];

function parseGoalPatchRequest(value: unknown): {
  sessionId: string;
  status?: GoalStatus;
  objective?: string;
  tokenBudget?: number | null;
} {
  const record = requireRecord(value);
  const status = record.status;
  if (status !== undefined && !GOAL_STATUSES.some((candidate) => candidate === status)) {
    throw acp.RequestError.invalidParams(undefined, 'status is not a supported Goal status.');
  }
  const patch = {
    ...(status === undefined ? {} : { status: status as GoalStatus }),
    ...(record.objective === undefined
      ? {}
      : { objective: requireText(record.objective, 'objective') }),
    ...(record.tokenBudget === undefined
      ? {}
      : { tokenBudget: optionalBudget(record.tokenBudget, 'tokenBudget') }),
  };
  if (Object.keys(patch).length === 0) {
    throw acp.RequestError.invalidParams(undefined, 'Goal patch must change at least one field.');
  }
  return { sessionId: requireText(record.sessionId, 'sessionId'), ...patch };
}

function optionalBudget(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw acp.RequestError.invalidParams(undefined, `${label} must be null or a positive number.`);
  }
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw acp.RequestError.invalidParams(undefined, `${label} must be a non-empty string.`);
  }
  return value.trim();
}

function requireMessageText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw acp.RequestError.invalidParams(undefined, `${label} must be a non-empty string.`);
  }
  return value;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw acp.RequestError.invalidParams(undefined, 'Extension params must be an object.');
  }
  return value;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
  );
}

/**
 * Why an ACP request met a Session whose Runtime Turn it must not join or queue behind:
 * - `prompt-turn-stopping`: session/cancel stopped the prompt Turn and it has not returned yet;
 * - `prompt-turn-settling`: the cancelled prompt returned, but the Runtime still settles its Turn;
 * - `turn-wait-timeout`: a new prompt waited for an active Runtime Turn up to its bound;
 * - `turn-running-elsewhere`: another live MCode process runs the Session Turn;
 * - `runtime-busy`: the Runtime rejected the direct send because a Turn holds the Session lock;
 * - `turn-awaiting-decision`: the Session Turn waits for an answer to a questionnaire or a
 *   permission request (not retryable, see `createTuiAcpSessionAwaitingDecisionError`).
 */
export type TuiAcpSessionBusyReason =
  | 'prompt-turn-stopping'
  | 'prompt-turn-settling'
  | 'turn-wait-timeout'
  | 'turn-running-elsewhere'
  | 'runtime-busy'
  | 'turn-awaiting-decision';

/**
 * The retryable "Session busy" error ACP Clients already handle: the same -32603 message the
 * Runtime `local_session_busy` rejection produces, plus structured data. Nothing was delivered or
 * queued, so the Client may send the same content again.
 */
export function createTuiAcpSessionBusyError(
  reason: TuiAcpSessionBusyReason,
  detail: string,
): acp.RequestError {
  return acp.RequestError.internalError(
    { code: 'local_session_busy', retryable: true, reason },
    `MiniMax Code Runtime failed: Session already has an active Turn. ${detail}`,
  );
}

/**
 * The Session Turn waits for a person to answer a questionnaire or a permission request. ACP
 * forwards those only inside an active prompt (elicitation / request_permission), so a Client
 * between prompts cannot see or answer this one, and waiting or retrying cannot clear it: it is
 * not retryable. The message names the blocker instead of the generic busy text, so Clients that
 * resend on "Session already has an active Turn" do not resend into the same block.
 */
export function createTuiAcpSessionAwaitingDecisionError(): acp.RequestError {
  return acp.RequestError.internalError(
    { code: 'local_session_busy', retryable: false, reason: 'turn-awaiting-decision' },
    'MiniMax Code Runtime failed: This session is waiting for an answer to a pending question or permission request that this client cannot display. Nothing was sent; send the message again after that request is answered or dismissed.',
  );
}

/**
 * Steering without a steerable ACP prompt Turn never falls back to the Runtime queue.
 *
 * Runtime settlement pauses the queue whenever a foreground Turn ends aborted by `user_stop` (or
 * fails) while any item is pending (execution.coordinator.ts `terminalQueuePauseCause`,
 * turn-priority-fence.ts `settledInTransaction`). ACP cannot prove a running Turn will settle
 * otherwise, and its own session/cancel is exactly a `user_stop`: one queued item would pause the
 * queue, every later direct send would be rejected as queue-paused, and ACP has no Continue to
 * resume it. A Turn this Session's prompts did not start must not get queued input either: it would
 * run outside any prompt as a hidden Turn. So only the reason differs:
 * - the cancelled prompt Turn still stopping or settling: retryable busy error, nothing queued;
 * - anything else (no prompt, a questionnaire/permission wait, a Turn of another entry): the
 *   original invalid-params rejection.
 */
async function steerWithoutPromptTurnError(
  options: RegisterTuiAcpExtensionsOptions,
  sessionId: string,
): Promise<acp.RequestError> {
  const state = options.activePromptState?.(sessionId) ?? 'none';
  if (state === 'stopping') {
    return createTuiAcpSessionBusyError(
      'prompt-turn-stopping',
      'The cancelled ACP prompt Turn is still stopping; nothing was queued. Send the message as a new session/prompt once the cancelled prompt returns.',
    );
  }
  if (state === 'none' && (await lastPromptTurnStillSettling(options, sessionId))) {
    return createTuiAcpSessionBusyError(
      'prompt-turn-settling',
      'The Runtime is still settling the last ACP prompt Turn; nothing was queued. Send the message as a new session/prompt; it waits for the settlement.',
    );
  }
  return acp.RequestError.invalidParams(
    undefined,
    'Steering requires an admitted, active ACP prompt Turn for this Session.',
  );
}

/** The Runtime still runs a Turn that the last ACP prompt of this Session started. */
async function lastPromptTurnStillSettling(
  options: RegisterTuiAcpExtensionsOptions,
  sessionId: string,
): Promise<boolean> {
  if (!options.isLastPromptTurn) return false;
  try {
    const activeRun = await options.runtime.getActiveRun(sessionId);
    // A decision-blocked Turn waits for a person, not for settlement; it keeps the plain rejection.
    return (
      activeRun.turnId !== undefined &&
      activeRun.state === 'running' &&
      options.isLastPromptTurn(sessionId, activeRun.turnId)
    );
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
