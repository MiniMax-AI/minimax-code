import { appendFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { redactTuiSensitiveText } from '../user-facing-failure.js';

export type TuiObservabilitySurface = 'tui' | 'headless' | 'acp' | 'inspection';
export type TuiRuntimeAccessSource = 'process-local';

export interface TuiStartupObservation {
  readonly phase:
    | 'cli.process'
    | 'tui.start'
    | 'tui.first-frame'
    | 'tui.initial-session-open'
    | 'tui.initial-prompt'
    | 'runtime.initialize'
    | 'runtime.shutdown';
  readonly outcome: 'started' | 'succeeded' | 'failed';
  readonly durationMs?: number;
  readonly errorKind?: string;
}

export interface TuiRuntimeAccessObservation {
  readonly operation: string;
  readonly source: TuiRuntimeAccessSource;
}

export interface TuiEventStreamObservation {
  readonly state: 'connected' | 'disconnected' | 'retry-scheduled' | 'reconnected';
  readonly attempt: number;
  readonly retryDelayMs?: number;
  readonly downtimeMs?: number;
  readonly errorKind?: string;
}

export interface TuiTerminalObservation {
  readonly terminalId: string;
  readonly platform: NodeJS.Platform;
  readonly isTTY: boolean;
  readonly transport: 'local' | 'ssh';
  readonly multiplexer: 'none' | 'tmux' | 'screen';
  readonly color: boolean;
  readonly colorLevel: 0 | 1 | 2 | 3;
  readonly columns: number;
  readonly rows: number;
}

export interface TuiThemeObservation {
  readonly appearance: 'light' | 'dark';
  readonly source: 'terminal-report' | 'osc11' | 'colorfgbg' | 'fallback';
  readonly detail: string;
  readonly colorLevel: 0 | 1 | 2 | 3;
}

export interface TuiRenderObservation {
  readonly durationMs: number;
  readonly width: number;
  readonly height: number;
  readonly changedLines: number;
  readonly fullRedraw: boolean;
}

export interface TuiProcessErrorObservation {
  readonly name?: string;
  readonly message?: string;
  readonly code?: string | number;
  readonly errno?: string | number;
  readonly syscall?: string;
  readonly stack?: string;
}

export interface TuiWritableStreamObservation {
  readonly constructorName: string;
  readonly isTTY?: boolean;
  readonly writable?: boolean;
  readonly destroyed?: boolean;
  readonly writableEnded?: boolean;
  readonly writableFinished?: boolean;
  readonly writableNeedDrain?: boolean;
}

export interface TuiAsyncResourceTargetObservation {
  readonly constructorName: string;
  readonly identity: 'stdout' | 'stderr' | 'other';
  readonly fd: 1 | 2 | 'other';
  readonly errorListenerCount?: number;
}

export interface TuiAsyncResourceObservation {
  readonly executionAsyncId: number;
  readonly triggerAsyncId: number;
  readonly resource: TuiAsyncResourceTargetObservation;
  readonly owner?: TuiAsyncResourceTargetObservation;
  readonly stream?: TuiAsyncResourceTargetObservation;
  readonly handle?: TuiAsyncResourceTargetObservation;
}

export interface TuiProcessStopObservation {
  readonly source: string;
  readonly terminalDead: boolean;
  readonly signal?: string;
  readonly bytes?: number;
  readonly error?: TuiProcessErrorObservation;
  readonly runtime: {
    readonly nodeVersion: string;
    readonly uvVersion?: string;
    readonly platform: NodeJS.Platform;
    readonly arch: string;
    readonly pid: number;
  };
  readonly asyncResource?: TuiAsyncResourceObservation;
  readonly stdout: TuiWritableStreamObservation;
  readonly stderr: TuiWritableStreamObservation;
}

export interface TuiObservabilitySnapshot {
  readonly filePath: string;
  readonly eventCounts: Readonly<Record<string, number>>;
  readonly accessSources: Readonly<Record<string, TuiRuntimeAccessSource>>;
  readonly reconnects: number;
  readonly render: {
    readonly frames: number;
    readonly averageDurationMs: number;
    readonly maxDurationMs: number;
    readonly p95DurationMs: number;
  };
  readonly terminal?: TuiTerminalObservation;
}

export interface TuiSideSessionFailureObservation {
  readonly stage: 'create' | 'activate';
  readonly parentSessionId: string;
  readonly sideSessionId?: string;
  readonly error: unknown;
}

export interface TuiObservability {
  recordSideSessionFailure?(observation: TuiSideSessionFailureObservation): void;
  recordStartup(observation: TuiStartupObservation): void;
  recordAccess(observation: TuiRuntimeAccessObservation): void;
  recordEventStream(observation: TuiEventStreamObservation): void;
  recordTerminal(observation: TuiTerminalObservation): void;
  recordProcessStop(observation: TuiProcessStopObservation): void;
  recordTheme?(observation: TuiThemeObservation): void;
  observeRender(observation: TuiRenderObservation): void;
  snapshot(): TuiObservabilitySnapshot;
  flush(): Promise<void>;
}

interface TuiObservabilityEnvelope {
  readonly schemaVersion: 1;
  readonly observedAtMs: number;
  readonly surface: TuiObservabilitySurface;
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface CreateTuiObservabilityOptions {
  readonly surface: TuiObservabilitySurface;
  readonly pid?: number;
  readonly startedAtMs?: number;
  readonly now?: () => number;
  readonly append?: (path: string, content: string) => Promise<void>;
  readonly ensureDirectory?: (path: string) => Promise<void>;
  readonly prune?: (directory: string, cutoffMs: number) => Promise<void>;
}

const SCHEMA_VERSION = 1;
const RENDER_SLOW_FRAME_MS = 16;
const RENDER_INITIAL_SAMPLE_COUNT = 3;
const RENDER_PERIODIC_SAMPLE_INTERVAL = 120;
const RENDER_RESERVOIR_SIZE = 512;
const AUTO_FLUSH_DELAY_MS = 1_000;
const AUTO_FLUSH_BATCH_SIZE = 32;
const OBSERVABILITY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const FILE_PREFIX = 'mcode-observability-';

export function resolveTuiObservabilityDirectory(dataDir: string): string {
  return join(dataDir, 'v2', 'observability', 'mcode');
}

export function createTuiObservability(
  dataDir: string,
  options: CreateTuiObservabilityOptions,
): TuiObservability {
  return new LocalTuiObservability(dataDir, options);
}

export const noopTuiObservability: TuiObservability = Object.freeze({
  recordStartup: () => undefined,
  recordAccess: () => undefined,
  recordEventStream: () => undefined,
  recordTerminal: () => undefined,
  recordProcessStop: () => undefined,
  recordTheme: () => undefined,
  observeRender: () => undefined,
  snapshot: (): TuiObservabilitySnapshot => ({
    filePath: '',
    eventCounts: {},
    accessSources: {},
    reconnects: 0,
    render: {
      frames: 0,
      averageDurationMs: 0,
      maxDurationMs: 0,
      p95DurationMs: 0,
    },
  }),
  flush: async () => undefined,
});

class LocalTuiObservability implements TuiObservability {
  private readonly surface: TuiObservabilitySurface;
  private readonly now: () => number;
  private readonly append: (path: string, content: string) => Promise<void>;
  private readonly ready: Promise<void>;
  private readonly pending: TuiObservabilityEnvelope[] = [];
  private readonly eventCounts = new Map<string, number>();
  private readonly accessSources = new Map<string, TuiRuntimeAccessSource>();
  private readonly renderDurations: number[] = [];
  private writeChain = Promise.resolve();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnects = 0;
  private renderFrames = 0;
  private renderDurationTotalMs = 0;
  private renderMaxDurationMs = 0;
  private lastRenderSummaryFrame = 0;
  private terminal: TuiTerminalObservation | undefined;
  readonly filePath: string;

  constructor(dataDir: string, options: CreateTuiObservabilityOptions) {
    const startedAtMs = options.startedAtMs ?? Date.now();
    const directory = resolveTuiObservabilityDirectory(dataDir);
    this.surface = options.surface;
    this.now = options.now ?? Date.now;
    this.append =
      options.append ??
      ((path, content) => appendFile(path, content, { encoding: 'utf8', mode: 0o600 }));
    this.filePath = join(
      directory,
      `${FILE_PREFIX}${startedAtMs}-${options.pid ?? process.pid}.jsonl`,
    );
    const ensureDirectory =
      options.ensureDirectory ??
      ((path: string) => mkdir(path, { recursive: true }).then(() => {}));
    const prune = options.prune ?? pruneOldObservabilityFiles;
    this.ready = ensureDirectory(directory)
      .then(() => prune(directory, startedAtMs - OBSERVABILITY_RETENTION_MS))
      .catch(() => undefined);
  }

  recordSideSessionFailure(observation: TuiSideSessionFailureObservation): void {
    const { error, ...context } = observation;
    this.record('session.side.failed', { ...context, errors: describeSideSessionErrors(error) });
  }

  recordStartup(observation: TuiStartupObservation): void {
    this.record('startup', observation);
  }

  recordAccess(observation: TuiRuntimeAccessObservation): void {
    if (this.accessSources.get(observation.operation) === observation.source) return;
    this.accessSources.set(observation.operation, observation.source);
    this.record('runtime.access', observation);
  }

  recordEventStream(observation: TuiEventStreamObservation): void {
    if (observation.state === 'retry-scheduled') this.reconnects += 1;
    this.record('event.stream', observation);
  }

  recordTerminal(observation: TuiTerminalObservation): void {
    this.terminal = Object.freeze({ ...observation });
    this.record('terminal.capability', observation);
  }

  recordProcessStop(observation: TuiProcessStopObservation): void {
    this.record('process.stop', observation);
  }

  recordTheme(observation: TuiThemeObservation): void {
    this.record('terminal.theme', observation);
  }

  observeRender(observation: TuiRenderObservation): void {
    const durationMs = normalizeDuration(observation.durationMs);
    this.renderFrames += 1;
    this.renderDurationTotalMs += durationMs;
    this.renderMaxDurationMs = Math.max(this.renderMaxDurationMs, durationMs);
    this.renderDurations.push(durationMs);
    if (this.renderDurations.length > RENDER_RESERVOIR_SIZE) this.renderDurations.shift();

    if (
      this.renderFrames <= RENDER_INITIAL_SAMPLE_COUNT ||
      durationMs >= RENDER_SLOW_FRAME_MS ||
      this.renderFrames % RENDER_PERIODIC_SAMPLE_INTERVAL === 0
    ) {
      this.record('render.latency', {
        ...observation,
        durationMs,
        frame: this.renderFrames,
      });
    }
  }

  snapshot(): TuiObservabilitySnapshot {
    return {
      filePath: this.filePath,
      eventCounts: {
        startup: this.eventCounts.get('startup') ?? 0,
        runtimeAccess: this.eventCounts.get('runtime.access') ?? 0,
        eventStream: this.eventCounts.get('event.stream') ?? 0,
        terminal: this.eventCounts.get('terminal.capability') ?? 0,
        processStop: this.eventCounts.get('process.stop') ?? 0,
        renderLatency: this.eventCounts.get('render.latency') ?? 0,
        renderSummary: this.eventCounts.get('render.summary') ?? 0,
      },
      accessSources: Object.fromEntries(this.accessSources),
      reconnects: this.reconnects,
      render: this.renderSnapshot(),
      ...(this.terminal ? { terminal: { ...this.terminal } } : {}),
    };
  }

  async flush(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.renderFrames > this.lastRenderSummaryFrame) {
      this.record('render.summary', this.renderSnapshot());
      this.lastRenderSummaryFrame = this.renderFrames;
    }
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.queuePendingWrite();
    await this.writeChain;
  }

  private queuePendingWrite(): void {
    if (this.pending.length > 0) {
      const batch = this.pending.splice(0);
      const content = `${batch.map((event) => JSON.stringify(event)).join('\n')}\n`;
      this.writeChain = this.writeChain
        .then(() => this.ready)
        .then(() => this.append(this.filePath, content))
        .catch(() => undefined);
    }
  }

  private renderSnapshot(): TuiObservabilitySnapshot['render'] {
    return {
      frames: this.renderFrames,
      averageDurationMs:
        this.renderFrames === 0
          ? 0
          : roundMilliseconds(this.renderDurationTotalMs / this.renderFrames),
      maxDurationMs: roundMilliseconds(this.renderMaxDurationMs),
      p95DurationMs: roundMilliseconds(percentile(this.renderDurations, 0.95)),
    };
  }

  private record(type: string, details: object): void {
    this.eventCounts.set(type, (this.eventCounts.get(type) ?? 0) + 1);
    this.pending.push({
      schemaVersion: SCHEMA_VERSION,
      observedAtMs: Math.floor(this.now()),
      surface: this.surface,
      type,
      ...details,
    });
    if (this.pending.length >= AUTO_FLUSH_BATCH_SIZE) {
      if (this.flushTimer) clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
      this.queuePendingWrite();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        this.queuePendingWrite();
      }, AUTO_FLUSH_DELAY_MS);
      this.flushTimer.unref?.();
    }
  }
}

async function pruneOldObservabilityFiles(directory: string, cutoffMs: number): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(FILE_PREFIX))
      .map(async (entry) => {
        const path = join(directory, entry.name);
        const metadata = await stat(path);
        if (metadata.mtimeMs < cutoffMs) await rm(path, { force: true });
      }),
  );
}

function normalizeDuration(value: number): number {
  return roundMilliseconds(Math.max(0, Number.isFinite(value) ? value : 0));
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? 0;
}

/** Keep diagnostic causes bounded and redact text before it enters the uploadable local log. */
function describeSideSessionErrors(error: unknown): readonly TuiProcessErrorObservation[] {
  const errors: TuiProcessErrorObservation[] = [];
  let current = error;
  for (let depth = 0; current !== undefined && depth < 3; depth += 1) {
    if (!(current instanceof Error)) {
      errors.push({ message: redactTuiSensitiveText(String(current)).slice(0, 1_024) });
      break;
    }
    const code: unknown = Reflect.get(current, 'code');
    errors.push({
      name: redactTuiSensitiveText(current.name).slice(0, 128),
      message: redactTuiSensitiveText(current.message).slice(0, 1_024),
      ...(typeof code === 'string' ? { code: redactTuiSensitiveText(code).slice(0, 128) } : {}),
      ...(current.stack ? { stack: redactTuiSensitiveText(current.stack).slice(0, 2_048) } : {}),
    });
    current = current.cause;
  }
  return errors;
}
