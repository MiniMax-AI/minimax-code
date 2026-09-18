import { createCipheriv, createHash, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { arch, platform } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { isTelemetryChannelEnabled, type MavisBuildEnv, type MavisRegion } from '@mavis/config';

export type TuiIncidentPhase = 'startup' | 'runtime' | 'shutdown';
export type TuiIncidentSeverity = 'fatal' | 'error' | 'warning';
export type TuiIncidentImpact = 'exit' | 'screen_unavailable' | 'action_failed' | 'degraded';
export type TuiIncidentEventType =
  | 'cli_process_error'
  | 'cli_startup_error'
  | 'cli_render_error'
  | 'cli_interaction_error'
  | 'cli_runtime_bridge_error'
  | 'cli_terminal_error'
  | 'cli_persistence_error'
  | 'cli_shutdown_error'
  | 'cli_unclean_exit';

type TuiIncidentPrimitive = string | number | boolean | null;

export interface TuiIncidentCapture {
  readonly eventType: TuiIncidentEventType;
  readonly error: unknown;
  readonly component: string;
  readonly operation: string;
  readonly codeLocation: string;
  readonly severity?: TuiIncidentSeverity;
  readonly impact?: TuiIncidentImpact;
  readonly handled?: boolean;
  readonly phase?: TuiIncidentPhase;
  readonly context?: Readonly<Record<string, TuiIncidentPrimitive | undefined>>;
}

export interface TuiIncidentSink {
  capture(input: TuiIncidentCapture): string | undefined;
  breadcrumb(
    name: string,
    details?: Readonly<Record<string, TuiIncidentPrimitive | undefined>>,
  ): void;
}

export interface TuiIncidentReporter extends TuiIncidentSink {
  readonly runId: string;
  readonly hasFatalIncident: boolean;
  setPhase(phase: TuiIncidentPhase): void;
  drain(): Promise<void>;
  flush(timeoutMs?: number): Promise<void>;
  completeRun(): void;
}

export interface TuiIncidentAuthContext {
  readonly accessToken?: string;
  readonly realUserID?: string;
}

export interface CreateTuiIncidentReporterOptions {
  /** Explicit `telemetry.diagnostics` opt-in; environment opt-outs always take precedence. */
  readonly readTelemetryEnabled?: () => boolean | undefined;
  readonly dataDir: string;
  readonly appVersion: string;
  readonly region: MavisRegion;
  readonly buildEnv: MavisBuildEnv;
  readonly resolveAuthContext?: () =>
    | TuiIncidentAuthContext
    | undefined
    | Promise<TuiIncidentAuthContext | undefined>;
  readonly fetchImpl?: typeof fetch;
  readonly nowMs?: () => number;
  readonly pid?: number;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly nodeVersion?: string;
  readonly osVersion?: string;
  readonly terminal?: string;
  readonly tuiMode?: string;
  readonly requestTimeoutMs?: number;
}

interface TuiIncidentBreadcrumb {
  readonly occurredAtMs: number;
  readonly name: string;
  readonly details?: Readonly<Record<string, TuiIncidentPrimitive>>;
}

interface TuiIncidentErrorSnapshot {
  readonly name: string;
  readonly code?: string;
  readonly status?: number;
}

interface TuiStoredIncident {
  readonly schemaVersion: 2;
  readonly incidentId: string;
  readonly eventType: TuiIncidentEventType;
  readonly occurredAtMs: number;
  readonly codeLocation: string;
  readonly eventLog: string;
}

interface TuiRunMarker {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly pid: number;
  readonly startedAtMs: number;
  readonly updatedAtMs: number;
  readonly phase: TuiIncidentPhase;
  readonly appVersion: string;
}

interface TuiWireIncident {
  readonly event_type: string;
  readonly event_log: string;
  readonly occurred_at_ms: number;
  readonly code_location: string;
}

const INCIDENT_DIRECTORY = ['v2', 'observability', 'cli', 'incidents'] as const;
// Version 1 records contain arbitrary private text and must never be replayed.
const INCIDENT_SCHEMA_VERSION = 2;
const EVENT_LOG_WIRE_VERSION = 'v1';
// Gateway wire compatibility value. It is cryptographic KDF input, not a source identifier.
const EVENT_LOG_HKDF_SALT = 'mcode-desktop-event-log-v1';
const MAX_INCIDENT_FILES = 200;
const MAX_NON_FATAL_INCIDENTS_PER_RUN = 100;
const MAX_BREADCRUMBS = 20;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const NON_FATAL_DEDUPE_MS = 60_000;
const FATAL_DEDUPE_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_FLUSH_TIMEOUT_MS = 300;
const BATCH_SIZE = 20;

const ERROR_API_HOST: Readonly<Record<MavisRegion, Readonly<Record<MavisBuildEnv, string>>>> = {
  cn: {
    dev: 'https://matrix-test.example.invalid',
    test: 'https://matrix-test.example.invalid',
    staging: 'https://matrix-pre.example.invalid',
    prod: 'https://agent.minimaxi.com',
  },
  en: {
    dev: 'https://matrix-overseas-test.example.invalid',
    test: 'https://matrix-overseas-test.example.invalid',
    staging: 'https://matrix-overseas-pre.example.invalid',
    prod: 'https://agent.minimax.io',
  },
};
const ERROR_BATCH_PATH = '/minimax-cloud/api/v1/observability/desktop-errors/batch';

export function resolveTuiIncidentDirectory(dataDir: string): string {
  return join(dataDir, ...INCIDENT_DIRECTORY);
}

export function createTuiIncidentReporter(
  options: CreateTuiIncidentReporterOptions,
): TuiIncidentReporter {
  try {
    return new LocalTuiIncidentReporter(options);
  } catch {
    return noopTuiIncidentReporter;
  }
}

export const noopTuiIncidentReporter: TuiIncidentReporter = Object.freeze({
  runId: '',
  hasFatalIncident: false,
  capture: () => undefined,
  breadcrumb: () => undefined,
  setPhase: () => undefined,
  drain: async () => undefined,
  flush: async () => undefined,
  completeRun: () => undefined,
});

export function captureTuiIncidentBestEffort(
  sink: TuiIncidentSink | undefined,
  input: TuiIncidentCapture,
): string | undefined {
  try {
    return sink?.capture(input);
  } catch {
    return undefined;
  }
}

class LocalTuiIncidentReporter implements TuiIncidentReporter {
  readonly runId = randomUUID();
  private readonly directory: string;
  private readonly markerPath: string;
  private readonly nowMs: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly pid: number;
  private readonly startedAtMs: number;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly breadcrumbs: TuiIncidentBreadcrumb[] = [];
  private readonly recentFingerprints = new Map<string, number>();
  private readonly activeRequestControllers = new Set<AbortController>();
  private drainPromise: Promise<void> | undefined;
  private drainRequested = false;
  private phase: TuiIncidentPhase = 'startup';
  private nonFatalIncidentCount = 0;
  private fatalIncidentCaptured = false;
  private networkDrainStopped = false;
  private completed = false;

  constructor(private readonly options: CreateTuiIncidentReporterOptions) {
    this.directory = resolveTuiIncidentDirectory(options.dataDir);
    this.nowMs = options.nowMs ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.pid = options.pid ?? process.pid;
    this.startedAtMs = this.nowMs();
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    this.markerPath = join(this.directory, `active-${this.runId}.json`);
    ensurePrivateDirectory(this.directory);
    this.prune();
    this.recoverUncleanRuns();
    this.writeRunMarker();
    this.breadcrumb('cli.run.started', { phase: this.phase });
    void this.drain();
  }

  get hasFatalIncident(): boolean {
    return this.fatalIncidentCaptured;
  }

  setPhase(phase: TuiIncidentPhase): void {
    if (this.completed || this.phase === phase) return;
    this.phase = phase;
    this.breadcrumb('cli.phase.changed', { phase });
    this.writeRunMarker();
  }

  breadcrumb(
    name: string,
    details?: Readonly<Record<string, TuiIncidentPrimitive | undefined>>,
  ): void {
    try {
      const cleanName = allowedString(name, BREADCRUMB_NAMES);
      if (!cleanName) return;
      const phase = allowedString(details?.phase, PHASES);
      this.breadcrumbs.push({
        occurredAtMs: Math.floor(this.nowMs()),
        name: cleanName,
        ...(phase ? { details: { phase } } : {}),
      });
      while (this.breadcrumbs.length > MAX_BREADCRUMBS) this.breadcrumbs.shift();
    } catch {
      // Incident context must remain fail-open.
    }
  }

  capture(input: TuiIncidentCapture): string | undefined {
    try {
      const eventType = allowedString(input.eventType, EVENT_TYPES);
      if (!eventType) return undefined;
      const severity = allowedString(input.severity, SEVERITIES) ?? 'error';
      if (severity !== 'fatal' && this.nonFatalIncidentCount >= MAX_NON_FATAL_INCIDENTS_PER_RUN) {
        return undefined;
      }
      const occurredAtMs = Math.floor(this.nowMs());
      const error = snapshotError(input.error);
      const fingerprint = incidentFingerprint(eventType, error);
      const dedupeKey = `${eventType}:${fingerprint}`;
      const previousAtMs = this.recentFingerprints.get(dedupeKey);
      const dedupeWindowMs = severity === 'fatal' ? FATAL_DEDUPE_MS : NON_FATAL_DEDUPE_MS;
      if (previousAtMs !== undefined && occurredAtMs - previousAtMs < dedupeWindowMs) {
        return undefined;
      }
      this.recentFingerprints.set(dedupeKey, occurredAtMs);
      if (severity === 'fatal') this.fatalIncidentCaptured = true;
      else this.nonFatalIncidentCount += 1;

      const incidentId = randomUUID();
      const eventLog = minimizeEventLog(
        {
          incidentId,
          runId: this.runId,
          phase: input.phase ?? this.phase,
          severity,
          impact: input.impact ?? (severity === 'fatal' ? 'exit' : 'action_failed'),
          handled: input.handled ?? severity !== 'fatal',
          error,
          // Caller context, terminal names, OS strings and free-form operation/location
          // labels are deliberately excluded, even if they look like credentials were redacted.
          context: {
            appVersion: this.options.appVersion,
            platform: this.options.platform ?? platform(),
            arch: this.options.architecture ?? arch(),
            nodeVersion: this.options.nodeVersion ?? process.versions.node,
          },
          breadcrumbs: this.breadcrumbs,
        },
        eventType,
      );

      const stored: TuiStoredIncident = {
        schemaVersion: INCIDENT_SCHEMA_VERSION,
        incidentId,
        eventType,
        occurredAtMs,
        codeLocation: `tui.${eventType}`,
        eventLog,
      };
      writeJsonAtomically(
        this.directory,
        join(
          this.directory,
          `${this.uploadEnabled() ? 'pending' : 'local'}-${occurredAtMs}-${incidentId}.json`,
        ),
        stored,
      );
      this.prune();
      void this.drain();
      return incidentId;
    } catch {
      return undefined;
    }
  }

  drain(): Promise<void> {
    this.drainRequested = true;
    if (this.drainPromise) return this.drainPromise;
    const drain = this.runDrainLoop().finally(() => {
      if (this.drainPromise === drain) this.drainPromise = undefined;
    });
    this.drainPromise = drain;
    return drain;
  }

  private async runDrainLoop(): Promise<void> {
    do {
      this.drainRequested = false;
      await this.drainPending();
    } while (this.drainRequested);
  }

  async flush(timeoutMs = DEFAULT_CLOSE_FLUSH_TIMEOUT_MS): Promise<void> {
    const drain = this.drain();
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      await drain.catch(() => undefined);
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        drain.catch(() => undefined),
        new Promise<void>((resolve) => {
          timeout = setTimeout(
            () => {
              this.networkDrainStopped = true;
              for (const controller of this.activeRequestControllers) controller.abort();
              resolve();
            },
            Math.max(0, timeoutMs),
          );
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  completeRun(): void {
    if (this.completed) return;
    this.completed = true;
    try {
      rmSync(this.markerPath, { force: true });
    } catch {
      // A stale marker is recoverable on the next launch.
    }
  }

  private async drainPending(): Promise<void> {
    if (!this.uploadEnabled()) return;
    const resolveAuthContext = this.options.resolveAuthContext;
    if (!resolveAuthContext) return;
    let auth: TuiIncidentAuthContext | undefined;
    try {
      auth = await resolveAuthContext();
    } catch {
      return;
    }
    const accessToken = auth?.accessToken?.trim();
    const realUserID = auth?.realUserID?.trim();
    if (!accessToken || !realUserID) return;

    const pending = readStoredIncidents(this.directory);
    for (let index = 0; index < pending.length; index += BATCH_SIZE) {
      const batch = pending.slice(index, index + BATCH_SIZE);
      let wireEvents: TuiWireIncident[];
      try {
        wireEvents = batch.map(({ incident }) => ({
          event_type: incident.eventType,
          event_log: encryptEventLog(incident.eventLog, accessToken, realUserID, incident),
          occurred_at_ms: incident.occurredAtMs,
          code_location: incident.codeLocation,
        }));
      } catch {
        return;
      }
      if (!(await this.sendBatch(wireEvents, accessToken, realUserID))) return;
      for (const item of batch) markIncidentSent(item.path);
    }
  }

  private async sendBatch(
    events: readonly TuiWireIncident[],
    accessToken: string,
    realUserID: string,
  ): Promise<boolean> {
    if (this.networkDrainStopped || !this.uploadEnabled()) return false;
    const requestController = new AbortController();
    const requestTimeout = setTimeout(
      () => requestController.abort(),
      this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
    requestTimeout.unref?.();
    this.activeRequestControllers.add(requestController);
    try {
      const requestUrl = new URL(
        `${ERROR_API_HOST[this.options.region][this.options.buildEnv]}${ERROR_BATCH_PATH}`,
      );
      if (requestUrl.protocol !== 'https:') return false;
      requestUrl.searchParams.set('user_id', realUserID);
      const response = await this.fetchImpl(requestUrl, {
        method: 'POST',
        headers: {
          'User-Agent': 'MiniMaxAgent',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ events }),
        signal: requestController.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(requestTimeout);
      this.activeRequestControllers.delete(requestController);
    }
  }

  private recoverUncleanRuns(): void {
    for (const entry of safeReadDirectory(this.directory)) {
      if (!entry.startsWith('active-') || !entry.endsWith('.json')) continue;
      const path = join(this.directory, entry);
      const marker = readRunMarker(path);
      if (!marker) {
        safeRemove(path);
        continue;
      }
      if (marker.pid !== this.pid && this.isProcessAlive(marker.pid)) continue;
      this.capture({
        eventType: 'cli_unclean_exit',
        error: new Error(`Previous TUI run ended without completing ${marker.phase}.`),
        component: 'process',
        operation: 'recover-unclean-run',
        codeLocation: 'src/observability/incident-reporter.ts#recoverUncleanRuns',
        severity: 'error',
        impact: 'exit',
        handled: true,
        phase: marker.phase,
        context: {
          previousRunId: marker.runId,
          previousPid: marker.pid,
          previousAppVersion: marker.appVersion,
          previousStartedAtMs: marker.startedAtMs,
          previousUpdatedAtMs: marker.updatedAtMs,
        },
      });
      safeRemove(path);
    }
  }

  private writeRunMarker(): void {
    if (this.completed) return;
    const marker: TuiRunMarker = {
      schemaVersion: 1,
      runId: this.runId,
      pid: this.pid,
      startedAtMs: this.startedAtMs,
      updatedAtMs: Math.floor(this.nowMs()),
      phase: this.phase,
      appVersion: numericVersion(this.options.appVersion) ?? 'unknown',
    };
    try {
      writeFileSync(this.markerPath, `${JSON.stringify(marker)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      ensurePrivateFile(this.markerPath);
    } catch {
      // Incident reporting cannot affect TUI startup or phase transitions.
    }
  }

  private uploadEnabled(): boolean {
    return isTelemetryChannelEnabled('diagnostics', this.options.readTelemetryEnabled);
  }

  private prune(): void {
    const nowMs = this.nowMs();
    const incidentFiles = safeReadDirectory(this.directory)
      .filter((entry) => /^(?:pending|sent|local)-.*\.json$/u.test(entry))
      .flatMap((entry) => {
        const path = join(this.directory, entry);
        try {
          return [{ path, modifiedAtMs: statSync(path).mtimeMs }];
        } catch {
          return [];
        }
      })
      .sort((left, right) => left.modifiedAtMs - right.modifiedAtMs);
    for (const file of incidentFiles) {
      try {
        if (JSON.parse(readFileSync(file.path, 'utf8')).schemaVersion !== INCIDENT_SCHEMA_VERSION) {
          safeRemove(file.path);
        }
      } catch {
        safeRemove(file.path);
      }
      if (nowMs - file.modifiedAtMs > RETENTION_MS) safeRemove(file.path);
    }
    const retained = incidentFiles.filter((file) => nowMs - file.modifiedAtMs <= RETENTION_MS);
    const deletionOrder = [
      ...retained.filter((file) => basename(file.path).startsWith('local-')),
      ...retained.filter((file) => basename(file.path).startsWith('sent-')),
      ...retained.filter((file) => basename(file.path).startsWith('pending-')),
    ];
    for (const file of deletionOrder.slice(0, Math.max(0, retained.length - MAX_INCIDENT_FILES))) {
      safeRemove(file.path);
    }
  }
}

// Explicit finite vocabularies, not character-pattern redaction. Unknown labels
// never become diagnostic text. Keep this projection shared with disk replay.
const EVENT_TYPES = [
  'cli_process_error',
  'cli_startup_error',
  'cli_render_error',
  'cli_interaction_error',
  'cli_runtime_bridge_error',
  'cli_terminal_error',
  'cli_persistence_error',
  'cli_shutdown_error',
  'cli_unclean_exit',
] as const;
const PHASES = ['startup', 'runtime', 'shutdown'] as const;
const SEVERITIES = ['fatal', 'error', 'warning'] as const;
const IMPACTS = ['exit', 'screen_unavailable', 'action_failed', 'degraded'] as const;
const ERROR_NAMES = [
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'URIError',
  'EvalError',
  'AggregateError',
  'AbortError',
] as const;
const ERROR_CODES = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ENOENT',
  'EACCES',
  'EPERM',
  'ENOSPC',
  'ABORT_ERR',
] as const;
const BREADCRUMB_NAMES = [
  'cli.run.started',
  'cli.phase.changed',
  'cli.runtime.events.reconnected',
  'cli.runtime.events.connected',
  'cli.runtime.events.disconnected',
  'cli.runtime.initialize.started',
  'cli.runtime.initialize.succeeded',
  'cli.auth.context.changed',
  'cli.first-frame.rendered',
  'cli.shutdown.started',
] as const;

function allowedString<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && allowed.includes(value as T) ? (value as T) : undefined;
}

function ownValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  // Do not invoke error getters, toJSON or string coercion while collecting diagnostics.
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function snapshotError(value: unknown): TuiIncidentErrorSnapshot {
  const name =
    allowedString(ownValue(value, 'name'), ERROR_NAMES) ??
    ([AggregateError, TypeError, RangeError, SyntaxError, ReferenceError, URIError, EvalError, Error]
      .find((constructor) => value instanceof constructor)?.name ?? 'unknown');
  const code = allowedString(ownValue(value, 'code'), ERROR_CODES);
  const status = ownValue(value, 'status') ?? ownValue(value, 'statusCode');
  return {
    name,
    ...(code ? { code } : {}),
    ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
      ? { status }
      : {}),
  };
}

function numericVersion(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/u.test(value)
    ? value
    : undefined;
}

function incidentFingerprint(eventType: string, error: TuiIncidentErrorSnapshot): string {
  return createHash('sha256')
    .update(JSON.stringify([eventType, error]))
    .digest('hex')
    .slice(0, 24);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function uuid(value: unknown): string | undefined {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
    ? value
    : undefined;
}

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function minimizeEventLog(value: unknown, eventType: string): string {
  const log = record(value);
  const context = record(log.context);
  const error = snapshotError(log.error);
  // An already minimized unknown thrown value stays unknown after disk replay.
  const breadcrumbs = (Array.isArray(log.breadcrumbs) ? log.breadcrumbs : [])
    .slice(-MAX_BREADCRUMBS)
    .flatMap((value) => {
      const crumb = record(value);
      const name = allowedString(crumb.name, BREADCRUMB_NAMES);
      const phase = allowedString(record(crumb.details).phase, PHASES);
      return name && timestamp(crumb.occurredAtMs)
        ? [
            {
              name,
              occurredAtMs: crumb.occurredAtMs,
              ...(phase ? { details: { phase } } : {}),
            },
          ]
        : [];
    });
  return JSON.stringify({
    schemaVersion: INCIDENT_SCHEMA_VERSION,
    incidentId: uuid(log.incidentId),
    runId: uuid(log.runId),
    source: 'cli',
    phase: allowedString(log.phase, PHASES) ?? 'runtime',
    severity: allowedString(log.severity, SEVERITIES) ?? 'error',
    impact: allowedString(log.impact, IMPACTS) ?? 'action_failed',
    handled: typeof log.handled === 'boolean' ? log.handled : true,
    fingerprint: incidentFingerprint(eventType, error),
    error,
    context: {
      appVersion: numericVersion(context.appVersion),
      platform: allowedString(context.platform, [
        'darwin',
        'linux',
        'win32',
        'freebsd',
        'openbsd',
        'aix',
        'sunos',
      ]),
      arch: allowedString(context.arch, [
        'arm64',
        'x64',
        'arm',
        'ia32',
        'riscv64',
        'ppc64',
        's390x',
      ]),
      nodeVersion: numericVersion(context.nodeVersion),
    },
    breadcrumbs,
  });
}

function encryptEventLog(
  plaintext: string,
  token: string,
  userId: string,
  event: Pick<TuiStoredIncident, 'eventType' | 'occurredAtMs'>,
): string {
  const key = Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(token, 'utf8'),
      Buffer.from(EVENT_LOG_HKDF_SALT, 'utf8'),
      Buffer.from(userId, 'utf8'),
      32,
    ),
  );
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(
    Buffer.from(
      JSON.stringify({ event_type: event.eventType, occurred_at_ms: event.occurredAtMs }),
      'utf8',
    ),
  );
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const payload = Buffer.concat([ciphertext, cipher.getAuthTag()]);
  return `${EVENT_LOG_WIRE_VERSION}.${nonce.toString('base64url')}.${payload.toString('base64url')}`;
}

function readStoredIncidents(
  directory: string,
): Array<{ readonly path: string; readonly incident: TuiStoredIncident }> {
  return safeReadDirectory(directory)
    .filter((entry) => entry.startsWith('pending-') && entry.endsWith('.json'))
    .sort()
    .flatMap((entry) => {
      const path = join(directory, entry);
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<TuiStoredIncident>;
        const eventType = allowedString(parsed.eventType, EVENT_TYPES);
        if (
          parsed.schemaVersion !== INCIDENT_SCHEMA_VERSION ||
          !uuid(parsed.incidentId) ||
          !eventType ||
          !timestamp(parsed.occurredAtMs) ||
          typeof parsed.eventLog !== 'string'
        ) {
          safeRemove(path);
          return [];
        }
        // Never trust the schema tag alone. Re-project both the encrypted payload
        // and plaintext envelope immediately before any network request.
        const incident: TuiStoredIncident = {
          schemaVersion: INCIDENT_SCHEMA_VERSION,
          incidentId: parsed.incidentId!,
          eventType,
          occurredAtMs: parsed.occurredAtMs,
          codeLocation: `tui.${eventType}`,
          eventLog: minimizeEventLog(JSON.parse(parsed.eventLog), eventType),
        };
        writeJsonAtomically(directory, path, incident);
        return [{ path, incident }];
      } catch {
        return [];
      }
    });
}

function readRunMarker(path: string): TuiRunMarker | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<TuiRunMarker>;
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.runId !== 'string' ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.startedAtMs !== 'number' ||
      typeof parsed.updatedAtMs !== 'number' ||
      (parsed.phase !== 'startup' && parsed.phase !== 'runtime' && parsed.phase !== 'shutdown') ||
      typeof parsed.appVersion !== 'string'
    ) {
      return undefined;
    }
    return parsed as TuiRunMarker;
  } catch {
    return undefined;
  }
}

function writeJsonAtomically(directory: string, target: string, value: unknown): void {
  const temporaryPath = join(directory, `.incident-${process.pid}-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    renameSync(temporaryPath, target);
    ensurePrivateFile(target);
  } catch (error) {
    safeRemove(temporaryPath);
    throw error;
  }
}

function markIncidentSent(path: string): void {
  const target = join(dirname(path), basename(path).replace(/^pending-/u, 'sent-'));
  try {
    renameSync(path, target);
    ensurePrivateFile(target);
  } catch {
    // Keeping the pending file is safe; the next launch may retry it.
  }
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    // Windows may not apply POSIX permission bits.
  }
}

function ensurePrivateFile(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows may not apply POSIX permission bits.
  }
}

function safeReadDirectory(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function safeRemove(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Best-effort retention and state cleanup.
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
