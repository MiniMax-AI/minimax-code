import type { Context, Model, Tool } from '@earendil-works/pi-ai';
import { convertMessages as convertOpenAICompletionsMessages } from '@earendil-works/pi-ai/openai-completions';

import { toProviderMessages } from '../messages-count-tokens-messages.js';
import { isManagedLoginTokenPlan } from './managed-login.js';
import { parseDataTotalTokens, parseUsageTotalTokens } from './parse.js';
import type {
  RemoteTokenCountContext,
  RemoteTokenCounterAdapter,
  RemoteTokenCounterHttpRequest,
} from './types.js';

const ZHIPU_HOSTS = new Set(['open.bigmodel.cn', 'api.z.ai']);
const KIMI_HOSTS = new Set(['api.moonshot.ai', 'api.moonshot.cn']);
const ZHIPU_PATHS = new Set([
  '/api/paas/v4',
  '/api/paas/v4/chat/completions',
  '/api/paas/v4/tokenizer',
]);
const KIMI_PATHS = new Set(['/v1', '/v1/chat/completions', '/v1/tokenizers/estimate-token-count']);

type OpenAICompletionsCompat = Parameters<typeof convertOpenAICompletionsMessages>[2];

// Mirrors Pi's resolved compat for the official Zhipu and Moonshot hosts.
// Pi exports the message converter but keeps its compat resolver private.
const BASE_CHAT_COMPAT: OpenAICompletionsCompat = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsUsageInStreaming: true,
  maxTokensField: 'max_tokens',
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  requiresThinkingAsText: false,
  requiresReasoningContentOnAssistantMessages: false,
  thinkingFormat: 'openai',
  openRouterRouting: {},
  vercelGatewayRouting: {},
  zaiToolStream: false,
  supportsStrictMode: false,
  cacheControlFormat: undefined,
  sendSessionAffinityHeaders: false,
  supportsLongCacheRetention: true,
};

const ZHIPU_CHAT_COMPAT: OpenAICompletionsCompat = {
  ...BASE_CHAT_COMPAT,
  maxTokensField: 'max_completion_tokens',
  thinkingFormat: 'zai',
  supportsStrictMode: true,
};

const KIMI_CHAT_COMPAT: OpenAICompletionsCompat = BASE_CHAT_COMPAT;

interface OpenAIChatTokenizerBody {
  model: string;
  messages: unknown[];
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: unknown;
      strict?: false;
    };
  }>;
}

export const zhipuTokenizerTokenCounterAdapter: RemoteTokenCounterAdapter = {
  id: 'zhipu-tokenizer',
  counterKind: 'openai-chat-tokenizer',
  matches: (ctx) => matchesOfficialOpenAIChatProvider(ctx, ZHIPU_HOSTS, ZHIPU_PATHS),
  buildRequest: (ctx) =>
    buildOpenAIChatTokenizerRequest(
      ctx,
      '/api/paas/v4/tokenizer',
      'zhipu-tokenizer',
      ZHIPU_CHAT_COMPAT,
    ),
  parseTokens: parseUsageTotalTokens,
};

export const kimiEstimateTokenCountAdapter: RemoteTokenCounterAdapter = {
  id: 'kimi-estimate-token-count',
  counterKind: 'openai-chat-tokenizer',
  matches: (ctx) => matchesOfficialOpenAIChatProvider(ctx, KIMI_HOSTS, KIMI_PATHS),
  buildRequest: (ctx) =>
    buildOpenAIChatTokenizerRequest(
      ctx,
      '/v1/tokenizers/estimate-token-count',
      'kimi-estimate-token-count',
      KIMI_CHAT_COMPAT,
    ),
  parseTokens: parseDataTotalTokens,
};

function matchesOfficialOpenAIChatProvider(
  ctx: RemoteTokenCountContext,
  allowedHosts: ReadonlySet<string>,
  allowedPaths: ReadonlySet<string>,
): boolean {
  if (ctx.model.api !== 'openai-completions' || isManagedLoginTokenPlan(ctx)) return false;
  const url = parseUrl(ctx.model.baseUrl);
  return url
    ? url.protocol === 'https:' &&
        url.port === '' &&
        allowedHosts.has(url.hostname.toLowerCase()) &&
        allowedPaths.has(normalizePathname(url.pathname))
    : false;
}

function buildOpenAIChatTokenizerRequest(
  ctx: RemoteTokenCountContext,
  endpointPath: string,
  adapterId: string,
  compat: OpenAICompletionsCompat,
): RemoteTokenCounterHttpRequest | undefined {
  const baseUrl = parseUrl(ctx.model.baseUrl);
  if (!baseUrl) return undefined;
  baseUrl.pathname = endpointPath;
  baseUrl.search = '';
  baseUrl.hash = '';
  const url = baseUrl.toString();
  const body = buildOpenAIChatTokenizerBody(ctx, compat);

  return {
    url,
    unsupportedCacheKey: `${adapterId}:${url}`,
    body,
    headers: {
      authorization: `Bearer ${ctx.apiKey ?? ''}`,
      ...(ctx.headers ?? {}),
      'Content-Type': 'application/json',
    },
    hasImages: openAIChatTokenizerBodyHasMedia(body),
  };
}

function buildOpenAIChatTokenizerBody(
  ctx: RemoteTokenCountContext,
  compat: OpenAICompletionsCompat,
): OpenAIChatTokenizerBody {
  const model = ctx.model as Model<'openai-completions'>;
  const context: Context = {
    systemPrompt: ctx.systemPrompt,
    messages: toProviderMessages(ctx.messages, ctx.model),
    tools: ctx.tools,
  };
  const body: OpenAIChatTokenizerBody = {
    model: model.id,
    messages: convertOpenAICompletionsMessages(model, context, compat),
  };
  if (ctx.tools && ctx.tools.length > 0) body.tools = convertTools(ctx.tools, compat);
  return body;
}

function convertTools(
  tools: Tool[],
  compat: OpenAICompletionsCompat,
): NonNullable<OpenAIChatTokenizerBody['tools']> {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(compat.supportsStrictMode !== false && { strict: false as const }),
    },
  }));
}

function openAIChatTokenizerBodyHasMedia(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => openAIChatTokenizerBodyHasMedia(item));
  const record = value as Record<string, unknown>;
  if (record.type === 'image_url') return true;
  return Object.values(record).some((item) => openAIChatTokenizerBodyHasMedia(item));
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value.trim());
  } catch {
    return undefined;
  }
}

function normalizePathname(pathname: string): string {
  return pathname.replace(/\/+$/, '') || '/';
}
