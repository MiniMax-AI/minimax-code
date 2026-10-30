import type { PiTurnRunnerLogger } from '@mavis/agent-core/pi-turn-runner';

import type { AgentHostCompactionDependencies } from '../contracts.js';
import type { AgentEventContext } from '../events/contracts.js';
import type {
  CheckpointRequestShape,
  CheckpointSharedPrefixFallbackReason,
  ContextCompactionPhase,
} from './contracts.js';

/**
 * Managed MiniMax routes always keep the isolated checkpoint request. Other
 * routes share the main request's prefix while the remote switch allows it; an
 * unreadable switch keeps the isolated request.
 */
export function resolveCheckpointRequestShape(
  llm: { readonly managedProvider?: boolean },
  sharedPrefixEnabled: (() => boolean) | undefined,
): CheckpointRequestShape {
  if (llm.managedProvider === true || !sharedPrefixEnabled) return 'isolated';
  try {
    return sharedPrefixEnabled() === true ? 'shared_prefix' : 'isolated';
  } catch {
    return 'isolated';
  }
}

const SHARED_PREFIX_FALLBACK_REASONS = new Set<CheckpointSharedPrefixFallbackReason>([
  'tool_call',
  'input_overflow',
]);
/** Bounded metric label; other Provider APIs are reported as `other`. */
const SHARED_PREFIX_METRIC_APIS = new Set([
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
  'openai-codex-responses',
]);

export function recordSharedPrefixFallbackBestEffort(
  logger: Pick<PiTurnRunnerLogger, 'info'> | undefined,
  metrics: AgentHostCompactionDependencies['metricsClient'],
  input: {
    readonly context: AgentEventContext;
    readonly attemptId: string;
    readonly phase: ContextCompactionPhase;
    readonly api: string;
    readonly reason: CheckpointSharedPrefixFallbackReason;
  },
): void {
  if (!SHARED_PREFIX_FALLBACK_REASONS.has(input.reason)) return;
  const api = SHARED_PREFIX_METRIC_APIS.has(input.api) ? input.api : 'other';
  try {
    logger?.info?.(
      {
        event: 'context_compaction_checkpoint_shared_prefix_fallback',
        session_id: input.context.sessionId,
        turn_id: input.context.turnId,
        turn_sequence: input.context.turnSequence,
        attempt_id: input.attemptId,
        phase: input.phase,
        api,
        fallback_reason: input.reason,
      },
      '[local-runtime-v2] context compaction checkpoint fell back to the isolated request',
    );
  } catch {
    // Engineering diagnostics must never change the compaction outcome.
  }
  try {
    metrics?.counter('compact_checkpoint_shared_prefix_fallback_total', 1, {
      api,
      reason: input.reason,
    });
  } catch {
    // Metrics must never change the compaction outcome.
  }
}
