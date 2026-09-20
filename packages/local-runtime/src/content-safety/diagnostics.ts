import { randomUUID } from 'node:crypto';
import type { SafetyTransportKind } from '@mavis/shared/safety-check-v2';
import { logger } from '../common/logger.js';

/** One bounded record per failed check, in every build. Never log raw upstream data. */
export function createSafetyFailureReporter(url: string, apiVersion: 'v1' | 'v2', scene: number) {
  const startedAt = Date.now();
  const reviewId = randomUUID();
  const endpointHost = new URL(url).hostname;
  return (failure: {
    failureKind: 'transport' | 'auth' | 'http' | 'response' | 'upstream' | 'internal';
    transportKind?: SafetyTransportKind;
    statusCode?: number;
  }): void => {
    logger.warn(
      {
        reviewId,
        endpointHost,
        apiVersion,
        scene,
        durationMs: Date.now() - startedAt,
        ...failure,
      },
      '[content-safety] review failed',
    );
  };
}
