import type {
  ModelContextAssemblyCtx,
  PromptReadScope,
  TurnAssemblyCtx,
} from '@mavis/agent-runtime';

import type { SessionRecord } from '../../session-system/index.js';
import type { AgentHostRunInput } from './contracts.js';
import type {
  AgentExecutionSnapshot,
  AgentHostCanonicalUserInput,
  LocalTurnPreparation,
} from './preparation/contracts.js';

const AGENT_CONFIG_ALLOWLIST = [
  'system_prompt',
  'tools',
  'skills',
  'hooks',
  'permission_policy',
  'team',
  'title',
  'description',
  'memories',
  'persona',
  'display_name',
  'timezone',
  'locale',
  'agent_id',
  'system_reminders',
  'subagent_types',
  'creation_source',
  'background_task_enabled',
  'resourceAgentName',
  'builtinCapabilities',
  'cuModeActive',
  'desktopPluginSkills',
  'ptc_enabled',
  'capability_ceiling',
  'agent_profile',
] as const;

const MODEL_ALLOWLIST = [
  'provider',
  'provider_id',
  'providerId',
  'model_id',
  'modelId',
  'variant',
  'thinking_level',
  'thinkingLevel',
  'base_url',
  'baseUrl',
  'capabilities',
  'context_window',
  'contextWindow',
  'max_tokens',
  'maxTokens',
] as const;

export class AgentHostAssemblyContextValidationError extends Error {
  override readonly name = 'AgentHostAssemblyContextValidationError';

  constructor(readonly field: 'base_url' | 'baseUrl') {
    super(`AgentHost assembly context ${field} is not a secret-free URL.`);
  }
}

export function createSecretFreeTurnAssemblyContext<TAgent extends AgentExecutionSnapshot>(scope: {
  readonly input: AgentHostRunInput;
  readonly session: SessionRecord;
  readonly agent: TAgent;
  readonly preparation: LocalTurnPreparation;
  readonly history: TurnAssemblyCtx['history'];
  readonly canonicalUserInput: AgentHostCanonicalUserInput;
  readonly plan?: TurnAssemblyCtx['plan'];
  readonly promptRead?: PromptReadScope;
}): TurnAssemblyCtx {
  const { input, canonicalUserInput } = scope;
  const context = createSecretFreeModelContextAssemblyContext({
    sessionId: input.lease.sessionId,
    turnId: input.lease.turnId,
    session: scope.session,
    agent: scope.agent,
    preparation: scope.preparation,
    history: scope.history,
  });
  const turnIntent = projectTurnIntent(input.request.provenance);
  const outputSchema =
    input.request.outputContract?.type === 'json_schema'
      ? input.request.outputContract.schema
      : undefined;
  return {
    ...context,
    userInput: { text: canonicalUserInput.text },
    ...(outputSchema !== undefined || scope.preparation.outputRevisionInstruction !== undefined
      ? {
          outputContract: {
            ...(outputSchema === undefined ? {} : { schema: outputSchema }),
            ...(scope.preparation.outputRevisionInstruction === undefined
              ? {}
              : { revisionInstruction: scope.preparation.outputRevisionInstruction }),
          },
        }
      : {}),
    ...(turnIntent ? { turnIntent } : {}),
    ...(scope.plan ? { plan: scope.plan } : {}),
    ...(scope.promptRead ? { promptRead: scope.promptRead } : {}),
  };
}

export function createSecretFreeModelContextAssemblyContext<
  TAgent extends AgentExecutionSnapshot,
>(scope: {
  readonly sessionId: string;
  readonly turnId: string;
  readonly session: SessionRecord;
  readonly agent: TAgent;
  readonly preparation: LocalTurnPreparation;
  readonly history: ModelContextAssemblyCtx['history'];
}): ModelContextAssemblyCtx {
  const { sessionId, turnId, session, agent, preparation, history } = scope;
  const model = projectResolvedModel(preparation);
  return {
    sessionId,
    turnId,
    agentName: agent.agentName,
    workspaceDir: session.workspaceDir,
    agentConfig: {
      ...projectAllowedFields(preparation.agentConfig, AGENT_CONFIG_ALLOWLIST),
      model,
    },
    model,
    history,
  };
}

/**
 * True when this request's turn intent is `desktop-ptc`, the same projection
 * the tool catalog reads from the assembly context. Preparation renders the
 * system prompt before assembly, so it asks here instead of re-deriving the
 * rule; a separate check could drift and let the prompt and the catalog
 * disagree about PTC.
 */
export function isDesktopPtcTurnRequest(
  provenance: AgentHostRunInput['request']['provenance'] | undefined,
): boolean {
  // A request without provenance (direct test seams, malformed callers) keeps
  // the native prompt instead of failing preparation: PTC needs trusted provenance.
  if (!provenance) return false;
  return projectTurnIntent(provenance)?.kind === 'desktop-ptc';
}

function projectTurnIntent(
  provenance: AgentHostRunInput['request']['provenance'],
): TurnAssemblyCtx['turnIntent'] | undefined {
  const origin = readRecord(provenance.sourceContext?.origin);
  if (isGoalBudgetSummaryOrigin(origin)) {
    return { kind: 'goal-budget-summary' };
  }
  const cloudHandoff = readRecord(provenance.sourceContext?.cloudHandoff);
  if (cloudHandoff.trigger === 'slash') {
    return { kind: 'cloud-handoff', attributes: { trigger: 'slash' } };
  }

  // The Goal verifier child is an ordinary `task` delegation; the run id in its
  // origin is what lets the host attach the verification contract and this
  // run's execution caps to that one Turn.
  if (provenance.source === 'task') return projectGoalVerifierIntent(origin);
  if (provenance.source === 'code_review') {
    return projectCodeReviewIntent(readRecord(provenance.sourceContext?.review));
  }
  if (provenance.source === 'api' && provenance.sourceContext?.ptcEligible === true) {
    return { kind: 'desktop-ptc' };
  }
  return undefined;
}

function projectGoalVerifierIntent(
  origin: Readonly<Record<string, unknown>>,
): TurnAssemblyCtx['turnIntent'] | undefined {
  const verifier = readRecord(origin.goalVerifier);
  if (
    typeof verifier.runId !== 'string' ||
    verifier.runId.trim().length === 0 ||
    typeof verifier.profile !== 'string' ||
    verifier.profile.trim().length === 0
  ) {
    return undefined;
  }
  return {
    kind: 'goal-verifier',
    attributes: { runId: verifier.runId, profile: verifier.profile },
  };
}

function projectCodeReviewIntent(
  review: Readonly<Record<string, unknown>>,
): TurnAssemblyCtx['turnIntent'] | undefined {
  if (
    review.scope !== 'local_changes' ||
    !['slash', 'natural_language', 'subagent'].includes(String(review.trigger))
  ) {
    return undefined;
  }
  return {
    kind: 'code-review',
    attributes: {
      trigger: String(review.trigger),
      scope: 'local_changes',
    },
  };
}

function isGoalBudgetSummaryOrigin(origin: Readonly<Record<string, unknown>>): boolean {
  return origin.type === 'thread-goal-continuation' && origin.kind === 'budget-limit';
}

function projectResolvedModel(
  preparation: LocalTurnPreparation,
): Readonly<Record<string, unknown>> {
  const configured = readRecord(preparation.agentConfig.model);
  const resolved = preparation.llm.model;
  const projected = projectAllowedFields(configured, MODEL_ALLOWLIST);
  return {
    ...projected,
    provider: resolved.provider,
    model_id: resolved.id,
    context_window: resolved.contextWindow,
    max_tokens: resolved.maxTokens,
  };
}

function projectAllowedFields<const TKey extends string>(
  input: Readonly<Record<string, unknown>>,
  allowlist: readonly TKey[],
): Readonly<Record<string, unknown>> {
  const entries = allowlist.flatMap((key) => {
    const value = input[key];
    return value === undefined || isSensitiveConfigKey(key)
      ? []
      : ([[key, projectConfigValue(key, value)]] as const);
  });
  return Object.fromEntries(entries);
}

function projectConfigValue(key: string, value: unknown): unknown {
  return isBaseUrlKey(key) ? validateSecretFreeBaseUrl(key, value) : projectNestedConfig(value);
}

function projectNestedConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(projectNestedConfig);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, nested]) =>
      isSensitiveConfigKey(key) ? [] : [[key, projectConfigValue(key, nested)]],
    ),
  );
}

function validateSecretFreeBaseUrl(field: 'base_url' | 'baseUrl', value: unknown): string {
  try {
    if (typeof value !== 'string') throw new TypeError('Base URL must be a string.');
    const parsed = new URL(value);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new TypeError('Base URL contains non-public URL components.');
    }
    return value;
  } catch {
    throw new AgentHostAssemblyContextValidationError(field);
  }
}

function isBaseUrlKey(key: string): key is 'base_url' | 'baseUrl' {
  return key === 'base_url' || key === 'baseUrl';
}

function isSensitiveConfigKey(key: string): boolean {
  const normalized = key.replaceAll(/[_-]/gu, '').toLowerCase();
  if (normalized === 'maxtokens') return false;
  return (
    normalized === 'token' ||
    normalized.endsWith('token') ||
    normalized.endsWith('tokens') ||
    ['apikey', 'authorization', 'secret', 'password', 'credential', 'privatekey'].some((fragment) =>
      normalized.includes(fragment),
    )
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
  return isRecord(value) ? value : {};
}
