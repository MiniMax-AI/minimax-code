import type { IAgentConfig } from '@mavis/protocol';
import { withMiniMaxCodeUserAgent } from '@mavis/shared';
import {
  managedBackendRoutingHeaders,
  type ManagedBackendRoutingContext,
} from '@mavis/agent-tools/desktop';
import type { MavisBuildEnv, ModelAvailabilityConfigView, ModelCallRoute } from '@mavis/config';
import type { LLMModelConfig } from '@mavis/agent-core/pi-turn-runner';

import type { LocalRuntimeAuthContext } from '../../../infra/config/auth-context.js';
import type { LocalByokProviderConfig, LocalModelsConfig } from '../contracts.js';

const MANAGED_PROVIDER_USER_AGENT = 'MiniMaxAgent';
/** 托管模型请求所属的本地 turn id，网关写进诊断和审核记录。 */
const TURN_ID_HEADER = 'X-Mavis-Turn-Id';

/**
 * Turn phase of each model request (initial, iteration, compaction), read by
 * biz-gateway. Only managed Token Plan requests carry it: BYOK and third-party
 * upstreams never see it.
 */
const TURN_PHASE_HEADER = 'X-Mavis-Turn-Phase';

export function turnPhaseHeaderFor(route: ModelCallRoute): { readonly turnPhaseHeader?: string } {
  return route === 'managed_token_plan' ? { turnPhaseHeader: TURN_PHASE_HEADER } : {};
}

export function buildLocalProviderHeaders(input: {
  readonly headers?: Record<string, string>;
  readonly managedProvider: boolean;
  readonly routingContext?: ManagedBackendRoutingContext;
  readonly sessionId: string;
  /** 发起这次模型解析的 turn；只带给托管模型。 */
  readonly turnId?: string;
  readonly agentId: string;
}): Record<string, string> {
  // Third-party providers see MiniMax Code instead of the SDK default unless the
  // user configured a User-Agent; managed routes keep their own identity below.
  const headers: Record<string, string> = {
    ...(input.managedProvider ? input.headers : withMiniMaxCodeUserAgent(input.headers)),
    'X-Mavis-Session-Id': input.sessionId,
    'X-Mavis-Agent-Id': input.agentId,
    'X-Mavis-Timezone-Offset': String(new Date().getTimezoneOffset() * -60),
  };
  for (const key of Object.keys(headers)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === 'bedrock-lane' || normalizedKey === 'bedrock_lane') delete headers[key];
  }
  if (input.managedProvider) {
    headers['User-Agent'] = MANAGED_PROVIDER_USER_AGENT;
    Object.assign(headers, managedBackendRoutingHeaders(input.routingContext, currentBuildEnv()));
    if (input.turnId?.trim()) headers[TURN_ID_HEADER] = input.turnId;
  }
  return headers;
}

/** The part of the effective config `resolveModelCallRoute` reads. */
export function modelCallRouteView(
  providerConfig: LocalModelsConfig | undefined,
  byok: LocalByokProviderConfig | undefined,
): ModelAvailabilityConfigView {
  return {
    ...(providerConfig ? { provider: providerConfig } : {}),
    ...(byok?.minimaxModelSource ? { minimaxModelSource: byok.minimaxModelSource } : {}),
  };
}

function currentBuildEnv(): MavisBuildEnv | undefined {
  const value = process.env.MAVIS_BUILD_ENV;
  return value === 'dev' || value === 'test' || value === 'staging' || value === 'prod'
    ? value
    : undefined;
}

export function readAgentHeaderId(agentConfig: IAgentConfig): string {
  const id = agentConfig.agent_id;
  if (typeof id === 'string' && id.trim()) return id.trim();
  return typeof id === 'number' && Number.isFinite(id) ? String(id) : 'main';
}

export function stripUrlCredentials(value: string): string {
  try {
    const parsed = new URL(value);
    if (!parsed.username && !parsed.password) return value;
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return value;
  }
}

export function createManagedAuthRetryFetch(input: {
  readonly authContext: LocalRuntimeAuthContext | undefined;
  readonly fetchImpl?: LLMModelConfig['fetch'];
  readonly authContextGetter?: () => LocalRuntimeAuthContext | undefined;
  readonly authContextInvalidator?: (
    rejectedAccessToken?: string,
    loginEpoch?: string,
  ) => void | Promise<void>;
}): LLMModelConfig['fetch'] | undefined {
  const { fetchImpl, authContextGetter, authContextInvalidator } = input;
  // A resolved model is reused across LLM steps; bind the login, not its expiring token.
  const loginEpoch = input.authContext?.loginEpoch;
  if (!authContextGetter || !loginEpoch) return fetchImpl;
  const managedFetch = fetchImpl ?? fetch;
  const recoverToken = async (rejectedToken: string, signal?: AbortSignal | null) => {
    if (!authContextInvalidator) return undefined;
    signal?.throwIfAborted();
    await authContextInvalidator(rejectedToken, loginEpoch);
    signal?.throwIfAborted();
    const token = tokenForLogin(authContextGetter(), loginEpoch);
    return token === rejectedToken ? undefined : token;
  };
  return async (request, init) => {
    const signal = requestSignal(request, init);
    signal?.throwIfAborted();
    const retryRequest = request instanceof Request ? request.clone() : request;
    const headers = mergedRequestHeaders(request, init);
    const currentAuth = authContextGetter();
    if (hasLoginChanged(currentAuth, loginEpoch)) {
      return Response.json(
        { error: { type: 'authentication_error', message: 'Authentication session changed.' } },
        { status: 401 },
      );
    }
    const currentToken = tokenForLogin(currentAuth, loginEpoch);
    if (currentToken) {
      headers.set('Authorization', `Bearer ${currentToken}`);
    }
    const requestInit = { ...init, headers };
    const rejectedToken = bearerToken(request, requestInit);
    const response = await managedFetch(request, requestInit);
    if (response.status !== 401 || !rejectedToken) return response;

    const freshToken = await recoverToken(rejectedToken, signal);
    if (!freshToken) return response;

    await discardResponseBody(response);
    signal?.throwIfAborted();
    const retryToken = tokenForLogin(authContextGetter(), loginEpoch, freshToken);
    if (!retryToken || retryToken === rejectedToken) {
      return response;
    }
    headers.set('Authorization', `Bearer ${retryToken}`);
    return managedFetch(retryRequest, { ...init, headers });
  };
}

function hasLoginChanged(auth: LocalRuntimeAuthContext | undefined, loginEpoch: string): boolean {
  return (
    auth?.authState === 'logged_out' || Boolean(auth?.loginEpoch && auth.loginEpoch !== loginEpoch)
  );
}

function tokenForLogin(
  auth: LocalRuntimeAuthContext | undefined,
  loginEpoch: string,
  recoveredToken?: string,
): string | undefined {
  if (hasLoginChanged(auth, loginEpoch)) return undefined;
  // A pending projection carries no credentials; retain the token just recovered for this login.
  if (auth?.authState === 'pending') return recoveredToken;
  if (auth?.loginEpoch !== loginEpoch) return undefined;
  return auth.accessToken?.trim();
}

function requestSignal(
  request: Parameters<typeof fetch>[0],
  init?: RequestInit,
): AbortSignal | null | undefined {
  if (init?.signal !== undefined) return init.signal;
  return request instanceof Request ? request.signal : undefined;
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // Some synthetic transports expose an unreadable body; retry does not depend on it.
  }
}

function bearerToken(request: Parameters<typeof fetch>[0], init?: RequestInit): string | undefined {
  const authorization = mergedRequestHeaders(request, init).get('Authorization')?.trim();
  const match = authorization?.match(/^Bearer\s+(.+)$/iu);
  return match?.[1]?.trim();
}

function mergedRequestHeaders(request: Parameters<typeof fetch>[0], init?: RequestInit): Headers {
  const headers = new Headers(request instanceof Request ? request.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  return headers;
}
