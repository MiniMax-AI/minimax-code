import {
  getRuntimeBuildEnv,
  getRuntimeRegion,
  type MavisBuildEnv,
  type MavisRegion,
} from '@mavis/config';
import {
  GATEWAY_SAFETY_CHECK_V2_HTTP_ACTION,
  postSafetyCheckV2,
  SafetyCheckV2Error,
  type SafetyCheckV2Scene,
} from '@mavis/shared/safety-check-v2';

import type { LocalRuntimeAuthContext } from '../runtime/model-resolver.js';
import {
  managedBackendRoutingHeaders,
  type LocalRuntimeRoutingContext,
} from '../runtime/routing-headers.js';
import { createSafetyFailureReporter } from './diagnostics.js';
import { resolveSafetyApiBase } from './api-base.js';

/** biz-gateway uses V2 numeric scenes with its desktop HTTP envelope. */
export interface LocalSafetyCheckV2Request {
  scene: SafetyCheckV2Scene;
  content_text?: string;
  sessionId?: string;
  image_url?: string;
  /** Available to explicit callers; turn routing only sends text. */
  files?: Array<{ file_url: string; file_name?: string }>;
}

/** V2 action is the sole verdict, including in runtime consumers. */
export type LocalSafetyCheckV2Result =
  | { action: 'allow' }
  | { action: 'reject' }
  | { action: 'guide'; guidePrompt?: string }
  | { action: 'replace'; replacementText: string };

/** Typed HTTP boundary for local input and output V2 verdicts. */
export async function callLocalSafetyCheckV2(input: {
  request: LocalSafetyCheckV2Request;
  authContext?: LocalRuntimeAuthContext;
  routingContext?: LocalRuntimeRoutingContext;
  fetchImpl?: typeof fetch;
  region?: () => MavisRegion;
  buildEnv?: () => MavisBuildEnv;
  /** Honored only for loopback URLs in test builds, as with V1. */
  testBaseURL?: string;
  signal?: AbortSignal;
}): Promise<LocalSafetyCheckV2Result> {
  const buildEnv = (input.buildEnv ?? getRuntimeBuildEnv)();
  const region = (input.region ?? getRuntimeRegion)();
  const token = input.authContext?.accessToken?.trim() || process.env.MAVIS_ACCESS_TOKEN?.trim();
  const url = `${resolveSafetyApiBase(region, buildEnv, input.testBaseURL)}/mavis/api/v2/content?require_auth=true`;
  const reportFailure = createSafetyFailureReporter(url, 'v2', input.request.scene);
  try {
    const result = await postSafetyCheckV2({
      url,
      headers: {
        'User-Agent': 'MiniMaxAgent',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...managedBackendRoutingHeaders(
          input.routingContext,
          input.buildEnv ? buildEnv : undefined,
        ),
      },
      body: {
        scene: input.request.scene,
        ...(input.request.content_text !== undefined
          ? { content_text: input.request.content_text }
          : {}),
        ...(input.request.sessionId !== undefined ? { sessionId: input.request.sessionId } : {}),
        ...(input.request.image_url !== undefined ? { image_url: input.request.image_url } : {}),
        ...(input.request.files !== undefined ? { files: input.request.files } : {}),
      },
      fetchImpl: input.fetchImpl,
      signal: input.signal,
    });
    return parseLocalSafetyCheckV2Result(result);
  } catch (error) {
    reportFailure(
      error instanceof SafetyCheckV2Error
        ? {
            failureKind: error.kind,
            statusCode: error.statusCode,
            transportKind: error.transportKind,
          }
        : { failureKind: 'internal' },
    );
    throw error;
  }
}

function parseLocalSafetyCheckV2Result(body: Record<string, unknown>): LocalSafetyCheckV2Result {
  if (body.errorCode !== undefined) {
    if (typeof body.errorCode !== 'number' || !Number.isInteger(body.errorCode)) {
      throw new SafetyCheckV2Error('response');
    }
    if (body.errorCode !== 0 && body.errorCode !== 50201) {
      throw new SafetyCheckV2Error('upstream', body.errorCode);
    }
  }
  const action = body.action;
  if (
    action !== GATEWAY_SAFETY_CHECK_V2_HTTP_ACTION.Allow &&
    action !== GATEWAY_SAFETY_CHECK_V2_HTTP_ACTION.Block &&
    action !== GATEWAY_SAFETY_CHECK_V2_HTTP_ACTION.Replace &&
    action !== GATEWAY_SAFETY_CHECK_V2_HTTP_ACTION.Guide
  ) {
    throw new SafetyCheckV2Error('response');
  }
  const allow = action === GATEWAY_SAFETY_CHECK_V2_HTTP_ACTION.Allow;
  const expectedCode = allow ? 0 : 50201;
  if (body.errorCode !== expectedCode && !(allow && body.errorCode === undefined)) {
    throw new SafetyCheckV2Error('response');
  }
  if (allow) return { action: 'allow' };
  if (action === GATEWAY_SAFETY_CHECK_V2_HTTP_ACTION.Block) {
    return { action: 'reject' };
  }
  if (action === GATEWAY_SAFETY_CHECK_V2_HTTP_ACTION.Replace) {
    if (typeof body.suggestion !== 'string' || !body.suggestion.trim()) {
      throw new SafetyCheckV2Error('response');
    }
    return { action: 'replace', replacementText: body.suggestion };
  }
  if (Object.hasOwn(body, 'guide_prompt')) {
    if (typeof body.guide_prompt !== 'string') throw new SafetyCheckV2Error('response');
    // Guide without usable prompt text keeps the runner's existing SR fallback.
    return {
      action: 'guide',
      ...(body.guide_prompt.trim() ? { guidePrompt: body.guide_prompt } : {}),
    };
  }
  return { action: 'guide' };
}
