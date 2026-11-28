import {
  createEvaluatorVerifierAdapter,
  EvaluatorModelCallError,
  VerificationDispatchError,
  type EvaluatorModelCallInput,
  type EvaluatorModelCallResult,
  type EvaluatorModelPort,
  type EvaluatorRouteIdentity,
  type VerificationAttempt,
  type VerificationUsage,
  type VerifierPort,
  type EvaluatorCallLifecycle,
} from '@mavis/goal';
import { randomUUID } from 'node:crypto';
import {
  isLLMContextOverflowMessage,
  LLM_RETRY_CALL_IDENTITY,
  type LLMCallLifecycle,
  type LLMCallLease,
  type LLMCallFailure,
} from '@mavis/agent-core/pi-turn-runner';
import { GOAL_CONFIG_DEFAULTS, resolveModelCallRoute } from '@mavis/config';
import { isContextOverflow, streamSimple, type AssistantMessage } from '@earendil-works/pi-ai';
import { ThinkingLevel } from '@mavis/protocol';

import {
  parseSourceQualifiedModelKey,
  resolveLegacyMinimaxModel,
  type LocalConversationRuntimeConfig,
  type LocalResolvedModelConfig,
} from '../../service/model-system/index.js';
import {
  isTaskSession,
  summarizeCommittedPiGoalUsage,
  type SessionRecord,
} from '../../service/session-system/index.js';
import {
  buildLocalTurnPayloadTransform,
  type AgentExecutionSnapshot,
  type ProductionAgentPreparation,
  type ProductionAgentProductCapabilities,
} from '../../service/turn-system/index.js';

export interface GoalEvaluatorVerifierOptions {
  readonly sessions: {
    getExecutionSnapshot(sessionId: string): Promise<SessionRecord | undefined>;
  };
  readonly agents: ProductionAgentProductCapabilities['agents'];
  readonly preparation: ProductionAgentPreparation;
  readonly config: () => LocalConversationRuntimeConfig;
  readonly tuiProductPolicy?: boolean;
  readonly nowMs?: () => number;
}

/**
 * Bridges the v1 Goal owner to one fresh v2 model request. Model resolution and
 * credentials remain owned by the same production preparation path as worker Turns.
 */
export function createGoalEvaluatorVerifier(options: GoalEvaluatorVerifierOptions): VerifierPort {
  return {
    async dispatch(attempt, signal) {
      const config = options.config();
      const policy = config.goal?.evaluator;
      if (policy && policy.modelPolicy !== 'same-route-small-fast') {
        throw routeUnavailable('The configured Goal evaluator model policy is unsupported.');
      }
      const deadlineAt =
        Date.now() +
        positiveInteger(policy?.timeoutSeconds, GOAL_CONFIG_DEFAULTS.evaluator.timeoutSeconds) *
          1_000;
      const model = await resolveEvaluatorModelPort(options, config, attempt);
      return model.dispatch(signal, deadlineAt, (ownedModel, ownedSignal, evaluatorLifecycle) =>
        createEvaluatorVerifierAdapter({
          model: ownedModel,
          ...(evaluatorLifecycle ? { lifecycle: evaluatorLifecycle } : {}),
          sessionId: attempt.sessionId,
          turnId: attempt.turnId,
          maxTokens: Math.min(
            positiveInteger(attempt.maxTokens, GOAL_CONFIG_DEFAULTS.evaluator.maxTokens),
            positiveInteger(policy?.maxTokens, GOAL_CONFIG_DEFAULTS.evaluator.maxTokens),
          ),
          timeoutSeconds: positiveInteger(
            policy?.timeoutSeconds,
            GOAL_CONFIG_DEFAULTS.evaluator.timeoutSeconds,
          ),
          maxRetries: nonNegativeInteger(
            policy?.maxRetries,
            GOAL_CONFIG_DEFAULTS.evaluator.maxRetries,
          ),
          ...(options.nowMs ? { nowMs: options.nowMs } : {}),
        }).dispatch(attempt, ownedSignal),
      );
    },
  };
}

async function resolveEvaluatorModelPort(
  options: GoalEvaluatorVerifierOptions,
  config: LocalConversationRuntimeConfig,
  attempt: VerificationAttempt,
): Promise<EvaluatorDispatchOwner> {
  const worker = parseSourceQualifiedModelKey(attempt.workerModelKey);
  try {
    const candidate = resolveEvaluatorModelSelection(config);
    if (!worker || !candidate) {
      throw routeUnavailable('The worker or small-fast evaluator model identity is unavailable.');
    }
    const workerRoute = routeIdentity(config, worker.providerId);
    const evaluatorRoute = routeIdentity(config, candidate.providerId);
    if (!sameDataRoute(workerRoute, evaluatorRoute)) {
      throw routeUnavailable('The configured small-fast model is not on the worker data route.');
    }
    const session = await options.sessions.getExecutionSnapshot(attempt.sessionId);
    if (!session) throw new Error(`Evaluator Session not found: ${attempt.sessionId}`);
    const agent = await getSessionAgentSnapshot(options.agents, session);
    if (!agent) throw new Error(`Evaluator Agent not found: ${session.agentName}`);
    const agentConfig = await options.preparation.buildAgentConfig({
      session,
      agent,
      model: {
        provider_id: candidate.providerId,
        model_id: candidate.modelId,
        thinking: {},
      },
      isSessionFirstTurn: false,
    });
    const llm = await options.preparation.resolveModel({
      sessionId: attempt.sessionId,
      turnId: `${attempt.turnId}:goal-evaluator`,
      agentConfig,
    });
    return evaluatorDispatchOwner(llm.callLifecycle, attempt, (lease, identity) => {
      const ownedLlm = lease
        ? { ...llm, streamFn: lease.wrapAttempt(llm.streamFn ?? streamSimple) }
        : llm;
      return {
        workerRoute,
        evaluatorRoute,
        call: (input) =>
          callEvaluatorModel({
            input,
            agentConfig: { ...agentConfig },
            nowMs: options.nowMs,
            llm: ownedLlm,
            callIdentity: identity,
          }),
      };
    });
  } catch (error) {
    if (error instanceof VerificationDispatchError) throw error;
    throw routeUnavailable(
      'The same-route small-fast evaluator model could not be resolved.',
      error,
    );
  }
}

// Runtime-only failure context: never serialize provider responses into Goal errors/history.
const evaluatorFailures = new WeakMap<Error, LLMCallFailure>();

interface EvaluatorDispatchOwner {
  dispatch<T>(
    signal: AbortSignal,
    deadlineAt: number,
    run: (
      model: EvaluatorModelPort,
      signal: AbortSignal,
      lifecycle?: EvaluatorCallLifecycle,
    ) => Promise<T>,
  ): Promise<T>;
}

function evaluatorDispatchOwner(
  lifecycle: LLMCallLifecycle | undefined,
  attempt: VerificationAttempt,
  model: (lease?: LLMCallLease, identity?: object) => EvaluatorModelPort,
): EvaluatorDispatchOwner {
  return {
    async dispatch(signal, deadlineAt, run) {
      if (!lifecycle) return run(model(), signal);
      signal.throwIfAborted();
      const identity = {};
      const timeout = AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()));
      const lease = await lifecycle.open({
        identity,
        callId: randomUUID(),
        sessionId: attempt.sessionId,
        turnId: attempt.turnId,
        scope: 'goal-evaluator',
        signal: AbortSignal.any([signal, timeout]),
        deadlineAt,
      });
      let closing: Promise<void> | undefined;
      const close = (): Promise<void> => {
        closing ??= (async () => {
          await lease.close();
        })();
        return closing;
      };
      const evaluatorLifecycle: EvaluatorCallLifecycle = {
        deadlineAt,
        lease: {
          signal: lease.signal,
          ...(lease.classifyFailure
            ? {
                classifyFailure: (error) =>
                  lease.classifyFailure!(
                    error instanceof Error
                      ? (evaluatorFailures.get(error) ?? { thrown: error })
                      : { thrown: error },
                  ),
              }
            : {}),
          ...(lease.recover ? { recover: (input) => lease.recover!(input) } : {}),
          close,
        },
      };
      try {
        lease.signal.throwIfAborted();
        return await run(model(lease, identity), lease.signal, evaluatorLifecycle);
      } finally {
        await close();
      }
    },
  };
}

function resolveEvaluatorModelSelection(config: LocalConversationRuntimeConfig) {
  const configured = parseSourceQualifiedModelKey(config.defaultLightModel ?? config.defaultModel);
  if (!configured) return configured;
  return resolveLegacyMinimaxModel(config, configured) ?? configured;
}

async function callEvaluatorModel(input: {
  readonly input: EvaluatorModelCallInput;
  readonly agentConfig: Readonly<Record<string, unknown>>;
  readonly llm: LocalResolvedModelConfig;
  readonly callIdentity?: object;
  readonly nowMs?: () => number;
}): Promise<EvaluatorModelCallResult> {
  const { llm } = input;
  if (input.input.images?.length && !llm.model.input.includes('image')) {
    throw new EvaluatorModelCallError(
      'api_error',
      'The configured Goal evaluator model does not support screenshot input.',
      0,
      false,
    );
  }
  const requestPayloadTransform = buildLocalTurnPayloadTransform(
    withThinkingOff(input.agentConfig),
    {
      thinkingLevel: 'off',
      ...(llm.thinkingRequestPatch ? { thinkingRequestPatch: llm.thinkingRequestPatch } : {}),
      // A managed route applies the model's declared thinking mode as worker requests do,
      // so a forced-on model is sent without the thinking switch it would reject.
      managedProvider: llm.managedProvider === true,
      signal: input.input.signal,
    },
  );
  let final: AssistantMessage | undefined;
  let response: LLMCallFailure['response'];
  try {
    final = await requestEvaluatorModel(input, requestPayloadTransform, (value) => {
      response = value;
    });
    return evaluateFinalMessage(final, llm.model.contextWindow, input.input.signal);
  } catch (error) {
    const classified = classifyEvaluatorCallError(input.input.signal, error);
    evaluatorFailures.set(classified, {
      ...(final ? { final } : { thrown: error }),
      ...(response ? { response } : {}),
    });
    throw classified;
  }
}

/** The evaluator asks for thinking off wherever the model allows turning it off. */
function withThinkingOff(
  agentConfig: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const model = agentConfig.model;
  if (typeof model !== 'object' || model === null) return agentConfig;
  return { ...agentConfig, model: { ...model, thinking_level: ThinkingLevel.OFF } };
}

async function requestEvaluatorModel(
  input: Parameters<typeof callEvaluatorModel>[0],
  requestPayloadTransform: ReturnType<typeof buildLocalTurnPayloadTransform>,
  onResponse: (response: NonNullable<LLMCallFailure['response']>) => void,
): Promise<AssistantMessage> {
  const response = await (input.llm.streamFn ?? streamSimple)(
    input.llm.model,
    {
      systemPrompt: input.input.systemPrompt,
      messages: [
        {
          role: 'user',
          content: input.input.images?.length
            ? [
                { type: 'text', text: input.input.userPrompt },
                ...input.input.images.map((image) => ({ type: 'image' as const, ...image })),
              ]
            : input.input.userPrompt,
          timestamp: (input.nowMs ?? Date.now)(),
        },
      ],
      tools: [...input.input.tools],
    },
    {
      ...(input.callIdentity ? { [LLM_RETRY_CALL_IDENTITY]: input.callIdentity } : {}),
      ...(input.llm.apiKey ? { apiKey: input.llm.apiKey } : {}),
      ...(input.llm.headers ? { headers: { ...input.llm.headers } } : {}),
      ...(input.llm.fetch ? { fetch: input.llm.fetch } : {}),
      maxTokens: input.input.maxTokens,
      timeoutMs: input.input.timeoutMs,
      maxRetries: 0,
      signal: input.input.signal,
      onPayload: requestPayloadTransform,
      onResponse,
    },
  );
  return response.result();
}

function classifyEvaluatorCallError(signal: AbortSignal, error: unknown): Error {
  // The adapter owns the distinction between its parent AbortSignal and its
  // private timeout signal. Preserve an untyped abort so it can classify it.
  if (signal.aborted) return abortReason(signal, error);
  if (error instanceof EvaluatorModelCallError) return error;
  if (isExplicitInputTooLargeError(error)) {
    return new EvaluatorModelCallError(
      'input_too_large',
      'Evaluator input exceeded the model context window.',
      null,
      true,
      { cause: error },
    );
  }
  return new EvaluatorModelCallError(
    'api_error',
    error instanceof Error ? error.message : 'Evaluator model request failed.',
    null,
    true,
    { cause: error },
  );
}

function evaluateFinalMessage(
  final: AssistantMessage,
  contextWindow: number,
  signal: AbortSignal,
): EvaluatorModelCallResult {
  const usage = summarizeCommittedPiGoalUsage([final]);
  const tokens = usage.incomplete ? null : usage.tokens;
  if (isFinalContextOverflow(final, contextWindow)) {
    throw new EvaluatorModelCallError(
      'input_too_large',
      final.errorMessage ?? 'Evaluator input exceeded the model context window.',
      tokens,
      usage.incomplete,
    );
  }
  if (signal.aborted) throw abortReason(signal, final.errorMessage);
  if (final.stopReason === 'aborted') {
    throw new EvaluatorModelCallError(
      'aborted',
      final.errorMessage ?? 'Evaluator model request was aborted.',
      tokens,
      usage.incomplete,
    );
  }
  if (final.stopReason === 'error' || final.stopReason === 'toolUse') {
    throw new EvaluatorModelCallError(
      'api_error',
      final.errorMessage ?? `Evaluator model stopped with ${final.stopReason}.`,
      tokens,
      usage.incomplete,
    );
  }
  return {
    text: final.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(''),
    tokens,
    incomplete: usage.incomplete,
  };
}

/**
 * A final response that says the request exceeded the model's context window.
 * The shared provider wording is read first, as main-turn recovery does: Pi's
 * patterns miss several providers (e.g. Zhipu `Prompt exceeds max length`).
 */
export function isFinalContextOverflow(final: AssistantMessage, contextWindow: number): boolean {
  if (final.stopReason === 'error' && isLLMContextOverflowMessage(final.errorMessage)) return true;
  const usage = Reflect.get(final, 'usage');
  if (usage && typeof usage === 'object') return isContextOverflow(final, contextWindow);
  return final.stopReason === 'error' && isExplicitInputTooLargeError(final.errorMessage);
}

function routeIdentity(
  config: LocalConversationRuntimeConfig,
  providerId: string,
): EvaluatorRouteIdentity {
  const kind = resolveModelCallRoute(config, providerId);
  return kind === 'custom_provider' || kind === 'configured_provider'
    ? { kind, providerId }
    : { kind };
}

function sameDataRoute(worker: EvaluatorRouteIdentity, evaluator: EvaluatorRouteIdentity): boolean {
  // Keep aligned with @mavis/goal's model-port route check; this v2 seam compares two identities
  // before a model port exists, so merging the helpers would weaken their distinct input contracts.
  if (worker.kind !== evaluator.kind) return false;
  return worker.kind !== 'custom_provider' && worker.kind !== 'configured_provider'
    ? true
    : Boolean(worker.providerId) && worker.providerId === evaluator.providerId;
}

function getSessionAgentSnapshot(
  agents: ProductionAgentProductCapabilities['agents'],
  session: SessionRecord,
): Promise<AgentExecutionSnapshot | undefined> {
  return agents.getExecutionSnapshot(session.agentName, {
    sessionId: session.sessionId,
    ...(session.appMode ? { appMode: session.appMode } : {}),
    sessionKind: isTaskSession(session) ? 'task' : session.sessionKind,
  });
}

function routeUnavailable(message: string, cause?: unknown): VerificationDispatchError {
  return new VerificationDispatchError('route_unavailable', message, emptyUsage(), {
    cause,
  });
}

function emptyUsage(): VerificationUsage {
  return { tokens: 0, activeSeconds: 0, incomplete: false };
}

function abortReason(signal: AbortSignal, fallback: unknown): Error {
  if (signal.reason instanceof Error) return signal.reason;
  if (fallback instanceof Error) return fallback;
  return new Error('Evaluator model request was aborted.');
}

/** A thrown provider error or error text that says the input was too large for the model. */
export function isExplicitInputTooLargeError(error: unknown): boolean {
  if (typeof error === 'string') {
    return /context window|context length|input too large|request too large|prompt is too long/iu.test(
      error,
    );
  }
  if (!error || typeof error !== 'object') return false;
  const code = Reflect.get(error, 'code');
  if (
    typeof code === 'string' &&
    /(?:context|input|request).*(?:large|length|window)/iu.test(code)
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : '';
  return /context window|context length|input too large|request too large|prompt is too long/iu.test(
    message,
  );
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}
