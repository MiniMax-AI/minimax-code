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
 * Client protection budgets, not claims about a Provider's actual transport limits.
 *
 * The request body default sits below the strictest known provider transport
 * (Bedrock, 20 MB). The client cannot tell which transport serves a compatible
 * gateway, so every unconfigured model gets it; the provider request budget is
 * raised only for the first-party hosts in `KNOWN_HOST_REQUEST_BODY_BYTES`.
 */
const DEFAULT_LOCAL_MULTIMODAL_LIMITS = {
  max_image_bytes_inline: 10_485_760,
  max_video_bytes_inline: 52_428_800,
  max_request_body_bytes: 18_874_368,
  max_attachments_count: 4,
} as const;

/** Marks a ModelRef whose `max_request_body_bytes` is the default, not declared. */
const DEFAULT_REQUEST_BODY_CAPABILITY = 'default_request_body_bytes';

const MIB = 1_024 * 1_024;
const MESSAGES_API_HOST = new URL('https://api.anthropic.com').hostname;
/**
 * Documented request body limits of first-party API hosts, less headroom: the
 * Messages API 32 MB direct and 30 MB on Google Cloud, OpenAI Responses 512 MB.
 * Matched on the exact hostname, so gateways keep the default.
 */
const KNOWN_HOST_REQUEST_BODY_BYTES: ReadonlyArray<{
  readonly matches: (hostname: string, api: string) => boolean;
  readonly bytes: number;
}> = [
  { matches: (hostname) => hostname === MESSAGES_API_HOST, bytes: 28 * MIB },
  {
    matches: (hostname, api) =>
      api === 'anthropic-messages' &&
      /^(?:[a-z0-9-]+-)?aiplatform\.googleapis\.com$/u.test(hostname),
    bytes: 26 * MIB,
  },
  { matches: (hostname) => hostname === 'api.openai.com', bytes: 64 * MIB },
];

type MultimodalLimits = Pick<IModelCapabilities, keyof typeof DEFAULT_LOCAL_MULTIMODAL_LIMITS>;

/** Shared by ModelRef construction and live resolution of legacy ModelRefs. */
export function normalizeLocalMultimodalLimitCapabilities(
  capabilities: Pick<CapabilityConfig, keyof MultimodalLimits> | undefined,
): Required<MultimodalLimits> {
  const limits = normalizedLimits(capabilities);
  if (normalizePositiveByteLimit(capabilities?.max_request_body_bytes) === undefined) {
    Reflect.set(limits, DEFAULT_REQUEST_BODY_CAPABILITY, true);
  }
  return limits;
}

/**
 * Provider request body budget: the declared limit, else the documented limit
 * of a known first-party host, else the default.
 */
export function resolveLocalRequestBodyBytes(
  capabilities: Pick<CapabilityConfig, keyof MultimodalLimits> | undefined,
  endpoint: { readonly api: string; readonly baseUrl: string },
): number {
  const declared = Number(normalizedLimits(capabilities).max_request_body_bytes);
  const isDefault =
    Reflect.get(capabilities ?? {}, DEFAULT_REQUEST_BODY_CAPABILITY) === true ||
    normalizePositiveByteLimit(capabilities?.max_request_body_bytes) === undefined;
  if (!isDefault) return declared;
  let hostname: string;
  try {
    hostname = new URL(endpoint.baseUrl).hostname.toLowerCase();
  } catch {
    return declared;
  }
  return (
    KNOWN_HOST_REQUEST_BODY_BYTES.find(({ matches }) => matches(hostname, endpoint.api))?.bytes ??
    declared
  );
}

function normalizedLimits(
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
