import { getRuntimeBuildEnv, getRuntimeRegion, isManagedRuntime } from '@mavis/config';
import {
  createLocalRuntimeDesktopReporter,
  createLocalRuntimeMetricsClient,
  type MetricsBatchReporter,
  type MetricsClient,
} from '@mavis/shared/local-runtime-logging/metrics';
import type { TuiProcessStopCause } from '../tui/platform/process-stop-cause.js';
import {
  isTuiRunStep,
  type TuiIncidentCaptureSummary,
  type TuiUncleanRunRecovery,
} from './incident-reporter.js';
import type {
  TuiEventStreamObservation,
  TuiObservability,
  TuiStartupObservation,
} from './local-observability.js';

/**
 * TUI host client metrics (crash / startup / event-stream / process health).
 *
 * Metrics go through the shared `local_runtime` Matrix channel with
 * `runtimeOwnerKind="tui"`; names stay BARE and the server stores them as
 * `local_runtime_tui_*`. Labels are fixed enums only — never session ids,
 * paths, user ids or error messages. Everything is event-driven: there is no periodic sampling,
 * so an idle daemon sends nothing.
 * `MetricsClient` routes invalid points and send failures to `onError`, so recording never throws.
 */
export type TuiRunOutcome =
  | 'normal'
  | 'signal'
  | 'managed_restart'
  | 'fatal_error'
  | 'terminal_dead'
  | 'startup_failed'
  | 'startup_aborted';

/** Process surface; becomes the `runtimeOwnerKind` label, matching the embedded Runtime's own. */
export type TuiMetricsSurface = 'tui';

/** Low-cardinality description of where this run executes, stamped on run-level counters. */
export interface TuiRunEnvironment {
  readonly os: NodeJS.Platform;
  readonly transport?: 'local' | 'ssh';
  readonly multiplexer?: 'none' | 'tmux' | 'screen';
}


export interface TuiClientMetrics {
  /** Labels to persist in the run marker so a later recovery can attribute a crash. */
  readonly runLabels: Readonly<Record<string, string>>;
  runStarted(): void;
  /** `error` is what ended a crashed run; its class name becomes the `errorKind` label. */
  runEnded(outcome: TuiRunOutcome, error?: unknown): void;
  uncleanExitRecovered(recovery: TuiUncleanRunRecovery): void;
  incidentCaptured(summary: TuiIncidentCaptureSummary): void;
  startupPhase(observation: TuiStartupObservation): void;
  firstFrameRendered(sinceProcessStartMs: number): void;
  eventStream(observation: TuiEventStreamObservation): void;
  flush(timeoutMs: number): Promise<void>;
}

/** Outcomes counted as crashes; their shutdown flush gets a longer budget. */
export const TUI_CRASH_OUTCOMES: ReadonlySet<TuiRunOutcome> = new Set([
  'fatal_error',
  'startup_failed',
]);

const STARTUP_BUCKETS = [50, 100, 250, 500, 1_000, 1_500, 2_000, 3_000, 5_000, 10_000, 30_000];
const DOWNTIME_BUCKETS = [100, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 300_000];

export const TUI_HISTOGRAM_BUCKETS_BY_NAME: Record<string, number[]> = {
  tui_startup_duration_ms: STARTUP_BUCKETS,
  tui_first_frame_ms: STARTUP_BUCKETS,
  tui_runtime_event_stream_downtime_ms: DOWNTIME_BUCKETS,
};

const STARTUP_METRIC_PHASES = new Set<TuiStartupObservation['phase']>([
  'runtime.initialize',
  'tui.start',
  'tui.first-frame',
  'tui.initial-session-open',
]);
const KNOWN_INCIDENT_PHASES = new Set(['startup', 'runtime', 'shutdown']);
/** Node system error codes (`EADDRINUSE`, `EACCES`): more telling than the generic `Error` name. */
const SYSTEM_ERROR_CODE_RE = /^E[A-Z0-9_]{2,40}$/u;
const KNOWN_OS = new Set<string>(['darwin', 'linux', 'win32']);
const ERROR_KIND_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const EVENT_TYPE_RE = /^cli_[a-z_]{1,48}$/u;

export interface CreateTuiClientMetricsOptions {
  readonly appVersion: string;
  readonly surface?: TuiMetricsSurface;
  readonly environment?: TuiRunEnvironment;
  /** Tests inject an in-memory reporter; production resolves the Matrix reporter. */
  readonly reporter?: MetricsBatchReporter;
  /** Transport for the Matrix reporter; defaults to the global fetch at call time. */
  readonly fetch?: typeof fetch;
}

export function createTuiClientMetrics(options: CreateTuiClientMetricsOptions): TuiClientMetrics {
  // Aborted when a shutdown flush runs out of budget: otherwise the pending request and the
  // reporter's own timeout keep the process alive after we stopped waiting for them. One
  // controller per request: AbortSignal.any on a process-lifetime signal grows the heap of a
  // daemon that reports for weeks.
  const inflight = new Set<AbortController>();
  // close() keeps walking its retry buffer and last snapshot after the flush it was waiting on
  // is aborted, so requests started after that point must fail too.
  let cancelled = false;
  const reporter =
    options.reporter ??
    resolveManagedReporter(async (input, init) => {
      if (cancelled) throw new DOMException('Metrics flush ran out of budget.', 'AbortError');
      const request = new AbortController();
      init?.signal?.addEventListener('abort', () => request.abort(), { once: true });
      inflight.add(request);
      try {
        return await (options.fetch ?? fetch)(input, { ...init, signal: request.signal });
      } finally {
        inflight.delete(request);
      }
    });
  if (!reporter) return noopTuiClientMetrics;
  const surface = options.surface ?? 'tui';
  const client = createLocalRuntimeMetricsClient({
    runtimeOwnerKind: surface,
    appVersion: options.appVersion,
    histogramBucketsByName: TUI_HISTOGRAM_BUCKETS_BY_NAME,
    reporter,
    onError: () => undefined,
  });
  return new MatrixTuiClientMetrics(client, surface, environmentLabels(options.environment), () => {
    cancelled = true;
    inflight.forEach((request) => request.abort());
  });
}

function resolveManagedReporter(fetchImpl: typeof fetch): MetricsBatchReporter | undefined {
  if (!isManagedRuntime()) return undefined;
  const buildEnv = getRuntimeBuildEnv();
  return createLocalRuntimeDesktopReporter({
    fetch: fetchImpl,
    isEn: getRuntimeRegion() === 'en',
    isProd: buildEnv === 'prod',
    isStaging: buildEnv === 'staging',
    isDev: buildEnv === 'dev',
  });
}

export const noopTuiClientMetrics: TuiClientMetrics = Object.freeze({
  runLabels: Object.freeze({}),
  runStarted: () => undefined,
  runEnded: () => undefined,
  uncleanExitRecovered: () => undefined,
  incidentCaptured: () => undefined,
  startupPhase: () => undefined,
  firstFrameRendered: () => undefined,
  eventStream: () => undefined,
  flush: async () => undefined,
});

class MatrixTuiClientMetrics implements TuiClientMetrics {
  private runEndedRecorded = false;

  readonly runLabels: Readonly<Record<string, string>>;

  constructor(
    private readonly client: MetricsClient,
    surface: TuiMetricsSurface,
    private readonly environment: RunEnvironmentLabels,
    private readonly cancelPending: () => void,
  ) {
    this.runLabels = Object.freeze({ runtimeOwnerKind: surface, ...environment });
  }

  runStarted(): void {
    this.client.counter('tui_run_started_total', 1, this.environment);
    // Send the denominator now: a run that dies before the periodic flush would otherwise
    // be counted as an unclean exit next launch without ever being counted as started.
    void this.client.flush();
  }

  runEnded(outcome: TuiRunOutcome, error?: unknown): void {
    if (this.runEndedRecorded) return;
    this.runEndedRecorded = true;
    this.client.counter('tui_run_ended_total', 1, {
      ...this.environment,
      outcome,
      // Always present: the gateway drops samples whose label keys differ within a family.
      errorKind: TUI_CRASH_OUTCOMES.has(outcome) ? normalizeErrorKind(errorKindOf(error)) : 'none',
    });
  }

  uncleanExitRecovered(recovery: TuiUncleanRunRecovery): void {
    this.client.counter('tui_unclean_exit_total', 1, {
      // Attribute the crash to the run that died using its marker metadata.
      ...recoveredRunLabels(recovery.labels ?? {}),
      phase: recoveredPhase(recovery),
      reason: recovery.reason,
      appVersion: normalizeMetricAppVersion(recovery.appVersion),
    });
  }

  incidentCaptured(summary: TuiIncidentCaptureSummary): void {
    // Unclean exits have their own counter; counting them here would double-report.
    if (summary.eventType === 'cli_unclean_exit') return;
    this.client.counter('tui_incident_total', 1, {
      eventType: EVENT_TYPE_RE.test(summary.eventType) ? summary.eventType : 'other',
      severity: summary.severity,
    });
  }

  startupPhase(observation: TuiStartupObservation): void {
    if (observation.outcome === 'started' || observation.durationMs === undefined) return;
    if (!STARTUP_METRIC_PHASES.has(observation.phase)) return;
    this.client.histogram('tui_startup_duration_ms', observation.durationMs, {
      phase: observation.phase,
      outcome: observation.outcome,
    });
  }

  firstFrameRendered(sinceProcessStartMs: number): void {
    this.client.histogram('tui_first_frame_ms', sinceProcessStartMs);
  }

  eventStream(observation: TuiEventStreamObservation): void {
    // One count per disconnect episode; retries inside the same episode are not re-counted.
    if (observation.state === 'disconnected' && observation.attempt === 1) {
      this.client.counter('tui_runtime_event_stream_disconnect_total', 1, {
        errorKind: normalizeErrorKind(observation.errorKind),
      });
    } else if (observation.state === 'reconnected' && observation.downtimeMs !== undefined) {
      this.client.histogram('tui_runtime_event_stream_downtime_ms', observation.downtimeMs);
    }
  }

  async flush(timeoutMs: number): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([
      this.client.close(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          this.cancelPending();
          resolve();
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]);
    clearTimeout(timeout);
  }
}

/** Maps the first process stop cause (if any) and launch state to one run outcome. */
export function resolveTuiRunOutcome(input: {
  readonly stopCause?: TuiProcessStopCause;
  readonly launchError: boolean;
  readonly tuiRunning: boolean;
  readonly stoppedNormally: boolean;
}): TuiRunOutcome {
  const cause = input.stopCause;
  if (cause) {
    if (cause.terminalDead) return 'terminal_dead';
    if (cause.source === 'signal') return 'signal';
    return input.tuiRunning ? 'fatal_error' : 'startup_failed';
  }
  if (input.launchError) return input.tuiRunning ? 'fatal_error' : 'startup_failed';
  if (input.stoppedNormally) return 'normal';
  return input.tuiRunning ? 'normal' : 'startup_aborted';
}

/** Adds metric derivation to the existing local observability without changing its JSONL output. */
export function withTuiClientMetrics(
  observability: TuiObservability,
  metrics: TuiClientMetrics,
): TuiObservability {
  if (metrics === noopTuiClientMetrics) return observability;
  const base = observability;
  const decorated: TuiObservability = {
    recordStartup: (observation) => {
      base.recordStartup(observation);
      metrics.startupPhase(observation);
      if (observation.phase === 'tui.first-frame' && observation.outcome === 'succeeded') {
        metrics.firstFrameRendered(performance.now());
      }
    },
    recordEventStream: (observation) => {
      base.recordEventStream(observation);
      metrics.eventStream(observation);
    },
    recordAccess: (observation) => base.recordAccess(observation),
    recordTerminal: (observation) => base.recordTerminal(observation),
    recordProcessStop: (observation) => base.recordProcessStop(observation),
    observeRender: (observation) => base.observeRender(observation),
    snapshot: () => base.snapshot(),
    flush: () => base.flush(),
  };
  if (base.recordClipboardRead) {
    decorated.recordClipboardRead = (observation) => base.recordClipboardRead?.(observation);
  }
  if (base.recordSideSessionFailure) {
    decorated.recordSideSessionFailure = (observation) =>
      base.recordSideSessionFailure?.(observation);
  }
  if (base.recordStopPolicy) {
    decorated.recordStopPolicy = (observation) => base.recordStopPolicy?.(observation);
  }
  if (base.recordRunLifecycle) {
    decorated.recordRunLifecycle = (observation) => base.recordRunLifecycle?.(observation);
  }
  if (base.recordTheme) {
    decorated.recordTheme = (observation) => base.recordTheme?.(observation);
  }
  return decorated;
}

/**
 * Environment label keys stamped on every run-level counter. The Matrix gateway registers a
 * family's label keys on first sight and drops later samples with a different key set, so every
 * key is always present; a dimension that does not apply to the surface is `none`.
 */
const RUN_LABEL_VALUES = {
  runtimeOwnerKind: new Set(['tui', 'unknown']),
  os: new Set(['darwin', 'linux', 'win32', 'other', 'unknown']),
  transport: new Set(['local', 'ssh', 'none', 'unknown']),
  multiplexer: new Set(['none', 'tmux', 'screen', 'unknown']),
  listen: new Set(['stdio', 'unix', 'none', 'unknown']),
} satisfies Record<string, ReadonlySet<string>>;

type RunLabelKey = keyof typeof RUN_LABEL_VALUES;
type RunEnvironmentLabels = Record<Exclude<RunLabelKey, 'runtimeOwnerKind'>, string>;

function environmentLabels(environment: TuiRunEnvironment | undefined): RunEnvironmentLabels {
  if (!environment)
    return { os: 'unknown', transport: 'unknown', multiplexer: 'unknown', listen: 'unknown' };
  return {
    os: KNOWN_OS.has(environment.os) ? environment.os : 'other',
    transport: environment.transport ?? 'none',
    multiplexer: environment.multiplexer ?? 'none',
    listen: 'none',
  };
}

/** Run labels read back from a marker file; every key is present, anything unexpected is `unknown`. */
function recoveredRunLabels(labels: Readonly<Record<string, string>>): Record<RunLabelKey, string> {
  return Object.fromEntries(
    (Object.keys(RUN_LABEL_VALUES) as RunLabelKey[]).map((key) => {
      const value = labels[key];
      return [key, value !== undefined && RUN_LABEL_VALUES[key].has(value) ? value : 'unknown'];
    }),
  ) as Record<RunLabelKey, string>;
}

/**
 * Same release/channel normalization as the shared `appVersion` default label, applied to a
 * version read from a previous run's marker.
 */
export function normalizeMetricAppVersion(version: string): string {
  if (/^\d+\.\d+\.\d+$/u.test(version)) return version;
  return (
    version.match(/^(\d+\.\d+\.\d+-(?:preview|inside|test|staging))(?:[.+-].*)?$/u)?.[1] ??
    'unknown'
  );
}

/** `startup` / `runtime` / `shutdown`, suffixed with the step the run died in (`shutdown.runtime`). */
function recoveredPhase(recovery: TuiUncleanRunRecovery): string {
  if (!KNOWN_INCIDENT_PHASES.has(recovery.phase)) return 'other';
  return isTuiRunStep(recovery.step) ? `${recovery.phase}.${recovery.step}` : recovery.phase;
}

function errorKindOf(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as Error & { code?: unknown }).code;
  return error.name === 'Error' && typeof code === 'string' && SYSTEM_ERROR_CODE_RE.test(code)
    ? code
    : error.name;
}

function normalizeErrorKind(kind: string | undefined): string {
  if (!kind) return 'unknown';
  return ERROR_KIND_RE.test(kind) ? kind : 'other';
}
