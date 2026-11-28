import {
  CUSTOM_PROVIDER_ID_PREFIX,
  MINIMAX_API_PROVIDER_ID,
  type ModelProviderSource,
} from '../identity.js';

export { CUSTOM_PROVIDER_ID_PREFIX, MINIMAX_API_PROVIDER_ID } from '../identity.js';

export interface ParsedProviderId {
  readonly source: ModelProviderSource;
  readonly providerId: string;
  readonly providerKey: string;
}

export interface ParsedModelKey extends ParsedProviderId {
  readonly modelId: string;
}

export function parseProviderId(
  providerId: string | undefined | null,
): ParsedProviderId | undefined {
  if (!providerId) return undefined;
  if (providerId === MINIMAX_API_PROVIDER_ID) {
    return { source: 'minimax_api', providerId, providerKey: MINIMAX_API_PROVIDER_ID };
  }
  if (providerId.startsWith(CUSTOM_PROVIDER_ID_PREFIX)) {
    const providerKey = providerId.slice(CUSTOM_PROVIDER_ID_PREFIX.length);
    return providerKey ? { source: 'custom_provider', providerId, providerKey } : undefined;
  }
  return { source: 'provider', providerId, providerKey: providerId };
}

export function parseSourceQualifiedModelKey(
  raw: string | undefined | null,
): ParsedModelKey | undefined {
  if (typeof raw !== 'string') return undefined;
  const slash = raw.indexOf('/');
  if (slash <= 0 || slash === raw.length - 1) return undefined;
  const parsedProvider = parseProviderId(raw.slice(0, slash));
  if (!parsedProvider) return undefined;
  return { ...parsedProvider, modelId: raw.slice(slash + 1) };
}

export function formatModelKey(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

/**
 * Reads the model id from either runtime model shape: AgentHost's secret-free
 * execution projection carries `model_id` (or a configured `modelId`), while a
 * resolved Pi `Model` carries `id`. Consumers must accept both because the same
 * Turn hands each shape to different observers.
 */
export function readRuntimeModelId(model: unknown): string | undefined {
  if (!model || typeof model !== 'object') return undefined;
  const record = model as Readonly<Record<string, unknown>>;
  for (const value of [record.model_id, record.modelId, record.id]) {
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

/** Source-qualified `provider/model` identity of a runtime model, or the bare id without provider. */
export function formatRuntimeModelIdentity(model: unknown): string | undefined {
  const modelId = readRuntimeModelId(model);
  if (!modelId) return undefined;
  const provider = (model as Readonly<Record<string, unknown>>).provider;
  return typeof provider === 'string' && provider ? formatModelKey(provider, modelId) : modelId;
}
