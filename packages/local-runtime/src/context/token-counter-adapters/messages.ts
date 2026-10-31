import {
  buildCountTokensRequestBody,
  countTokensBodyHasImages,
  type CountTokensRequestBody,
} from '../count-tokens-body.js';
import { buildMessagesCountTokensRequestBodyFromProviderPayload } from '../messages-count-tokens-payload.js';
import { isMessagesOAuthToken } from '../messages-count-tokens-wire.js';
import {
  type RemoteTokenCounterAdapter,
  type RemoteTokenCounterHttpRequest,
  type RemoteTokenCountContext,
} from './types.js';
import { parseTopLevelInputTokens } from './parse.js';

export const messagesTokenCounterAdapter: RemoteTokenCounterAdapter = {
  id: 'anthropic-messages',
  counterKind: 'messages',
  matches: (ctx) => ctx.model.api === 'anthropic-messages',
  buildRequest: buildMessagesCounterRequest,
  parseTokens: parseTopLevelInputTokens,
};

function buildMessagesCounterRequest(
  ctx: RemoteTokenCountContext,
): RemoteTokenCounterHttpRequest | undefined {
  const apiKey = ctx.apiKey ?? '';
  const preparedProviderPayload = ctx.preparedPayload ?? ctx.exactProviderPayload;
  const preparedBody =
    buildMessagesCountTokensRequestBodyFromProviderPayload(preparedProviderPayload);
  // A caller that supplies a prepared payload is asking the counter to consume
  // that payload read-only. If it is not count-compatible, fail soft instead
  // of reconstructing an inline-media body from logical messages.
  if (preparedProviderPayload !== undefined && !preparedBody) {
    return undefined;
  }
  const body = preparedBody ?? buildReconstructedBody(ctx, apiKey);
  const baseUrl = ctx.model.baseUrl;
  // OAuth token-count requests use Bearer plus the app marker, while ordinary
  // API keys use x-api-key. Configured headers are merged last so callers
  // retain the existing override behavior.
  const authHeaders: Record<string, string> = isMessagesOAuthToken(apiKey)
    ? {
        authorization: `Bearer ${apiKey}`,
        'x-app': 'cli',
      }
    : { 'x-api-key': apiKey };

  return {
    url: `${baseUrl}/v1/messages/count_tokens`,
    body,
    headers: {
      ...authHeaders,
      ...(ctx.headers ?? {}),
      'Content-Type': 'application/json',
    },
    hasImages: countTokensBodyHasImages(body),
  };
}

function buildReconstructedBody(
  ctx: RemoteTokenCountContext,
  apiKey: string,
): CountTokensRequestBody {
  const builtBody = buildCountTokensRequestBody(
    ctx.messages,
    ctx.systemPrompt,
    ctx.model,
    ctx.tools,
    {
      apiKey,
      maxTokens: ctx.maxTokens,
      cacheRetention: ctx.cacheRetention,
      thinkingLevel: ctx.thinkingLevel,
    },
  );
  return builtBody;
}
