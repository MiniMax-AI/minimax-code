import type { IModelCapabilities } from '@mavis/protocol';

import type { LocalModelConfig } from '../contracts.js';

type CapabilityConfig = NonNullable<LocalModelConfig['capabilities']>;

/** Canonical protocol fields win over the legacy local `use_file_api` alias. */
export function normalizeLocalFileApiCapabilities(
  capabilities: CapabilityConfig | undefined,
): Pick<
  IModelCapabilities,
  | 'support_files_api'
  | 'files_api_upload_endpoint'
  | 'files_api_ref_scheme'
  | 'files_api_file_id_ttl_sec'
> {
  const enabled =
    typeof capabilities?.support_files_api === 'boolean'
      ? capabilities.support_files_api
      : capabilities?.use_file_api === true;
  if (!enabled) return { support_files_api: false };
  const endpoint = capabilities?.files_api_upload_endpoint?.trim();
  const refScheme = capabilities?.files_api_ref_scheme?.trim();
  const ttlSec = capabilities?.files_api_file_id_ttl_sec;
  return {
    support_files_api: true,
    ...(endpoint ? { files_api_upload_endpoint: endpoint } : {}),
    ...(refScheme ? { files_api_ref_scheme: refScheme } : {}),
    ...(typeof ttlSec === 'number' && Number.isFinite(ttlSec) && ttlSec >= 0
      ? { files_api_file_id_ttl_sec: ttlSec }
      : {}),
  };
}

/**
 * Request-body budget (serialized JSON bytes) when a model declares none. The
 * strictest MiniMax delivery channel (Bedrock) rejects bodies around 16-18 MB,
 * so 64 MiB was never reached before the provider answered 413.
 */
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 16_777_216;

/**
 * Request-body budget for the MiniMax open-platform API-key path, which talks
 * to MiniMax directly and accepts bodies up to about 28 MB.
 */
export const MINIMAX_API_MAX_REQUEST_BODY_BYTES = 29_360_128;

/** Client protection budgets, not claims about a Provider's actual transport limits. */
const DEFAULT_LOCAL_MULTIMODAL_LIMITS = {
  max_image_bytes_inline: 10_485_760,
  max_video_bytes_inline: 52_428_800,
  max_request_body_bytes: DEFAULT_MAX_REQUEST_BODY_BYTES,
  max_attachments_count: 4,
} as const;

type MultimodalLimits = Pick<IModelCapabilities, keyof typeof DEFAULT_LOCAL_MULTIMODAL_LIMITS>;

/** Shared by ModelRef construction and live resolution of legacy ModelRefs. */
export function normalizeLocalMultimodalLimitCapabilities(
  capabilities: Pick<CapabilityConfig, keyof MultimodalLimits> | undefined,
): Required<MultimodalLimits> {
  return {
    max_image_bytes_inline:
      normalizePositiveByteLimit(capabilities?.max_image_bytes_inline) ??
      DEFAULT_LOCAL_MULTIMODAL_LIMITS.max_image_bytes_inline,
    max_video_bytes_inline:
      normalizePositiveByteLimit(capabilities?.max_video_bytes_inline) ??
      DEFAULT_LOCAL_MULTIMODAL_LIMITS.max_video_bytes_inline,
    max_request_body_bytes:
      normalizePositiveByteLimit(capabilities?.max_request_body_bytes) ??
      DEFAULT_LOCAL_MULTIMODAL_LIMITS.max_request_body_bytes,
    max_attachments_count: Number(
      normalizePositiveByteLimit(capabilities?.max_attachments_count) ??
        DEFAULT_LOCAL_MULTIMODAL_LIMITS.max_attachments_count,
    ),
  };
}

function normalizePositiveByteLimit(value: unknown): number | string | undefined {
  const candidate = typeof value === 'string' ? value.trim() : value;
  if (typeof candidate !== 'number' && typeof candidate !== 'string') return undefined;
  const parsed = Number(candidate);
  return Number.isSafeInteger(parsed) && parsed > 0 ? candidate : undefined;
}

/**
 * Effective client request-body budget for one resolved model. The MiniMax
 * catalog is shared by every delivery channel and carries the strictest
 * channel's budget; the API-key path is a known direct channel and uses its own
 * larger budget. Custom providers and the managed path keep the declared
 * capability (or the conservative default).
 */
export function resolveMaxRequestBodyBytes(input: {
  readonly providerSource: 'minimax_api' | 'custom_provider' | 'provider' | undefined;
  readonly capabilities: Pick<CapabilityConfig, keyof MultimodalLimits> | undefined;
}): number {
  if (input.providerSource === 'minimax_api') return MINIMAX_API_MAX_REQUEST_BODY_BYTES;
  return Number(normalizeLocalMultimodalLimitCapabilities(input.capabilities).max_request_body_bytes);
}
