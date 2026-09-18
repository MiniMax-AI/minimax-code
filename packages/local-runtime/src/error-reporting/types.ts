/**
 * Public types and tunable options for desktop error-log reporting.
 *
 * Provides generic error reporting for local-runtime. Physical LLM provider request failures are
 * the first consumer, but event types are unrestricted so other subsystems can reuse the pipeline.
 *
 * Constraints (technical design "MCode desktop error-log batch reporting"):
 * - Must stay in packages/local-runtime; do not move to packages/shared or depend on apps/electron.
 * - Memory only: no disk, SQLite, outbox, or dataDir cache.
 * - Reporting failures must not affect LLM requests, automatic retries, or turn results.
 * - `event_log` must be minimized before buffering; encryption is an additional transport layer.
 *   Use AES-256-GCM (see ./crypto.ts).
 */

import type { LocalRuntimeAuthContext } from '../runtime/model-resolver.js';
import type { LocalRuntimeRoutingContext } from '../runtime/routing-headers.js';
import type { MavisBuildEnv, MavisRegion } from '@mavis/config';

/**
 * One caller-generated error event buffered in memory.
 *
 * `report()` replaces input with allowlisted diagnostic facts before buffering. Encrypt only at
 * send time, before writing the HTTP body, so the current login token used for key derivation
 * matches the batch's authentication token.
 */
export interface DesktopErrorLog {
  /** Error category, e.g. `'llm_request_failure'`; keep cardinality low. */
  event_type: string;
  /**
   * In memory: minimized diagnostic facts (no messages, stacks, headers or prompts).
   * In the HTTP body: encrypted `v1.<nonce>.<ciphertext+tag>` string.
   */
  event_log: string;
  /** Error occurrence time as a Unix timestamp in milliseconds. */
  occurred_at_ms: number;
  /**
   * Event location as file path + function name. Deliberately omit line numbers to avoid changes
   * from unrelated edits, e.g.
   * `packages/agent-core/src/pi-turn-runner/metrics.ts#recordLLMSettled`.
   */
  code_location: string;
}

/**
 * Public reporting interface. Callers only provide a complete {@link DesktopErrorLog}; batching,
 * encryption, authentication, and transport are internal.
 */
export interface DesktopErrorReporter {
  /**
   * Enqueue an event without requiring callers to wait or handle exceptions. Drop oversized events
   * immediately; reaching the batch threshold triggers asynchronous sending.
   */
  report(event: DesktopErrorLog): void;
  /**
   * Flush the current buffer immediately. Return after inflight sending completes or is dropped;
   * safe during shutdown and never rejects.
   */
  flush(): Promise<void>;
  /**
   * Stop internal timers and attempt one final flush for graceful process shutdown; never rejects.
   */
  close(): Promise<void>;
}

/**
 * Behavior options. Each field has a design-specified default (see {@link
 * DESKTOP_ERROR_REPORTING_DEFAULTS}); tests may override them for deterministic results.
 */
export interface DesktopErrorReporterOptions {
  /** Explicit `telemetry.diagnostics` opt-in; environment opt-outs always take precedence. */
  readTelemetryEnabled?: () => boolean | undefined;
  /** Read live login state (token and real user ID) for each send. */
  authContextGetter?: () => LocalRuntimeAuthContext | undefined;
  /** Managed-backend routing headers, consistent with other cloud calls. */
  routingContextGetter?: () => LocalRuntimeRoutingContext | undefined;
  /** Injectable fetch, defaulting to global `fetch`; read lazily so tests can replace it. */
  fetchImpl?: typeof fetch;
  /** Region selector for the endpoint host; defaults to `getRuntimeRegion`. */
  region?: () => MavisRegion;
  /** Build-environment selector for the endpoint host; defaults to `getRuntimeBuildEnv`. */
  buildEnv?: () => MavisBuildEnv;
  /** Injectable clock; defaults to `Date.now`. */
  nowMs?: () => number;
  /** Send when the buffer reaches this count; see {@link DESKTOP_ERROR_REPORTING_DEFAULTS.batchSize} for the default. */
  batchSize?: number;
  /** Idle timer for sending partial batches; defaults to 5000 ms. */
  flushIntervalMs?: number;
  /** Hard buffer event limit; drop oldest events on overflow. Defaults to 200. */
  maxBufferEvents?: number;
  /** Maximum events per request; take at most this many per send. Defaults to 50. */
  maxBatchEvents?: number;
}

/** Design-specified defaults for {@link DesktopErrorReporterOptions}. */
export const DESKTOP_ERROR_REPORTING_DEFAULTS = {
  batchSize: 20,
  flushIntervalMs: 5_000,
  maxBufferEvents: 200,
  maxBatchEvents: 50,
} as const;

/**
 * Maximum raw event_log size: 16 KiB. Drop larger events entirely rather than truncating, bounding
 * memory/request size and avoiding incomplete, potentially misleading logs.
 */
export const MAX_EVENT_LOG_BYTES = 16 * 1024;
