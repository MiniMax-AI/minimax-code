import type {
  LLMRetryOptions,
  PiLLMRequestFailureHook,
  PiLLMRequestObserver,
  RunTurnInput,
  TurnEventReporter,
} from '@mavis/agent-core/pi-turn-runner';
import type { RuntimeTool } from '@mavis/agent-core/tools';
import type { IRuntimeEvent } from '@mavis/protocol';

import type { MetricsClient } from '../common/metrics.js';
import type { ContextUsageDebugMeasurement, PromptRange } from '../context/context-usage.js';
import type { RemoteTokenCounter } from '../context/remote-token-counter.js';
import type { LocalEvalReporterFactoryLike } from '../eval/types.js';
import type { DesktopErrorReporter } from '../error-reporting/index.js';
import type { LocalEventWriter } from '../events/sink.js';
import type { LocalRuntimeAuthContext } from './model-resolver.js';
import type { LocalRuntimeProjectionFrame } from './projection.js';
import type { LocalRuntimeRoutingContext } from './routing-headers.js';

export interface LocalToolContext {
  sessionId: string;
  turnId: string;
  readonly reporter?: TurnEventReporter;
}

export interface LocalTurnRunner {
  runTurn<TCtx extends LocalToolContext = LocalToolContext>(
    input: RunTurnInput<TCtx>,
  ): Promise<unknown>;
}

export interface LocalRuntimeHostOptions {
  /** Explicit protocol opt-in; omitted uses the existing V1 content endpoint. */
  safetyApiVersion?: 'v1' | 'v2';
  piRunner?: LocalTurnRunner;
  outputSafetyMaxRegenerations?: number;
  authContextGetter?: () => LocalRuntimeAuthContext | undefined;
  routingContextGetter?: () => LocalRuntimeRoutingContext | undefined;
  outputSafetyRetryDelay?: () => Promise<void>;
  metricsClient?: MetricsClient;
  fetchImpl?: typeof fetch;
  /** Desktop error reporter shared by the process composition layer. */
  errorReporter?: DesktopErrorReporter;
  /** Failure callback shared by v1 and v2 runners in the same process. */
  llmRequestFailureHook?: PiLLMRequestFailureHook;
  /** Host-owned observer for each physical LLM request lifecycle. */
  observeLLMRequest?: PiLLMRequestObserver;
  /** Optional fail-open eval_step reporter wired by packaged Electron builds. */
  evalReporterFactory?: LocalEvalReporterFactoryLike;
  contextUsageCalibrationCounter?: RemoteTokenCounter;
  contextUsageProviderDiagnosticCounter?: RemoteTokenCounter;
}

export type LocalRuntimeTurnInput<TCtx extends LocalToolContext = LocalToolContext> = Omit<
  RunTurnInput<TCtx>,
  'eventWriter' | 'toolConfig' | 'llmRetry'
> & {
  eventWriter?: LocalEventWriter;
  tools?: readonly RuntimeTool[];
  disableBuiltinToolFallback?: boolean;
  toolContext?: TCtx;
  rewindPiHistory?: () => Promise<void>;
  onOutputRecall?: () => void | Promise<void>;
  reviewUserInput?: string;
  onInputReviewResolved?: (rejected: boolean) => void;
  persistApprovedPartialOnNetworkStop?: boolean;
  onLlmRetry?: LLMRetryOptions['observer'];
  contextUsagePromptRanges?: readonly PromptRange[];
  /** BYOK snapshots fail closed unless the terminal Provider reports input usage and window. */
  contextUsageRequiresProviderAnchor?: boolean;
  onContextUsageDebug?: (measurement: ContextUsageDebugMeasurement) => void;
};

export type LocalRuntimeRetractionVariant = 'content' | 'network';

export interface LocalRuntimeTurnOutput {
  events: readonly IRuntimeEvent[];
  frames: readonly LocalRuntimeProjectionFrame[];
  eventWriter: LocalEventWriter;
  retracted: boolean;
  networkStopped: boolean;
  approvedPartial?: { thinking: string; content: string; msgId: string | undefined };
  retractionVariant?: LocalRuntimeRetractionVariant;
  timingEventsStartIndex?: number;
}
