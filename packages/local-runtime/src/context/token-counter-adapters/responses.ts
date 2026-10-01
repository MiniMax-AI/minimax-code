import { logger } from '../../common/logger.js';
import {
  buildResponsesInputTokensRequestBody,
  responsesInputTokensBodyHasImages,
  responsesInputTokensBodyHasVideo,
} from '../responses-input-tokens-body.js';
import {
  type RemoteTokenCountContext,
  type RemoteTokenCounterAdapter,
  type RemoteTokenCounterHttpRequest,
} from './types.js';
import { isManagedLoginTokenPlan } from './managed-login.js';
import { parseTopLevelInputTokens } from './parse.js';

export const minimaxResponsesTokenCounterAdapter: RemoteTokenCounterAdapter = {
  id: 'minimax-responses',
  counterKind: 'responses',
  matches: (ctx) => ctx.model.provider === 'minimax_api',
  buildRequest: (ctx) => buildResponsesCounterRequest(ctx, true),
  parseTokens: parseTopLevelInputTokens,
};

export const genericResponsesTokenCounterAdapter: RemoteTokenCounterAdapter = {
  id: 'generic-responses',
  counterKind: 'responses',
  matches: (ctx) => {
    if (ctx.model.api !== 'openai-completions' && ctx.model.api !== 'openai-responses') {
      return false;
    }
    return !isManagedLoginTokenPlan(ctx);
  },
  buildRequest: (ctx) => buildResponsesCounterRequest(ctx, false),
  parseTokens: parseTopLevelInputTokens,
};

function buildResponsesCounterRequest(
  ctx: RemoteTokenCountContext,
  isMinimaxApi: boolean,
): RemoteTokenCounterHttpRequest | undefined {
  const body = buildResponsesInputTokensRequestBody(
    ctx.messages,
    ctx.systemPrompt,
    ctx.model,
    ctx.tools,
  );
  if (isMinimaxApi && responsesInputTokensBodyHasVideo(body)) {
    logger.info(
      { model: ctx.model.id, provider: ctx.model.provider },
      '[local-remote-token-counter] MiniMax Responses input_tokens does not accept video; using BPE fallback',
    );
    return undefined;
  }

  const apiKey = ctx.apiKey ?? '';
  const baseUrl = ctx.model.baseUrl;
  return {
    url: buildResponsesInputTokensUrl(baseUrl, {
      stripMessagesCompatibilityPrefix: isMinimaxApi,
    }),
    unsupportedCacheKey: `responses:${baseUrl}`,
    body,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(ctx.headers ?? {}),
      'Content-Type': 'application/json',
    },
    hasImages: responsesInputTokensBodyHasImages(body),
  };
}

export function buildResponsesInputTokensUrl(
  baseUrl: string,
  options: { stripMessagesCompatibilityPrefix?: boolean } = {},
): string {
  const trimmed = baseUrl.trim().replace(/\/+$/u, '');
  if (!trimmed) return '/v1/responses/input_tokens';
  try {
    const url = new URL(trimmed);
    const currentPath = url.pathname.replace(/\/+$/u, '');
    let rootPath = currentPath;
    if (rootPath.endsWith('/responses/input_tokens')) {
      url.search = '';
      url.hash = '';
      return url.toString();
    }
    if (rootPath.endsWith('/chat/completions')) {
      rootPath = rootPath.slice(0, -'/chat/completions'.length);
    } else if (rootPath.endsWith('/responses')) {
      rootPath = rootPath.slice(0, -'/responses'.length);
    }
    if (options.stripMessagesCompatibilityPrefix) {
      rootPath = stripMessagesCompatibilityPrefix(rootPath);
    }
    if (!endsWithVersionSegment(rootPath)) {
      rootPath = `${rootPath}/v1`;
    }
    url.pathname = `${rootPath}/responses/input_tokens`.replace(/\/{2,}/gu, '/');
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    let root = trimmed;
    if (root.endsWith('/responses/input_tokens')) return root;
    if (root.endsWith('/chat/completions')) {
      root = root.slice(0, -'/chat/completions'.length);
    } else if (root.endsWith('/responses')) {
      root = root.slice(0, -'/responses'.length);
    }
    if (options.stripMessagesCompatibilityPrefix) {
      root = stripMessagesCompatibilityPrefix(root);
    }
    if (!endsWithVersionSegment(root)) root = `${root}/v1`;
    return `${root}/responses/input_tokens`;
  }
}

/**
 * Base URLs of OpenAI-compatible gateways are often already versioned
 * (`/v1`, but also `/api/paas/v4`, `/api/coding/paas/v4`, ...). Appending
 * `/v1` after an existing version segment can only produce a path that no
 * gateway serves, so treat any trailing `/v<digits>` as the API root.
 */
function endsWithVersionSegment(root: string): boolean {
  return /\/v\d+$/u.test(root);
}

function stripMessagesCompatibilityPrefix(root: string): string {
  return root.replace(/\/anthropic(?=\/v1$|$)/u, '');
}
