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

/** Client protection budgets, not claims about a Provider's actual transport limits. */
const DEFAULT_LOCAL_MULTIMODAL_LIMITS = {
  max_image_bytes_inline: 10_485_760,
  max_video_bytes_inline: 52_428_800,
  max_request_body_bytes: 67_108_864,
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
