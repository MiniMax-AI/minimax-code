import {
  getRuntimeBuildEnv,
  getRuntimeRegion,
  isManagedRuntime,
  isTelemetryChannelEnabled,
} from '@mavis/config';
import { createPiTurnHistogramBucketsByName } from '@mavis/agent-core/pi-turn-runner';

import { logger } from '../common/logger.js';
import { POST_BASH_GAP_HISTOGRAM_BUCKETS } from './bash-completion-correlation.js';
import {
  createLocalRuntimeDesktopReporter,
  createLocalRuntimeMetricsClient,
  type MetricsBatchReporter,
  type MetricsClient,
} from '../common/metrics.js';
import type { LocalRuntimeMode } from './mode.js';

export interface LocalRuntimeHostMetricsOptions {
  /** Explicit `telemetry.metrics` opt-in; environment opt-outs always take precedence. */
  readonly readTelemetryEnabled?: () => boolean | undefined;
  readonly runtimeOwnerKind: string;
  readonly runtimeMode?: LocalRuntimeMode;
  readonly appVersion?: string;
  readonly metricsReporter?: MetricsBatchReporter;
}

/**
 * Long-tail latency series whose distributions exceed the shared default
 * histogram buckets. Keyed by BARE metric name (the server prepends the
 * `local_runtime_` service prefix on ingest). Buckets top out at 5 minutes
 * so multi-minute turns / compactions stay resolvable instead of collapsing
 * into a single +Inf bucket.
 */
const LONG_TAIL_HISTOGRAM_BUCKETS = [
  100, 250, 500, 1000, 2500, 5000, 10000, 15000, 30000, 60000, 120000, 300000,
];

const BASH_DURATION_HISTOGRAM_BUCKETS = [
  100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000,
  1_800_000, 3_600_000,
];

const BASH_OUTPUT_BYTES_HISTOGRAM_BUCKETS = [
  1024, 4000, 16_000, 64_000, 256_000, 1_000_000, 4_000_000, 16_000_000,
];

/** List endpoints are interactive-fast; resolve single-digit ms up to a 60s tail. */
const LIST_LATENCY_HISTOGRAM_BUCKETS = [
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000,
];

// Session ledger/snapshot IO is usually sub-100ms, so these start at 5ms to
// keep the fast path resolvable while still covering pathological minute-long
// tails (cold disk, antivirus, huge ledgers).
const SESSION_IO_HISTOGRAM_BUCKETS = [
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000,
];

// Count buckets (not milliseconds): replayed ledger events per resume load.
const SESSION_REPLAYED_EVENTS_BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

// Count buckets (not milliseconds): Pi inner-loop steps completed by one turn.
const PI_LOOP_STEPS_BUCKETS = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 100];

// Token counts for Review admission can legitimately extend into the model's
// full context window. Keep the common 8k-256k range distinguishable while
// retaining headroom for larger-context providers.
const REVIEW_TOKEN_HISTOGRAM_BUCKETS = [
  1_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 512_000, 1_000_000,
];

const HISTOGRAM_BUCKETS_BY_NAME: Record<string, number[]> = {
  pi_turn_duration_ms: LONG_TAIL_HISTOGRAM_BUCKETS,
  pi_loop_steps: PI_LOOP_STEPS_BUCKETS,
  output_safety_regenerations_per_user_turn: [0, 1, 2, 3],
  pi_llm_first_token_ms: LONG_TAIL_HISTOGRAM_BUCKETS,
  pi_llm_response_ms: LONG_TAIL_HISTOGRAM_BUCKETS,
  ...createPiTurnHistogramBucketsByName(),
  pi_llm_post_bash_gap_ms: POST_BASH_GAP_HISTOGRAM_BUCKETS,
  bash_duration_ms: BASH_DURATION_HISTOGRAM_BUCKETS,
  bash_foreground_soft_yield_ms: LONG_TAIL_HISTOGRAM_BUCKETS,
  bash_output_bytes: BASH_OUTPUT_BYTES_HISTOGRAM_BUCKETS,
  compact_duration_ms: LONG_TAIL_HISTOGRAM_BUCKETS,
  compact_checkpoint_candidate_duration_ms: LONG_TAIL_HISTOGRAM_BUCKETS,
  compact_saved_ratio: [-1, -0.5, -0.25, 0, 0.1, 0.3, 0.5, 0.7, 0.9, 1],
  permission_ask_wait_ms: LONG_TAIL_HISTOGRAM_BUCKETS,
  session_list_duration_ms: LIST_LATENCY_HISTOGRAM_BUCKETS,
  message_list_duration_ms: LIST_LATENCY_HISTOGRAM_BUCKETS,
  legacy_migration_duration_ms: LONG_TAIL_HISTOGRAM_BUCKETS,
  session_ledger_append_duration_ms: SESSION_IO_HISTOGRAM_BUCKETS,
  session_resume_load_duration_ms: SESSION_IO_HISTOGRAM_BUCKETS,
  session_resume_replayed_events: SESSION_REPLAYED_EVENTS_BUCKETS,
  review_context_input_tokens: REVIEW_TOKEN_HISTOGRAM_BUCKETS,
  review_context_input_budget_tokens: REVIEW_TOKEN_HISTOGRAM_BUCKETS,
  review_context_overflow_excess_tokens: REVIEW_TOKEN_HISTOGRAM_BUCKETS,
  review_context_tokens_removed: REVIEW_TOKEN_HISTOGRAM_BUCKETS,
};

/**
 * Build the local-runtime MetricsClient. Under managed runtime (Electron or
 * production / staging build) the client ships batches through the shared
 * desktop reporter (Matrix metrics ingress). Under pnpm dev / CLI in
 * non-managed mode the client falls back to the noop reporter and the
 * factory logs why — no `console.log`, no swallowed errors.
 */
export function buildLocalRuntimeMetricsClient(
  options: LocalRuntimeHostMetricsOptions,
): MetricsClient {
  const managed = isManagedRuntime();
  // The built-in cloud transport additionally requires an explicit `telemetry.metrics` opt-in.
  const cloudEnabled = managed && isTelemetryChannelEnabled('metrics', options.readTelemetryEnabled);
  const reporter = options.metricsReporter ?? buildManagedReporter(cloudEnabled);

  const onError = (err: unknown): void => {
    logger.warn(
      { reason: 'metrics_report_failed', err: serializeMetricsError(err) },
      'Local runtime metrics reporter failed',
    );
  };

  if (!cloudEnabled && !options.metricsReporter) {
    logger.info(
      { reason: managed ? 'telemetry_metrics_opt_in_required' : 'unmanaged_runtime' },
      'Local runtime metrics reporter disabled',
    );
  }

  return createLocalRuntimeMetricsClient({
    runtimeOwnerKind: options.runtimeOwnerKind,
    ...(options.runtimeMode ? { runtimeMode: options.runtimeMode } : {}),
    ...(options.appVersion ? { appVersion: options.appVersion } : {}),
    histogramBucketsByName: HISTOGRAM_BUCKETS_BY_NAME,
    ...(reporter ? { reporter } : {}),
    onError,
  });
}

function buildManagedReporter(managed: boolean): MetricsBatchReporter | undefined {
  if (!managed) return undefined;
  const buildEnv = getRuntimeBuildEnv();
  return createLocalRuntimeDesktopReporter({
    isEn: getRuntimeRegion() === 'en',
    isProd: buildEnv === 'prod',
    isStaging: buildEnv === 'staging',
    isDev: buildEnv === 'dev',
  });
}

function serializeMetricsError(err: unknown): unknown {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return err;
}
