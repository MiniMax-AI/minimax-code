import { Buffer } from 'node:buffer';

import { isDefaultThinkingModelId, type Api, type Model } from '@earendil-works/pi-ai';
import type { LLMModelConfig } from '@mavis/agent-core/pi-turn-runner';
import { ThinkingLevel, ThinkingMode } from '@mavis/protocol';

import { parseProviderId } from '../../../model-system/index.js';
import type { LocalResolvedModelConfig } from '../../../model-system/index.js';
import type { AgentExecutionSnapshot, TurnOutputContract } from '../preparation/contracts.js';
import type { LocalTurnExecutionInput } from '../runner/contracts.js';
import { resolveGatewayFileUploadEndpoint } from './file-api-endpoint.js';
import {
  buildMessagesFileApiPatcher,
  type FileApiUploadStore,
  type FileApiUploadStoreSource,
  type MessagesFileApiPatcherLogger,
} from './messages-file-api-patcher.js';

const OPENPLATFORM_THINKING_VARIANTS_CAPABILITY = 'openplatform_thinking_variants';
const DEFAULT_FILE_API_REF_SCHEME = 'mm_file://';
const DEFAULT_FILE_API_TTL_SEC = 43_200;

export interface LocalTurnPayloadTransformOptions {
  /** Effective client byte budget; enforced after all payload transformations. */
  readonly maxRequestBodyBytes?: number;
  readonly thinkingLevel?: NonNullable<LocalResolvedModelConfig['thinkingLevel']>;
  readonly thinkingRequestPatch?: LocalResolvedModelConfig['thinkingRequestPatch'];
  readonly managedProvider?: boolean;
  readonly modelBaseUrl?: string;
  readonly gatewayAuth?: {
    readonly gatewayHeaders: Readonly<Record<string, string>>;
    readonly callerIdentityHash: string;
  };
  readonly fileApiUploadStore?: FileApiUploadStore;
  readonly fetchImpl?: typeof fetch;
  readonly nowMs?: () => number;
  readonly signal?: AbortSignal;
  readonly logger?: MessagesFileApiPatcherLogger;
  readonly outputContract?: TurnOutputContract;
  readonly supportsJsonObjectOutput?: boolean;
}

type FileApiPatcher = ReturnType<typeof buildMessagesFileApiPatcher>;

/**
 * Builds the provider payload transform owned by the v2 Turn executor.
 * Credential-bearing provider setup remains in the model resolver; this
 * transform only consumes the prepared AgentConfig capability projection.
 */
export function buildLocalTurnPayloadTransform(
  agentConfig: Readonly<Record<string, unknown>>,
  options: LocalTurnPayloadTransformOptions = {},
) {
  const modelConfig = readRecord(agentConfig.model);
  const capabilities = readRecord(modelConfig?.capabilities);
  const videoEnabled = capabilities?.support_video === true;
  const fileApiPatcher = createFileApiPatcher(capabilities, options);
  const thinkingVariants = readThinkingVariants(capabilities);
  const thinkingOn =
    options.managedProvider && modelConfig?.thinking_level !== undefined
      ? modelConfig.thinking_level !== ThinkingLevel.OFF
      : (options.thinkingLevel ?? 'off') !== 'off';
  const thinking = thinkingOn ? thinkingVariants?.thinking : thinkingVariants?.noneThinking;
  const managedThinking = readManagedThinking(
    modelConfig ?? {},
    capabilities ?? {},
    options.managedProvider,
    thinkingOn,
  );
  const selectedEffort =
    !options.managedProvider && thinkingOn
      ? readSelectedThinkingEffort(modelConfig ?? {}, capabilities ?? {})
      : undefined;

  return (payload: unknown, model: Model<Api>): Promise<unknown | undefined> =>
    transformLocalTurnPayload({
      payload,
      model,
      videoEnabled,
      fileApiPatcher,
      thinking,
      managedThinking,
      ...(selectedEffort ? { selectedEffort } : {}),
      thinkingRequestPatch: options.thinkingRequestPatch,
      outputContract: options.outputContract,
      jsonObjectOutputEnabled: options.supportsJsonObjectOutput === true,
      maxRequestBodyBytes: options.maxRequestBodyBytes,
    });
}

function readManagedThinking(
  model: Record<string, unknown>,
  capabilities: Record<string, unknown>,
  managed: boolean | undefined,
  enabled: boolean,
) {
  if (!managed) return undefined;
  const effort = readRawThinkingEffort(model, capabilities);
  if (
    model.thinking_level === undefined &&
    capabilities.thinking_mode === undefined &&
    effort === undefined
  )
    return undefined;
  return {
    enabled,
    mode: capabilities.thinking_mode,
    ...(enabled && typeof effort === 'string' && effort !== 'on' && effort !== 'off'
      ? { effort }
      : {}),
  };
}

function readRawThinkingEffort(
  model: Record<string, unknown>,
  capabilities: Record<string, unknown>,
): unknown {
  return model.thinking_effort ?? capabilities.selected_thinking_effort;
}

/**
 * The explicitly selected effort level for an API-key request. Plain on/off
 * models have no level, and `default` means "let the provider decide", so
 * neither is forwarded.
 */
function readSelectedThinkingEffort(
  model: Record<string, unknown>,
  capabilities: Record<string, unknown>,
): string | undefined {
  const effort = readRawThinkingEffort(model, capabilities);
  return typeof effort === 'string' && !['', 'on', 'off', 'default'].includes(effort)
    ? effort
    : undefined;
}

export function buildLocalRequestPayloadTransform(
  input: {
    readonly agentConfig: Readonly<Record<string, unknown>>;
    readonly llm: LocalResolvedModelConfig;
    readonly sessionId: string;
    readonly signal: AbortSignal;
    readonly outputContract?: TurnOutputContract;
  },
  runtime: {
    readonly fileApi?: {
      readonly uploadStores: FileApiUploadStoreSource;
      readonly fetchImpl?: typeof fetch;
      readonly logger?: MessagesFileApiPatcherLogger;
    };
    readonly nowMs?: () => number;
  },
) {
  const fileApiFetch = resolveFileApiFetch(input.llm, runtime.fileApi?.fetchImpl);
  return buildLocalTurnPayloadTransform(input.agentConfig, {
    thinkingLevel: input.llm.thinkingLevel ?? 'off',
    maxRequestBodyBytes: input.llm.maxRequestBodyBytes,
    ...(input.llm.thinkingRequestPatch
      ? { thinkingRequestPatch: input.llm.thinkingRequestPatch }
      : {}),
    managedProvider: input.llm.managedProvider === true,
    modelBaseUrl: input.llm.model.baseUrl,
    ...(input.llm.fileApiGatewayAuth ? { gatewayAuth: input.llm.fileApiGatewayAuth } : {}),
    ...(runtime.fileApi
      ? {
          fileApiUploadStore: runtime.fileApi.uploadStores.forSession(input.sessionId),
          ...(fileApiFetch ? { fetchImpl: fileApiFetch } : {}),
          ...(runtime.fileApi.logger ? { logger: runtime.fileApi.logger } : {}),
        }
      : {}),
    ...(runtime.nowMs ? { nowMs: runtime.nowMs } : {}),
    signal: input.signal,
    ...(input.outputContract ? { outputContract: input.outputContract } : {}),
    supportsJsonObjectOutput: input.llm.supportsJsonObjectOutput === true,
  });
}

export function buildTurnPayloadTransforms<TAgent extends AgentExecutionSnapshot>(
  input: Pick<LocalTurnExecutionInput<TAgent>, 'lease' | 'preparation'>,
  outputContract: TurnOutputContract | undefined,
  options: Parameters<typeof buildLocalRequestPayloadTransform>[1],
): Pick<LLMModelConfig, 'payloadTransform' | 'auxiliaryPayloadTransform'> {
  const transformInput = {
    agentConfig: input.preparation.agentConfig,
    llm: input.preparation.llm,
    sessionId: input.lease.sessionId,
    signal: input.lease.signal,
  };
  const payloadTransform = buildLocalRequestPayloadTransform(
    { ...transformInput, outputContract },
    options,
  );
  if (!outputContract) return { payloadTransform };
  return {
    payloadTransform,
    auxiliaryPayloadTransform: buildLocalRequestPayloadTransform(transformInput, options),
  };
}

function resolveFileApiFetch(
  llm: LocalResolvedModelConfig,
  fallback: typeof fetch | undefined,
): typeof fetch | undefined {
  return llm.managedProvider === true ? (llm.fetch ?? fallback) : fallback;
}

async function transformLocalTurnPayload(input: {
  readonly payload: unknown;
  readonly model: Model<Api>;
  readonly videoEnabled: boolean;
  readonly fileApiPatcher: FileApiPatcher | undefined;
  readonly thinking: Record<string, unknown> | undefined;
  readonly managedThinking?: {
    readonly enabled: boolean;
    readonly mode: unknown;
    readonly effort?: string;
  };
  /** User-selected effort for an unmanaged (API-key) request; see patchThinkingPayload. */
  readonly selectedEffort?: string;
  readonly thinkingRequestPatch: Readonly<Record<string, unknown>> | undefined;
  readonly outputContract: TurnOutputContract | undefined;
  readonly jsonObjectOutputEnabled: boolean;
  readonly maxRequestBodyBytes: number | undefined;
}): Promise<unknown | undefined> {
  if (!isRecord(input.payload)) return undefined;
  let changed = false;
  if (input.model.api === 'anthropic-messages') {
    const videoChanged = patchVideoPayload(input.payload, input.videoEnabled);
    const fileApiChanged = await patchFileApiPayload(
      input.payload,
      input.model,
      input.fileApiPatcher,
    );
    const thinkingChanged = input.managedThinking
      ? patchManagedThinkingPayload(input.payload, input.thinking, input.managedThinking)
      : patchThinkingPayload(input.payload, input.thinking, input.model, input.selectedEffort);
    changed = videoChanged || fileApiChanged || thinkingChanged;
  }
  const requestPatchChanged = patchRequestPayload(input.payload, input.thinkingRequestPatch);
  const outputFormatChanged = patchOutputFormatPayload(
    input.payload,
    input.model,
    input.outputContract,
    input.jsonObjectOutputEnabled,
  );
  assertRequestBodyFits(input.payload, input.maxRequestBodyBytes);
  return changed || requestPatchChanged || outputFormatChanged ? input.payload : undefined;
}

/** The estimate used to trigger compaction is not the final request body. */
function assertRequestBodyFits(payload: Record<string, unknown>, limit: number | undefined): void {
  if (limit === undefined) return;
  const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (bytes <= limit) return;
  throw Object.assign(
    new Error(`Request body too large: ${bytes} bytes exceeds client limit ${limit} bytes.`),
    {
      code: 'REQUEST_BODY_TOO_LARGE',
      retryable: false,
    },
  );
}

function patchOutputFormatPayload(
  payload: Record<string, unknown>,
  model: Model<Api>,
  outputContract: TurnOutputContract | undefined,
  jsonObjectOutputEnabled: boolean,
): boolean {
  if (!outputContract) return false;
  assertLocalOutputFormatCapability(model, outputContract, jsonObjectOutputEnabled);
  if (outputContract.type === 'json_object') {
    payload.response_format = { type: 'json_object' };
    return true;
  }
  const schema = outputContract.schema;
  const schemaSnapshot = structuredClone(schema);
  const contract = {
    name: 'mcode_output',
    strict: true,
    schema: schemaSnapshot,
  };
  if (model.api === 'openai-responses') {
    payload.text = {
      ...(readRecord(payload.text) ?? {}),
      format: { type: 'json_schema', ...contract },
    };
    return true;
  }
  if (model.api === 'openai-completions') {
    payload.response_format = {
      type: 'json_schema',
      json_schema: contract,
    };
    return true;
  }
  payload.output_config = {
    ...(readRecord(payload.output_config) ?? {}),
    format: {
      type: 'json_schema',
      schema: schemaSnapshot,
    },
  };
  return true;
}

export function assertLocalOutputFormatCapability(
  model: Model<Api>,
  outputContract: TurnOutputContract | undefined,
  jsonObjectOutputEnabled = false,
): void {
  if (!outputContract) return;
  if (outputContract.type === 'json_object') {
    if (model.api === 'openai-completions' && jsonObjectOutputEnabled) return;
    throw Object.assign(
      new Error(
        `JSON object output is unsupported for Provider API ${model.api} or the selected model has not declared support_json_object_output.`,
      ),
      {
        category: 'config' as const,
        code: 'MODEL_CAPABILITY_UNAVAILABLE',
        retryable: false,
      },
    );
  }
  if (
    model.api === 'openai-responses' ||
    model.api === 'openai-completions' ||
    model.api === 'anthropic-messages'
  ) {
    return;
  }
  throw Object.assign(new Error(`--output-schema is unsupported for Provider API ${model.api}.`), {
    category: 'config' as const,
    code: 'MODEL_CAPABILITY_UNAVAILABLE',
    retryable: false,
  });
}

function createFileApiPatcher(
  capabilities: Record<string, unknown> | undefined,
  options: LocalTurnPayloadTransformOptions,
): FileApiPatcher | undefined {
  if (capabilities?.support_files_api !== true) return undefined;
  if (options.managedProvider !== true) return undefined;
  if (!options.gatewayAuth || !options.fileApiUploadStore) return undefined;
  const uploadEndpoint = resolveGatewayFileUploadEndpoint(
    readString(capabilities, 'files_api_upload_endpoint'),
    options.modelBaseUrl,
  );
  if (!uploadEndpoint) return undefined;
  return buildMessagesFileApiPatcher({
    uploadEndpoint,
    refScheme:
      readString(capabilities, 'files_api_ref_scheme')?.trim() || DEFAULT_FILE_API_REF_SCHEME,
    gatewayHeaders: options.gatewayAuth.gatewayHeaders,
    callerIdentityHash: options.gatewayAuth.callerIdentityHash,
    ttlSec: resolveFileApiTtlSec(capabilities.files_api_file_id_ttl_sec),
    store: options.fileApiUploadStore,
    ...fileApiRuntimeOptions(options),
  });
}

function fileApiRuntimeOptions(options: LocalTurnPayloadTransformOptions) {
  return {
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.nowMs ? { nowMs: options.nowMs } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  };
}

function patchVideoPayload(payload: Record<string, unknown>, enabled: boolean): boolean {
  if (!enabled || !Array.isArray(payload.messages)) return false;
  let mutated = false;
  for (const message of payload.messages) {
    mutated = patchVideoMessage(message) || mutated;
  }
  return mutated;
}

async function patchFileApiPayload(
  payload: Record<string, unknown>,
  model: Model<Api>,
  patcher: FileApiPatcher | undefined,
): Promise<boolean> {
  if (!patcher) return false;
  return (await patcher(payload, model)) !== undefined;
}

function patchRequestPayload(
  payload: Record<string, unknown>,
  patch: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (!patch) return false;
  mergeRequestPatch(payload, patch);
  return true;
}

function mergeRequestPatch(
  target: Record<string, unknown>,
  patch: Readonly<Record<string, unknown>>,
): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete target[key];
      continue;
    }
    const targetValue = target[key];
    if (isRecord(targetValue) && isRecord(value)) {
      mergeRequestPatch(targetValue, value);
      continue;
    }
    target[key] = isRecord(value) ? structuredClone(value) : value;
  }
}

function patchThinkingPayload(
  payload: Record<string, unknown>,
  thinking: Record<string, unknown> | undefined,
  model: Model<Api>,
  selectedEffort: string | undefined,
): boolean {
  if (!thinking || !Array.isArray(payload.messages)) return false;
  if (model.api === 'anthropic-messages' && isDefaultThinkingModelId(model.id)) {
    const hadThinking = Object.prototype.hasOwnProperty.call(payload, 'thinking');
    delete payload.thinking;
    return hadThinking;
  }
  payload.thinking = { ...thinking };
  if (shouldPreserveCustomProviderTopEffort(payload, model)) return true;
  if (selectedEffort && parseProviderId(model.provider)?.source === 'minimax_api') {
    // The MiniMax API-key path speaks the same Messages dialect as the managed
    // gateway; keep the selected `--effort` exactly like patchManagedThinkingPayload.
    payload.output_config = { ...readRecord(payload.output_config), effort: selectedEffort };
    return true;
  }
  delete payload.output_config;
  return true;
}

function patchManagedThinkingPayload(
  payload: Record<string, unknown>,
  thinking: Record<string, unknown> | undefined,
  selection: { readonly enabled: boolean; readonly mode: unknown; readonly effort?: string },
): boolean {
  if (!Array.isArray(payload.messages)) return false;
  if (selection.mode === ThinkingMode.FORCED_ON) delete payload.thinking;
  else if (thinking) payload.thinking = { ...thinking };
  else if (selection.mode === ThinkingMode.SWITCHABLE)
    payload.thinking = { type: selection.enabled ? 'adaptive' : 'disabled' };
  const outputConfig = { ...readRecord(payload.output_config) };
  delete outputConfig.effort;
  if (selection.enabled && selection.effort) outputConfig.effort = selection.effort;
  if (Object.keys(outputConfig).length > 0) payload.output_config = outputConfig;
  else delete payload.output_config;
  return true;
}

function shouldPreserveCustomProviderTopEffort(
  payload: Record<string, unknown>,
  model: Model<Api>,
): boolean {
  const effort = readRecord(payload.output_config)?.effort;
  return (
    parseProviderId(model.provider)?.source === 'custom_provider' &&
    (effort === 'xhigh' || effort === 'max') &&
    model.thinkingLevelMap?.[effort] === effort
  );
}

function resolveFileApiTtlSec(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_FILE_API_TTL_SEC;
}

function patchVideoMessage(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.content)) return false;
  return value.content.reduce((mutated, block) => patchVideoBlock(block) || mutated, false);
}

function patchVideoBlock(value: unknown): boolean {
  if (!isRecord(value)) return false;
  let mutated = false;
  if (value.type === 'image' && isRecord(value.source)) {
    const mediaType = value.source.media_type;
    if (typeof mediaType === 'string' && mediaType.startsWith('video/')) {
      value.type = 'video';
      mutated = true;
    }
  }
  if (Array.isArray(value.content)) {
    mutated = value.content.reduce(
      (changed, nested) => patchVideoBlock(nested) || changed,
      mutated,
    );
  }
  return mutated;
}

function readThinkingVariants(
  capabilities: Record<string, unknown> | undefined,
):
  | { readonly thinking?: Record<string, unknown>; readonly noneThinking?: Record<string, unknown> }
  | undefined {
  const raw = readRecord(capabilities?.[OPENPLATFORM_THINKING_VARIANTS_CAPABILITY]);
  if (!raw) return undefined;
  const thinking = readRecord(raw.thinking);
  const noneThinking = readRecord(raw['none-thinking']);
  return thinking || noneThinking
    ? {
        ...(thinking ? { thinking: { ...thinking } } : {}),
        ...(noneThinking ? { noneThinking: { ...noneThinking } } : {}),
      }
    : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function readString(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === 'string' ? candidate : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
