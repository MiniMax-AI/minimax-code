/**
 * Desktop error reporter: Compose the batcher, encryption, and Gateway client into the public
 * {@link DesktopErrorReporter} interface.
 *
 * Flow:
 *   report(rawEvent)
 *     → Check size, minimize diagnostic fields, buffer sanitized events [batcher]
 *     → Take a batch when the threshold or idle timer fires [batcher]
 *       → Read live login state (token + user_id) [authContext]
 *       → Encrypt each event_log with that token [crypto]
 *       → POST the encrypted batch [matrix-api-client]
 *
 * Encrypt at send time rather than enqueue time: the token authenticating the batch also derives
 * its event_log keys, avoiding mismatches when tokens refresh between batches. Absorb failures at
 * every stage; never expose them to callers or affect LLM requests, retries, or turn results.
 */

import { getRuntimeBuildEnv, getRuntimeRegion, isTelemetryChannelEnabled } from '@mavis/config';
import { LLM_ERROR_REASONS } from '@mavis/shared/llm-error-classifier';

import { logger } from '../common/logger.js';

import { DesktopErrorBatcher } from './batcher.js';
import { encryptEventLog } from './crypto.js';
import { sendDesktopErrorBatch } from './matrix-api-client.js';
import { errorDataField, snapshotErrorValue } from './error-snapshot.js';
import {
  MAX_EVENT_LOG_BYTES,
  type DesktopErrorLog,
  type DesktopErrorReporter,
  type DesktopErrorReporterOptions,
} from './types.js';

/** Time limit for the final graceful-shutdown flush (design §3; best effort within 300 ms). */
const CLOSE_FLUSH_TIMEOUT_MS = 300;

/**
 * Create a usable {@link DesktopErrorReporter}. Callers retain it for the process lifetime and call
 * `report(...)` once per event.
 */
export function createDesktopErrorReporter(
  options: DesktopErrorReporterOptions,
): DesktopErrorReporter {
  const nowMs = options.nowMs ?? Date.now;

  // The batcher owns buffering and scheduling; this callback owns authentication, encryption, and sending.
  const batcher = new DesktopErrorBatcher({
    ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
    ...(options.flushIntervalMs !== undefined ? { flushIntervalMs: options.flushIntervalMs } : {}),
    ...(options.maxBufferEvents !== undefined ? { maxBufferEvents: options.maxBufferEvents } : {}),
    ...(options.maxBatchEvents !== undefined ? { maxBatchEvents: options.maxBatchEvents } : {}),
    onFlush: async (events) => {
      await encryptAndSend(events).catch((error) => {
        // Defensive guard: encryptAndSend already absorbs exceptions; catch again to prevent unhandled rejections.
        logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          '[error-reporting] desktop error flush failed',
        );
      });
    },
  });

  /** Read login state, encrypt each event_log, and POST the batch without letting failures affect the main flow. */
  async function encryptAndSend(events: DesktopErrorLog[]): Promise<void> {
    if (!isTelemetryChannelEnabled('diagnostics', options.readTelemetryEnabled)) return;
    const authContext = options.authContextGetter?.();
    const token = authContext?.accessToken?.trim();
    const userId = authContext?.realUserID?.trim();
    // Incomplete login state prevents both encryption and authentication; drop the batch per design §4.1.
    // Do not requeue it, avoiding mixing it with key material from the next login.
    if (!token || !userId) return;

    // Encrypt logs individually and catch per-event errors so one bad event cannot discard an otherwise valid batch.
    const encrypted: DesktopErrorLog[] = [];
    for (const event of events) {
      try {
        encrypted.push({
          ...event,
          event_log: encryptEventLog(event.event_log, {
            token,
            userId,
            event,
          }),
        });
      } catch (error) {
        logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          '[error-reporting] failed to encrypt desktop error event; skipping it',
        );
      }
    }
    if (encrypted.length === 0) return;

    await sendDesktopErrorBatch({
      events: encrypted,
      authContext,
      routingContext: options.routingContextGetter?.(),
      fetchImpl: options.fetchImpl ?? fetch,
      region: options.region ?? getRuntimeRegion,
      buildEnv: options.buildEnv ?? getRuntimeBuildEnv,
    });
  }

  return {
    report(event: DesktopErrorLog): void {
      try {
        if (!isTelemetryChannelEnabled('diagnostics', options.readTelemetryEnabled)) return;
        // Drop oversized raw logs entirely, never truncate (design §2). Measure plaintext size to bound both
        // memory usage and the final request body.
        const byteLength = Buffer.byteLength(event.event_log, 'utf8');
        if (byteLength > MAX_EVENT_LOG_BYTES) {
          logger.warn(
            {
              byteLength,
              maxBytes: MAX_EVENT_LOG_BYTES,
              eventType: event.event_type,
            },
            '[error-reporting] dropped oversized desktop error event_log',
          );
          return;
        }
        // The upload boundary enforces the policy even for callers bypassing formatErrorLog.
        if (event.event_type !== 'llm_request_failure') return;
        let input: unknown;
        try {
          input = JSON.parse(event.event_log);
        } catch {
          input = undefined;
        }
        batcher.add({
          event_type: 'llm_request_failure',
          event_log: formatErrorLog(input),
          occurred_at_ms:
            Number.isSafeInteger(event.occurred_at_ms) && event.occurred_at_ms >= 0
              ? event.occurred_at_ms
              : nowMs(),
          code_location: 'packages/agent-core/src/pi-turn-runner/metrics.ts#recordLLMSettled',
        });
      } catch (error) {
        // report() must not throw back into its caller, the LLM failure-handling path.
        logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          '[error-reporting] failed to enqueue desktop error event',
        );
      }
    },

    async flush(): Promise<void> {
      try {
        await batcher.flush();
      } catch (error) {
        logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          '[error-reporting] desktop error reporter flush failed',
        );
      }
    },

    async close(): Promise<void> {
      try {
        batcher.stop();
        // Try to flush the entire buffer within a time limit so slow requests cannot stall shutdown.
        const deadline = nowMs() + CLOSE_FLUSH_TIMEOUT_MS;
        await Promise.race([
          Promise.resolve(batcher.flush()),
          new Promise<void>((resolve) => {
            const timeout = setTimeout(resolve, Math.max(0, deadline - nowMs()));
            timeout.unref?.();
          }),
        ]);
      } catch (error) {
        logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          '[error-reporting] desktop error reporter close failed',
        );
      }
    },
  };
}

/** Build a bounded allowlist of diagnostics before buffering or encryption.
 * Free text and provider request metadata are deliberately excluded: even a valid model
 * name, URL, message or stack can embed prompts, credentials or local paths.
 */
export function formatErrorLog(input: unknown): string {
  const log: Record<string, unknown> = { schemaVersion: 3 };
  const version = errorDataField(input, 'appVersion');
  if (typeof version === 'string' && /^\d{1,5}\.\d{1,5}\.\d{1,5}$/u.test(version)) {
    log.appVersion = version;
  }
  const kind = errorDataField(input, 'metricKind');
  if (typeof kind === 'string' && LLM_ERROR_REASONS.some((reason) => reason === kind)) {
    log.metricKind = kind;
  }
  for (const key of ['error', 'providerError'] as const) {
    const error = errorDataField(input, key);
    if (error !== undefined) log[key] = snapshotErrorValue(error);
  }
  return JSON.stringify(log);
}
