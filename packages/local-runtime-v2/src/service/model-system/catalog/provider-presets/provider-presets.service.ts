import { getRuntimeRegion } from '@mavis/config';

import type { ByokProviderPresetView, UserModelInputView } from '../../contracts.js';
import { normalizeProviderBaseUrl } from '../../connectivity/provider-request.js';
import type { ModelProviderApi } from '../../identity.js';
import { isGeminiRejectedEffort } from '../../resolution/model-ref.js';
import {
  fetchModelsDevCatalog,
  fetchPinnedProviderIdsConfig,
  MODELS_DEV_URL,
} from './provider-presets.client.js';
import {
  readProviderPresetSnapshotCandidates,
  resolveProviderPresetLocalCatalogPath,
  type ProviderPresetRepositoryOptions,
  writeProviderPresetSnapshot,
} from './provider-presets.repository.js';
import {
  buildModelRecencyIndex,
  rankModelIdsByRecency,
  type ModelRecencyIndex,
  type RankModelsByRecencyInput,
} from './model-recency.js';

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const MESSAGES_API_BASE_URL = 'https://api.anthropic.com';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
// No provider id is filtered out of the catalog: MiniMax presets are offered
// through BYOK like any other vendor, alongside the built-in managed provider
// and the first-party `minimax_api` key entry. Display order (including whether
// MiniMax is pinned) is owned by Apollo `agent_byok_pinned_provider_ids`, with
// REGION_PINNED_PROVIDER_IDS as the local fallback.
const REGION_PINNED_PROVIDER_IDS = {
  cn: ['zhipuai-coding-plan', 'zhipuai', 'deepseek', 'moonshotai-cn', 'openai', 'anthropic'],
  en: ['zai-coding-plan', 'zai', 'deepseek', 'moonshotai', 'openai', 'anthropic'],
} as const;
// These IDs belong to models.dev, not the bundled inference registry. Keep their
// URLs and IDs intact, and make the billing plan explicit at selection time.
const PROVIDER_PLAN_NAMES = new Map([
  ['zai', 'Z.AI API'],
  ['zai-coding-plan', 'Z.AI Coding Plan'],
  ['zhipuai', 'Zhipu AI API'],
  ['zhipuai-coding-plan', 'Zhipu AI Coding Plan'],
]);
const refreshInFlight = new Map<string, Promise<void>>();
const refreshAttemptedAt = new Map<string, number>();
/** Longest a model ranking waits for a catalog refresh before using the current snapshot. */
const MODEL_RECENCY_REFRESH_WAIT_MS = 3_000;
/** A snapshot older than this is refreshed before ranking; failures retry after the throttle. */
const MODEL_RECENCY_STALE_MS = 6 * 60 * 60_000;
const MODEL_RECENCY_RETRY_MS = 10 * 60_000;

export interface ProviderPresetCatalogOptions extends ProviderPresetRepositoryOptions {
  readonly modelsDevFetch?: typeof fetch;
  readonly modelsDevTimeoutMs?: number;
  readonly commonConfigFetch?: typeof fetch;
  readonly regionGetter?: () => 'cn' | 'en';
  readonly commonConfigOriginGetter?: () => string;
  readonly commonConfigTimeoutMs?: number;
  readonly previewSecret?: string;
  readonly lane?: string;
  readonly now?: () => number;
}

interface ModelsDevCatalogSnapshot {
  readonly version: 1;
  readonly source: typeof MODELS_DEV_URL;
  readonly updatedAt: number;
  readonly etag?: string;
  readonly iconBaseUrl?: string;
  readonly catalog: Record<string, unknown>;
}

interface ParsedModelsDevCatalogSnapshot {
  readonly snapshot: ModelsDevCatalogSnapshot;
  readonly presets: readonly ByokProviderPresetView[];
}

export class ProviderPresetCatalog {
  private readonly refreshKey: string;
  private recency?: { readonly updatedAt: number; readonly index: ModelRecencyIndex };

  constructor(private readonly options: ProviderPresetCatalogOptions = {}) {
    this.refreshKey =
      resolveProviderPresetLocalCatalogPath(options) ?? options.bundledCatalogPath ?? 'default';
    this.startRefresh();
  }

  private startRefresh(): void {
    if (refreshInFlight.has(this.refreshKey)) return;
    refreshAttemptedAt.set(this.refreshKey, (this.options.now ?? Date.now)());
    refreshInFlight.set(
      this.refreshKey,
      refreshModelsDevSnapshotInBackground(this.options, this.refreshKey),
    );
  }

  /**
   * Orders model ids newest first by models.dev `last_updated`. Refreshes a
   * stale snapshot first, waiting at most a few seconds; offline or failed
   * refreshes fall back to the cached or bundled snapshot.
   */
  async rankModelsByRecency(
    input: RankModelsByRecencyInput & { readonly signal?: AbortSignal },
  ): Promise<string[]> {
    const now = (this.options.now ?? Date.now)();
    let latest = await latestCatalogSnapshot(this.options);
    const lastAttempt = refreshAttemptedAt.get(this.refreshKey) ?? 0;
    if (
      (!latest || now - latest.snapshot.updatedAt > MODEL_RECENCY_STALE_MS) &&
      now - lastAttempt > MODEL_RECENCY_RETRY_MS
    ) {
      this.startRefresh();
    }
    const pending = refreshInFlight.get(this.refreshKey);
    if (pending) {
      await waitBounded(pending, MODEL_RECENCY_REFRESH_WAIT_MS, input.signal);
      latest = await latestCatalogSnapshot(this.options);
    }
    input.signal?.throwIfAborted();
    if (!latest) return [...new Set(input.modelIds)];
    if (this.recency?.updatedAt !== latest.snapshot.updatedAt) {
      this.recency = {
        updatedAt: latest.snapshot.updatedAt,
        index: buildModelRecencyIndex(latest.snapshot.catalog),
      };
    }
    return rankModelIdsByRecency(this.recency.index, input);
  }

  async listProviderPresets(): Promise<ByokProviderPresetView[]> {
    const latest = await latestCatalogSnapshot(this.options);
    if (!latest) throw new Error('No valid models.dev catalog snapshot is available');
    const pinnedProviderIds =
      (await resolvePinnedProviderIds({
        fetchImpl: this.options.commonConfigFetch,
        originGetter: this.options.commonConfigOriginGetter,
        timeoutMs: this.options.commonConfigTimeoutMs,
        previewSecret: this.options.previewSecret,
        lane: this.options.lane,
      })) ?? REGION_PINNED_PROVIDER_IDS[(this.options.regionGetter ?? getRuntimeRegion)()];
    return orderProviderPresets(latest.presets, pinnedProviderIds);
  }
}

async function resolvePinnedProviderIds(
  options: Parameters<typeof fetchPinnedProviderIdsConfig>[0],
): Promise<readonly string[] | undefined> {
  try {
    return parsePinnedProviderIds(await fetchPinnedProviderIdsConfig(options));
  } catch {
    return undefined;
  }
}

function parseModelsDevProviderPresets(
  value: unknown,
  iconBaseUrl?: string,
): ByokProviderPresetView[] {
  if (!isRecord(value)) throw new Error('models.dev returned an invalid catalog');
  const presets: ByokProviderPresetView[] = [];
  for (const [providerId, rawProvider] of Object.entries(value)) {
    const preset = parseProvider(providerId, rawProvider, iconBaseUrl);
    if (preset) presets.push(preset);
  }
  return presets.sort((left, right) => left.name.localeCompare(right.name));
}

function parseProvider(
  providerId: string,
  value: unknown,
  iconBaseUrl?: string,
): ByokProviderPresetView | undefined {
  if (!providerId.trim() || !isRecord(value) || !isRecord(value.models)) {
    return undefined;
  }
  const transport = resolveTransport(providerId, value);
  if (!transport) return undefined;
  const models = Object.entries(value.models)
    .map(([modelId, model]) => parseModel(modelId, model, transport.apiFormat))
    .filter((model): model is UserModelInputView => model !== undefined)
    .sort((left, right) =>
      (left.displayName ?? left.modelId).localeCompare(right.displayName ?? right.modelId),
    );
  if (models.length === 0) return undefined;
  return {
    providerId,
    name: PROVIDER_PLAN_NAMES.get(providerId) ?? stringValue(value.name) ?? providerId,
    ...transport,
    models,
    ...(iconBaseUrl ? { iconUrl: resolveProviderIconUrl(iconBaseUrl, providerId) } : {}),
  };
}

interface TransportContract {
  readonly apiFormat: ModelProviderApi;
  // Only the canonical Provider ID for this npm package may omit `api` and use
  // the official base URL; every other provider must declare a valid `api`.
  readonly canonical?: { readonly providerId: string; readonly baseUrl: string };
}

// OpenRouter ships its own SDK package in models.dev, but its wire protocol is
// the OpenAI chat-completions API.
const TRANSPORTS_BY_NPM = new Map<string, TransportContract>([
  [
    '@ai-sdk/openai',
    {
      apiFormat: 'openai-responses',
      canonical: { providerId: 'openai', baseUrl: OPENAI_BASE_URL },
    },
  ],
  ['@ai-sdk/openai-compatible', { apiFormat: 'openai-completions' }],
  [
    '@ai-sdk/anthropic',
    {
      apiFormat: 'anthropic-messages',
      canonical: { providerId: 'anthropic', baseUrl: MESSAGES_API_BASE_URL },
    },
  ],
  [
    '@openrouter/ai-sdk-provider',
    {
      apiFormat: 'openai-completions',
      canonical: { providerId: 'openrouter', baseUrl: OPENROUTER_BASE_URL },
    },
  ],
  // `@ai-sdk/google-vertex` stays unmapped: Vertex uses project/location and
  // Google Cloud credentials, not a base URL plus API key.
  [
    '@ai-sdk/google',
    {
      apiFormat: 'google-generative-ai',
      canonical: { providerId: 'google', baseUrl: GEMINI_BASE_URL },
    },
  ],
]);

function resolveTransport(
  providerId: string,
  provider: Record<string, unknown>,
): { baseUrl: string; apiFormat: ModelProviderApi } | undefined {
  const transport = TRANSPORTS_BY_NPM.get(stringValue(provider.npm) ?? '');
  if (!transport) return undefined;
  const { apiFormat, canonical } = transport;
  const baseUrl =
    canonical?.providerId === providerId && provider.api === undefined
      ? canonical.baseUrl
      : stringValue(provider.api);
  if (!baseUrl || !isHttpUrl(baseUrl)) return undefined;
  return { baseUrl: normalizeProviderBaseUrl(apiFormat, baseUrl), apiFormat };
}

function isUnsupportedGeminiRealtimeModel(modelId: string, apiFormat: ModelProviderApi): boolean {
  return apiFormat === 'google-generative-ai' && /-(?:live|tts)(?:-|$)/iu.test(modelId.trim());
}

function parseModel(
  modelId: string,
  value: unknown,
  apiFormat: ModelProviderApi,
): UserModelInputView | undefined {
  if (
    !modelId.trim() ||
    !isRecord(value) ||
    value.tool_call !== true ||
    isUnsupportedGeminiRealtimeModel(modelId, apiFormat)
  ) {
    return undefined;
  }
  return {
    modelId,
    displayName: stringValue(value.name) ?? modelId,
    ...parseModelCapabilities(value),
    ...parseModelEffortOptions(value, apiFormat),
    ...parseModelModalities(value),
    ...parseModelLimit(value),
  };
}

function parseModelCapabilities(value: Record<string, unknown>): Partial<UserModelInputView> {
  return {
    attachment: value.attachment === true,
    reasoning: value.reasoning === true,
    toolCall: true,
    temperature: value.temperature === true,
  };
}

/**
 * Reads the catalog's declared reasoning-effort levels. models.dev describes
 * reasoning controls as `reasoning_options` entries; only an explicit
 * `{ type: 'effort', values: [...] }` entry means the model accepts effort
 * selection. A bare `reasoning: true` or a `toggle` entry only means the model
 * can think, so neither one produces `effortOptions` here. Declared strings
 * are preserved as-is (trimmed, de-duplicated, in catalog order) so levels the
 * CLI does not know about still reach validation and the wire unchanged, except
 * levels the protocol rejects (Gemini has nothing below `low`).
 */
function parseModelEffortOptions(
  value: Record<string, unknown>,
  apiFormat: ModelProviderApi,
): Partial<UserModelInputView> {
  if (!Array.isArray(value.reasoning_options)) return {};
  for (const option of value.reasoning_options) {
    if (!isRecord(option) || option.type !== 'effort' || !Array.isArray(option.values)) continue;
    const effortOptions = [
      ...new Set(
        option.values
          .filter((candidate): candidate is string => typeof candidate === 'string')
          .map((candidate) => candidate.trim())
          .filter((candidate) => candidate && !isGeminiRejectedEffort(apiFormat, candidate)),
      ),
    ];
    if (effortOptions.length > 0) return { effortOptions };
  }
  return {};
}

function parseModelModalities(value: Record<string, unknown>): Partial<UserModelInputView> {
  const modalities = isRecord(value.modalities) ? value.modalities : undefined;
  const input = stringArray(modalities?.input);
  const output = stringArray(modalities?.output);
  if (!input && !output) return {};
  return { modalities: { ...(input ? { input } : {}), ...(output ? { output } : {}) } };
}

function parseModelLimit(value: Record<string, unknown>): Partial<UserModelInputView> {
  const limit = isRecord(value.limit) ? value.limit : undefined;
  const context = positiveInteger(limit?.context);
  const output = positiveInteger(limit?.output);
  if (!context && !output) return {};
  return { limit: { ...(context ? { context } : {}), ...(output ? { output } : {}) } };
}

function parsePinnedProviderIds(value: unknown): string[] | undefined {
  let decoded = value;
  if (typeof value === 'string') {
    try {
      decoded = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (
    !Array.isArray(decoded) ||
    decoded.some((providerId) => typeof providerId !== 'string' || !providerId.trim())
  ) {
    return undefined;
  }
  return [...new Set(decoded)];
}

function orderProviderPresets(
  presets: readonly ByokProviderPresetView[],
  pinnedProviderIds: readonly string[],
): ByokProviderPresetView[] {
  const byId = new Map(presets.map((preset) => [preset.providerId, preset]));
  const pinned = pinnedProviderIds.flatMap((providerId) => {
    const preset = byId.get(providerId);
    if (!preset) return [];
    byId.delete(providerId);
    return [preset];
  });
  return [
    ...pinned,
    ...[...byId.values()].sort((left, right) => left.name.localeCompare(right.name)),
  ];
}

async function refreshModelsDevSnapshot(options: ProviderPresetCatalogOptions): Promise<void> {
  const current = await latestCatalogSnapshot(options);
  const region = (options.regionGetter ?? getRuntimeRegion)();
  const result = await fetchModelsDevCatalog({
    fetchImpl: options.modelsDevFetch,
    timeoutMs: options.modelsDevTimeoutMs,
    etag: current?.snapshot.iconBaseUrl ? current.snapshot.etag : undefined,
    region,
    descriptorOriginGetter: options.commonConfigOriginGetter,
    previewSecret: options.previewSecret,
    lane: options.lane,
  });
  if (result.kind === 'not_modified') return;
  const presets = parseModelsDevProviderPresets(result.catalog, result.iconBaseUrl);
  if (presets.length === 0) throw new Error('models.dev returned no supported providers');
  const snapshot: ModelsDevCatalogSnapshot = {
    version: 1,
    source: MODELS_DEV_URL,
    updatedAt: (options.now ?? Date.now)(),
    ...(result.etag ? { etag: result.etag } : {}),
    iconBaseUrl: result.iconBaseUrl,
    catalog: result.catalog,
  };
  const localCatalogPath = resolveProviderPresetLocalCatalogPath(options);
  if (localCatalogPath) await writeProviderPresetSnapshot(localCatalogPath, snapshot);
}

async function refreshModelsDevSnapshotInBackground(
  options: ProviderPresetCatalogOptions,
  refreshKey: string,
): Promise<void> {
  try {
    await refreshModelsDevSnapshot(options);
  } catch {
    // The validated local snapshot remains authoritative when refresh fails.
  } finally {
    refreshInFlight.delete(refreshKey);
  }
}

async function latestCatalogSnapshot(
  options: ProviderPresetCatalogOptions,
): Promise<ParsedModelsDevCatalogSnapshot | undefined> {
  const parsed: ParsedModelsDevCatalogSnapshot[] = [];
  for (const candidate of await readProviderPresetSnapshotCandidates(options)) {
    try {
      parsed.push(parseCatalogSnapshot(candidate));
    } catch {
      // A corrupt candidate must not hide another valid local snapshot.
    }
  }
  return parsed.sort((left, right) => right.snapshot.updatedAt - left.snapshot.updatedAt)[0];
}

function parseCatalogSnapshot(value: unknown): ParsedModelsDevCatalogSnapshot {
  const updatedAt = isRecord(value) ? positiveInteger(value.updatedAt) : undefined;
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.source !== MODELS_DEV_URL ||
    !updatedAt ||
    !isRecord(value.catalog)
  ) {
    throw new Error('Invalid models.dev catalog snapshot');
  }
  const iconBaseUrl = parseSnapshotIconBaseUrl(value.iconBaseUrl);
  const presets = parseModelsDevProviderPresets(value.catalog, iconBaseUrl);
  if (presets.length === 0) {
    throw new Error('models.dev catalog snapshot has no supported providers');
  }
  const etag = stringValue(value.etag);
  return {
    snapshot: {
      version: 1,
      source: MODELS_DEV_URL,
      updatedAt,
      ...(etag ? { etag } : {}),
      ...(iconBaseUrl ? { iconBaseUrl } : {}),
      catalog: value.catalog,
    },
    presets,
  };
}

function parseSnapshotIconBaseUrl(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const iconBaseUrl = stringValue(value);
  if (!iconBaseUrl || !isHttpUrl(iconBaseUrl)) {
    throw new Error('Invalid models.dev icon base URL');
  }
  return iconBaseUrl;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function resolveProviderIconUrl(iconBaseUrl: string, providerId: string): string {
  const prefix = iconBaseUrl.endsWith('/') ? iconBaseUrl : `${iconBaseUrl}/`;
  return `${prefix}${encodeURIComponent(providerId)}.svg`;
}

async function settled(task: Promise<void>): Promise<void> {
  try {
    await task;
  } catch {
    // A failed refresh leaves the current snapshot in place.
  }
}

/** Resolves when `task` settles or `ms` elapses; rejects only when `signal` aborts. */
async function waitBounded(task: Promise<void>, ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      settled(task),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal?.reason);
        signal?.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === 'string' && Boolean(item));
  return strings.length > 0 ? strings : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
