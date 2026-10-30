import type {
  AgentRuntime,
  AssemblyResult,
  InternalTurnPromptReadRegistry,
  ModelContextAssemblyCtx,
  PromptSnapshotSource as RuntimePromptSnapshotSource,
  TurnAssemblyCtx,
} from '@mavis/agent-runtime';
import type { PiTurnRunnerLogger } from '@mavis/agent-core/pi-turn-runner';

import type { SessionRecord, SessionSystemReadCapability } from '../../session-system/index.js';
import type {
  AgentCompactionInput,
  AgentHostCompactionControl,
  AutomaticContextCompactor,
  CompactionOutcome,
  ContextCompactionLifecycle,
  ContextCompactionObserver,
  ContextCompactor,
} from './compaction/contracts.js';
import type { AgentEventDelivery } from './events/contracts.js';
import type {
  AgentHostHistoryFailure,
  AgentHostUsageProjection,
  CanonicalHistoryStore,
} from './history/contracts.js';
import type {
  AgentExecutionSnapshot,
  AgentExecutionSource,
  AgentHostExecutionRequest,
  ContextCompactionPreparationSource,
  LocalTurnPreparation,
  LocalTurnPreparationSource,
  TurnRuntimeFactSource,
} from './preparation/contracts.js';
import type {
  AcceptedTurnLease,
  AgentHostTurnControl,
  AgentHostTurnOutcome,
  LocalTurnExecutor,
} from './runner/contracts.js';
import type {
  AgentHostTurnCapabilityLifecycle,
  AgentHostTurnCapabilityView,
} from './assembly/turn-capability-lifecycle.js';

export const BACKGROUND_CADENCE_REMINDER_CUSTOM_TYPE = 'background_task_cadence_reminder';
export const BACKGROUND_TASK_READ_SETTLEMENT_CUSTOM_TYPE = 'background_task_read_settlement';

export interface BackgroundTaskOriginMetadata {
  readonly kind: 'background-task-terminal';
  readonly taskIds: readonly string[];
  /** Absent only on legacy persisted automatic markers. */
  readonly observedTerminalCount?: number;
}

/** Reads current nested metadata and the pre-hostMetadata persisted shape. */
export function readBackgroundTaskOriginMetadata(
  message: unknown,
): BackgroundTaskOriginMetadata | undefined {
  if (!isProtocolRecord(message)) return undefined;
  const hostMetadata = readProtocolRecord(message['hostMetadata']);
  return (
    parseBackgroundTaskOriginMetadata(hostMetadata?.['backgroundTaskOrigin']) ??
    parseBackgroundTaskOriginMetadata(message['backgroundTaskOrigin'])
  );
}

export function hasValidBackgroundTaskHostMetadata(message: object): boolean {
  const current = Object.hasOwn(message, 'hostMetadata');
  const legacy = Object.hasOwn(message, 'backgroundTaskOrigin');
  if (!current && !legacy) return true;
  if (current && legacy) return false;
  if (current) {
    const metadata = readProtocolRecord(Reflect.get(message, 'hostMetadata'));
    return (
      metadata !== undefined &&
      hasExactProtocolKeys(metadata, ['backgroundTaskOrigin']) &&
      parseBackgroundTaskOriginMetadata(metadata['backgroundTaskOrigin']) !== undefined
    );
  }
  return (
    parseBackgroundTaskOriginMetadata(Reflect.get(message, 'backgroundTaskOrigin')) !== undefined
  );
}

export function isBackgroundTaskReadSettlement(message: unknown): boolean {
  if (!isProtocolRecord(message)) return false;
  return (
    hasExactProtocolKeys(message, [
      'role',
      'customType',
      'content',
      'display',
      'details',
      'hostMetadata',
      'timestamp',
    ]) &&
    isBackgroundTaskReadSettlementEnvelope(message) &&
    isBackgroundTaskReadSettlementDetails(message['details']) &&
    isProviderOmitHostMetadata(message['hostMetadata'])
  );
}

function isBackgroundTaskReadSettlementEnvelope(
  message: Readonly<Record<string, unknown>>,
): boolean {
  return (
    message['role'] === 'custom' &&
    message['customType'] === BACKGROUND_TASK_READ_SETTLEMENT_CUSTOM_TYPE &&
    message['content'] === '' &&
    message['display'] === false &&
    Number.isFinite(message['timestamp'])
  );
}

function isBackgroundTaskReadSettlementDetails(value: unknown): boolean {
  return (
    isProtocolRecord(value) && hasExactProtocolKeys(value, ['version']) && value['version'] === 1
  );
}

function isProviderOmitHostMetadata(value: unknown): boolean {
  return (
    isProtocolRecord(value) &&
    hasExactProtocolKeys(value, ['providerVisibility']) &&
    value['providerVisibility'] === 'omit'
  );
}

export function parseBackgroundTaskOriginMetadata(
  value: unknown,
): BackgroundTaskOriginMetadata | undefined {
  if (!isProtocolRecord(value)) return undefined;
  const hasCount = Object.hasOwn(value, 'observedTerminalCount');
  if (
    !hasExactProtocolKeys(
      value,
      hasCount ? ['kind', 'taskIds', 'observedTerminalCount'] : ['kind', 'taskIds'],
    ) ||
    value['kind'] !== 'background-task-terminal'
  ) {
    return undefined;
  }
  const taskIds = readNonEmptyTaskIds(value['taskIds']);
  const observedTerminalCount = readOptionalTerminalCount(value['observedTerminalCount'], hasCount);
  if (!taskIds || observedTerminalCount === null) return undefined;
  return {
    kind: 'background-task-terminal',
    taskIds,
    ...(observedTerminalCount === undefined ? {} : { observedTerminalCount }),
  };
}

function readNonEmptyTaskIds(value: unknown): readonly string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((taskId) => typeof taskId !== 'string' || !taskId.trim())
  ) {
    return undefined;
  }
  return [...value];
}

function readOptionalTerminalCount(value: unknown, present: boolean): number | undefined | null {
  if (!present) return undefined;
  return isNonNegativeSafeInteger(value) ? Number(value) : null;
}

function hasExactProtocolKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isNonNegativeSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isProtocolRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readProtocolRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isProtocolRecord(value) ? value : undefined;
}

export type PromptSnapshotSource = RuntimePromptSnapshotSource;

export interface AgentHostRunInput {
  /** Accepted TurnSystem ownership/lease fence, not a Session snapshot. */
  readonly lease: AcceptedTurnLease;
  /** Admitted execution request detached and validated by AgentHost at callback entry. */
  readonly request: AgentHostExecutionRequest;
}

export interface AgentHostCompactionDependencies<
  TAgent extends AgentExecutionSnapshot = AgentExecutionSnapshot,
> {
  readonly preparation: ContextCompactionPreparationSource<TAgent>;
  readonly automatic: AutomaticContextCompactor;
  readonly manual: ContextCompactor;
  readonly control: AgentHostCompactionControl;
  readonly lifecycle: ContextCompactionLifecycle;
  readonly observer?: ContextCompactionObserver;
  /**
   * Remote switch for the cache-sharing checkpoint request on non-managed
   * Providers, read once per Turn and per manual compaction. Absent: every
   * checkpoint request keeps the isolated shape.
   */
  readonly checkpointSharedPrefixEnabled?: () => boolean;
  readonly metricsClient?: {
    counter(name: string, value: number, labels?: Record<string, string>): void;
    histogram(name: string, value: number, labels?: Record<string, string>): void;
  };
  readonly usageAnchor?: {
    recordBound(scope: string, messages: readonly unknown[]): boolean;
    advanceHistory(scope: string): void;
  };
}

/** Constructor seam for the accepted-work Host; it contains no product workflow. */
export interface AgentHostDependencies<
  TAgent extends AgentExecutionSnapshot = AgentExecutionSnapshot,
> {
  readonly sessions: SessionSystemReadCapability;
  /** Required for Plan snapshots; omitted test bags may execute only Default sessions. */
  readonly planDocuments?: {
    resolveAndEnsure(sessionId: string): Promise<{ readonly canonicalPath: string }>;
  };
  readonly agentRuntimes: AgentHostRuntimeProfiles;
  readonly agents: AgentExecutionSource<TAgent>;
  /** Optional host-owned template source captured once before extension assembly. */
  readonly promptSnapshots?: PromptSnapshotSource;
  /** Ephemeral sidecar for templates rendered before an internal Turn is admitted. */
  readonly internalTurnPromptReads?: Pick<InternalTurnPromptReadRegistry, 'take'>;
  /** Dynamic product facts captured once by TurnPreflight; omitted legacy/test bags use Agent defaults. */
  readonly turnRuntimeFacts?: TurnRuntimeFactSource;
  readonly preparation: LocalTurnPreparationSource<TAgent>;
  readonly history: CanonicalHistoryStore;
  readonly events: AgentEventDelivery;
  readonly executor: LocalTurnExecutor<TAgent>;
  /** Confirms candidate task reads only after the owning Turn is durably committed. */
  readonly backgroundTaskReads?: {
    confirm(input: {
      readonly sessionId: string;
      readonly taskIds: readonly string[];
    }): Promise<readonly string[]>;
  };
  readonly turnControl: AgentHostTurnControl;
  /** Host-owned non-secret metadata needed by Compatible/Codex-compatible Hook stdin. */
  readonly resolvePluginHookRuntimeContext?: (session: SessionRecord) => {
    readonly transcriptPath?: string | null;
    readonly codexTranscriptPath?: string | null;
    readonly permissionMode?: string;
  };
  /** V2-owned Plugin/App/MCP snapshot generation and per-turn lease lifecycle. */
  readonly turnCapabilities?: AgentHostTurnCapabilityLifecycle;
  /** Observes the exact immutable assembly selected for this accepted Turn. */
  readonly assemblyObserver?: AgentHostAssemblyObserver;
  /** Best-effort structured diagnostics; production binds the persistent local-runtime logger. */
  readonly logger?: Pick<PiTurnRunnerLogger, 'info' | 'error'>;
  /** Request-scoped payload transform shared by normal and manual Provider calls. */
  readonly buildRequestPayloadTransform?: (input: {
    readonly agentConfig: LocalTurnPreparation['agentConfig'];
    readonly llm: LocalTurnPreparation['llm'];
    readonly sessionId: string;
    readonly signal: AbortSignal;
  }) => LocalTurnPreparation['llm']['payloadTransform'];
  /**
   * Required by the production factory and by `compact()`. Raw test bags may
   * omit it; such bags cannot execute automatic or manual compaction.
   */
  readonly compaction?: AgentHostCompactionDependencies<TAgent>;
  readonly historyFailure?: AgentHostHistoryFailure;
  /** Optional fail-open analytics projection owned outside required event replay. */
  readonly usage?: AgentHostUsageProjection;
  /** Product-owned policy; AgentHost core defaults to fail-closed when omitted. */
  readonly isRuntimeErrorRetryable?: (errorCode: number | undefined) => boolean;
}

export interface AgentHostAssemblyObserver {
  observe(input: {
    readonly context: TurnAssemblyCtx;
    readonly assembly: AssemblyResult;
  }): Promise<void>;
}

export interface AgentHostRuntimeProfiles {
  readonly normal: {
    assembleModelContext(
      context: ModelContextAssemblyCtx,
      desktopCapabilities?: AgentHostTurnCapabilityView,
    ): ReturnType<AgentRuntime['assembleModelContext']>;
    assembleTurn(
      context: TurnAssemblyCtx,
      desktopCapabilities?: AgentHostTurnCapabilityView,
    ): ReturnType<AgentRuntime['assembleTurn']>;
  };
}

/** Stable accepted-work facade consumed only by TurnSystem coordination. */
export interface AgentHost {
  run(input: AgentHostRunInput): Promise<AgentHostTurnOutcome>;
  compact(input: AgentCompactionInput): Promise<CompactionOutcome>;
}

// Compatibility type exports keep the established AgentHost facade stable
// while definitions stay with their owning preparation/history/event/runner modules.
export type {
  AgentCompactionInput,
  AgentHostCompactionControl,
  AutomaticContextCompactionInput,
  AutomaticContextCompactionProbe,
  AutomaticContextCompactor,
  CheckpointAttemptMetadata,
  CheckpointCandidate,
  CompactionTokenUsage,
  CompactionOutcome,
  ContextCompactionHooks,
  ManualContextCompactionInput,
  ContextCompactionResult,
  ContextCompactor,
} from './compaction/contracts.js';
export type { AgentEventContext } from './events/contracts.js';
export type { AgentHostUsageProjection, CommittedHistoryChange } from './history/contracts.js';
export type {
  AgentExecutionSnapshot,
  AgentExecutionSource,
  AgentHostExecutionRequest,
  AgentHostInputAttachment,
  AgentHostTurnProvenance,
  AgentHostUserInput,
  ContextCompactionPreparationSource,
  LocalTurnPreparationSource,
  TurnOutputContract,
} from './preparation/contracts.js';
export type {
  AcceptedCompactionLease,
  AcceptedTurnLease,
  AgentHostCloseResult,
  AgentHostScopedTurnControl,
  AgentHostSteeringMessage,
  AgentHostTurnControl,
  AgentHostTurnOutcome,
} from './runner/contracts.js';
export { isUserSteeringProducer } from './runner/contracts.js';
