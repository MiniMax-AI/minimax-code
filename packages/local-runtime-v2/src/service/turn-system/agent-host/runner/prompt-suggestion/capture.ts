import type { LLMModelConfig, PiTurnHooks, RunTurnCaller } from '@mavis/agent-core/pi-turn-runner';
import type { AgentHostTurnOutcome } from '../../contracts.js';
import type { LocalTurnExecutionInput } from '../contracts.js';
import { buildPromptSuggestionPayloadTransform } from '../../assembly/local-turn-payload-transform.js';
import {
  createPromptSuggestionCapture,
  type PromptSuggestionCapture,
  type PromptSuggestionTurnPort,
} from './prompt-suggestion-service.js';

/**
 * Installs the capture Hooks only when the port is present and enabled, so a
 * disabled feature adds no Hook and keeps the main request untouched.
 */
export function createTurnPromptSuggestionCapture(
  input: LocalTurnExecutionInput,
  prepared: { readonly llm: LLMModelConfig; readonly caller: RunTurnCaller },
  options: Parameters<typeof buildPromptSuggestionPayloadTransform>[1] & {
    readonly promptSuggestion?: PromptSuggestionTurnPort;
  },
): { readonly capture: ReturnType<typeof createPromptSuggestionCapture> } | undefined {
  const port = options.promptSuggestion;
  if (
    !port ||
    !port.enabled() ||
    // Beta: offered only on the platform-billed (subscription) model path,
    // unless the port opts every model in (internal builds).
    (input.preparation.llm.managedProvider !== true && port.allowUnmanagedModels !== true) ||
    prepared.caller !== 'chat' ||
    input.session.parentSessionId ||
    (input.session.interactionMode ?? 'default') !== 'default' ||
    isAutomaticOrPlannedTurn(input)
  )
    return undefined;
  return {
    capture: createPromptSuggestionCapture(prepared.llm, (signal) =>
      buildPromptSuggestionPayloadTransform(
        {
          agentConfig: input.preparation.agentConfig,
          llm: { ...input.preparation.llm, ...prepared.llm },
          sessionId: input.lease.sessionId,
          signal,
        },
        options,
      ),
    ),
  };
}

/** Narrows one accepted Turn to the composer-facing cases only. */
export function readPromptSuggestionScope(
  input: LocalTurnExecutionInput,
  prepared: { readonly llm: LLMModelConfig; readonly caller: RunTurnCaller },
  capture: ReturnType<typeof createPromptSuggestionCapture> | undefined,
): PromptSuggestionScope | undefined {
  if (
    !capture ||
    prepared.caller !== 'chat' ||
    input.session.parentSessionId ||
    (input.session.interactionMode ?? 'default') !== 'default'
  )
    return undefined;
  return {
    sessionId: input.lease.sessionId,
    turnId: input.lease.turnId,
    caller: prepared.caller,
    session: {
      parentSessionId: input.session.parentSessionId ?? undefined,
      interactionMode: input.session.interactionMode,
    },
    capture: capture.read(),
  };
}

export interface PromptSuggestionScope {
  readonly sessionId: string;
  readonly turnId: string;
  readonly caller: string;
  readonly session: {
    readonly parentSessionId?: string;
    readonly interactionMode?: string;
  };
  readonly capture: PromptSuggestionCapture | undefined;
}

type PromptSuggestionHookCapture = ReturnType<typeof createPromptSuggestionCapture>;

/** Appends the capture Hooks without replacing any existing Hook. */
export function withPromptSuggestionHooks(
  hooks: PiTurnHooks,
  capture: PromptSuggestionHookCapture | undefined,
): PiTurnHooks {
  if (!capture) return hooks;
  return {
    ...hooks,
    onLlmCallPreparedHook: [...(hooks.onLlmCallPreparedHook ?? []), capture.preparedHook],
    afterLlmCallHook: [...(hooks.afterLlmCallHook ?? []), capture.assistantHook],
  };
}

function isAutomaticOrPlannedTurn(input: LocalTurnExecutionInput): boolean {
  return Boolean(
    input.assemblyContext.plan?.active ||
    input.assemblyContext.turnIntent?.kind.startsWith('goal-') ||
    input.request.provenance.source === 'thread-goal' ||
    !isUserDrivenTurn(input),
  );
}

/**
 * The user is at the composer for this Turn: they typed its query, or it
 * resumes on their questionnaire answer (which carries no user-authored query
 * text, yet the answer it produces is read right there).
 */
function isUserDrivenTurn(input: LocalTurnExecutionInput): boolean {
  return (
    input.request.genuineUserQueryText.trim().length > 0 ||
    input.request.provenance.source === 'questionnaire'
  );
}

/**
 * Holds a Turn's suggestion scope between its settlement and the Host's
 * terminal commit, keyed by the returned outcome object so it never reaches
 * the public contract and is collected with that outcome.
 */
export class PromptSuggestionCommitRelay {
  private readonly scopes = new WeakMap<AgentHostTurnOutcome, PromptSuggestionScope>();

  constructor(private readonly port: () => PromptSuggestionTurnPort | undefined) {}

  /** Only a completed, non-waiting Turn with a capture can offer a suggestion. */
  remember(outcome: AgentHostTurnOutcome, scope: PromptSuggestionScope | undefined): void {
    if (!scope?.capture || outcome.status !== 'completed' || outcome.waitingForUser) return;
    this.scopes.set(outcome, scope);
  }

  /** Best-effort and never awaited: a suggestion can never fail a committed Turn. */
  committed(outcome: AgentHostTurnOutcome): void {
    const scope = this.scopes.get(outcome);
    if (!scope) return;
    this.scopes.delete(outcome);
    const port = this.port();
    if (!port || !scope.capture) return;
    try {
      port.committed(
        {
          sessionId: scope.sessionId,
          turnId: scope.turnId,
          caller: scope.caller,
          session: scope.session,
        },
        scope.capture,
      );
    } catch {
      /* An optional suggestion can never fail a committed Turn. */
    }
  }
}
