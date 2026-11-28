import { logger } from '@mavis/shared/local-runtime-logging';

import { describeFetchFailure } from './fetch-failure.js';
import { buildModelDiscoveryHeaders, providerModelsUrls } from './provider-request.js';
import type {
  DiscoveredModel,
  ModelDiscoveryClientLike,
  ModelDiscoveryResult,
  ModelDiscoveryTarget,
} from '../contracts.js';

export type {
  DiscoveredModel,
  ModelDiscoveryClientLike,
  ModelDiscoveryResult,
  ModelDiscoveryTarget,
} from '../contracts.js';

// 候选全部缺失时对外只表达“该提供商没有模型列表接口”，状态码对用户没有判断价值；
// 产品文案据此提示手动添加模型。
const MISSING_MODELS_ENDPOINT: ModelDiscoveryResult = {
  ok: false,
  errorCode: 'models_endpoint_missing',
  errorMessage: 'Model list endpoint not found',
};

const INVALID_DISCOVERY_RESPONSE: ModelDiscoveryResult = {
  ok: false,
  errorCode: 'invalid_response',
  errorMessage: 'Invalid model discovery response',
};

/** Bounds `nextPageToken` pagination against a gateway that never stops paging. */
const GEMINI_MAX_MODEL_PAGES = 20;

type DiscoveryPage = { ok: true; payload: unknown } | Extract<ModelDiscoveryResult, { ok: false }>;

export class ModelDiscoveryClient implements ModelDiscoveryClientLike {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  // 原生端点返回 404/405 说明该网关没有这个列表接口，继续尝试 OpenAI 风格候选；
  // 鉴权、限流和服务端错误立即返回，避免把真实故障伪装成端点缺失。
  async discover(target: ModelDiscoveryTarget): Promise<ModelDiscoveryResult> {
    const [primaryUrl, ...fallbackUrls] = providerModelsUrls(target.api, target.baseUrl);
    const primary = await this.discoverAt(primaryUrl, target);
    if (primary.ok || !isMissingModelsEndpoint(primary)) return primary;
    for (const url of fallbackUrls) {
      const result = await this.discoverAt(url, target);
      if (result.ok || !isMissingModelsEndpoint(result)) return result;
    }
    return MISSING_MODELS_ENDPOINT;
  }

  private async discoverAt(
    url: string,
    target: ModelDiscoveryTarget,
  ): Promise<ModelDiscoveryResult> {
    const page = await this.fetchPage(url, target);
    if (!page.ok) return page;
    if (target.api === 'google-generative-ai') {
      // Compatible gateways often expose only an OpenAI-shaped `{ data: [...] }`
      // list under `/v1/models`; accept it instead of treating missing `models` as empty.
      if (!hasOwnGeminiModelsField(page.payload)) {
        const openAiModels = readModels(page.payload);
        if (openAiModels) return { ok: true, models: openAiModels };
      }
      return this.collectGeminiPages(url, target, page.payload);
    }
    const models = readModels(page.payload);
    return models ? { ok: true, models } : INVALID_DISCOVERY_RESPONSE;
  }

  private async collectGeminiPages(
    url: string,
    target: ModelDiscoveryTarget,
    firstPayload: unknown,
  ): Promise<ModelDiscoveryResult> {
    const models: DiscoveredModel[] = [];
    let payload = firstPayload;
    for (let pageCount = 1; ; pageCount += 1) {
      const page = readGeminiModelsPage(payload);
      if (!page) return INVALID_DISCOVERY_RESPONSE;
      models.push(...page.models);
      if (!page.nextPageToken || pageCount >= GEMINI_MAX_MODEL_PAGES) return { ok: true, models };
      const nextUrl = new URL(url);
      nextUrl.searchParams.set('pageToken', page.nextPageToken);
      const next = await this.fetchPage(nextUrl.toString(), target);
      if (!next.ok) return next;
      payload = next.payload;
    }
  }

  private async fetchPage(url: string, target: ModelDiscoveryTarget): Promise<DiscoveryPage> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: buildModelDiscoveryHeaders(target),
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          errorCode: 'unauthorized',
          errorMessage: `Authentication failed (HTTP ${response.status})`,
        };
      }
      if (!response.ok) {
        return {
          ok: false,
          errorCode: `http_${response.status}`,
          errorMessage: `HTTP ${response.status}`,
        };
      }
      return { ok: true, payload: await readJson(response) };
    } catch (error) {
      if (isAbortError(error)) {
        return {
          ok: false,
          errorCode: 'timeout',
          errorMessage: `Request timed out after ${this.timeoutMs}ms`,
        };
      }
      logger.warn(
        {
          event: 'model_provider_request_failed',
          op: 'discover',
          ...describeFetchFailure(error, url),
        },
        'Model provider request failed',
      );
      return { ok: false, errorCode: 'network', errorMessage: 'Network error' };
    } finally {
      clearTimeout(timer);
    }
  }
}

function isMissingModelsEndpoint(result: ModelDiscoveryResult): boolean {
  return !result.ok && (result.errorCode === 'http_404' || result.errorCode === 'http_405');
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (isAbortError(error)) throw error;
    return undefined;
  }
}

function readModels(payload: unknown): DiscoveredModel[] | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return undefined;
  const models = data.flatMap((item): DiscoveredModel[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as { id?: unknown; name?: unknown; display_name?: unknown };
    if (typeof record.id !== 'string' || !record.id.trim()) return [];
    const displayName = readDisplayName(record);
    return [
      {
        modelId: record.id,
        ...(displayName ? { displayName } : {}),
      },
    ];
  });
  return models;
}

/**
 * Gemini `models.list`: `{models: [{name: "models/<id>", displayName,
 * supportedGenerationMethods}], nextPageToken}`. Embedding and other
 * non-chat models do not support `generateContent` and are skipped.
 */
function hasOwnGeminiModelsField(payload: unknown): boolean {
  return Boolean(
    payload &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    Object.hasOwn(payload, 'models'),
  );
}

function readGeminiModelsPage(
  payload: unknown,
): { models: DiscoveredModel[]; nextPageToken?: string } | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const { models, nextPageToken } = payload as { models?: unknown; nextPageToken?: unknown };
  // An account without models returns `{}`.
  if (models !== undefined && !Array.isArray(models)) return undefined;
  return {
    models: (models ?? []).flatMap((item: unknown): DiscoveredModel[] => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const record = item as {
        name?: unknown;
        displayName?: unknown;
        supportedGenerationMethods?: unknown;
      };
      if (typeof record.name !== 'string') return [];
      const modelId = record.name.replace(/^models\//u, '').trim();
      if (!modelId) return [];
      const methods = record.supportedGenerationMethods;
      if (Array.isArray(methods) && !methods.includes('generateContent')) return [];
      return [
        {
          modelId,
          ...(typeof record.displayName === 'string' ? { displayName: record.displayName } : {}),
        },
      ];
    }),
    ...(typeof nextPageToken === 'string' && nextPageToken ? { nextPageToken } : {}),
  };
}

function readDisplayName(record: { name?: unknown; display_name?: unknown }): string | undefined {
  if (typeof record.display_name === 'string') return record.display_name;
  return typeof record.name === 'string' ? record.name : undefined;
}

function isAbortError(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError',
  );
}
