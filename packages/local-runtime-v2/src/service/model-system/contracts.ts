import type { Api } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { LLMModelConfig } from '@mavis/agent-core/pi-turn-runner';
import type {
  AgentCapabilityConfig,
  Config,
  LocalByokConfigDraft,
  ModelConfig,
  ProviderAuthMode,
  ResolvedAgentCapabilities,
} from '@mavis/config';
import type { IAgentConfig } from '@mavis/protocol';

import type { ModelProviderApi, ModelProviderSource } from './identity.js';

export type { LocalByokConfigDraft };
export type { ModelProviderSource } from './identity.js';

type LocalModelLimit = Partial<NonNullable<ModelConfig['limit']>>;
type LocalModelModalities = Partial<NonNullable<ModelConfig['modalities']>>;
type LocalModelCapabilities = Partial<NonNullable<ModelConfig['capabilities']>>;

/**
 * Protocol compatibility overrides a BYOK custom provider may declare per model.
 *
 * Pi auto-detects these from `provider` and `baseUrl`. A gateway that forwards an
 * upstream vendor under its own provider id and host masks that identity, so every
 * fingerprint misses and the detected defaults describe the wrong upstream. These
 * overrides let the provider config state the upstream's real protocol surface; pi
 * applies each declared field ahead of its own detection.
 */
export interface LocalModelCompatOverrides {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  supportsUsageInStreaming?: boolean;
  requiresToolResultName?: boolean;
  requiresToolsForToolHistory?: boolean;
  requiresAssistantAfterToolResult?: boolean;
  requiresThinkingAsText?: boolean;
  requiresReasoningContentOnAssistantMessages?: boolean;
  supportsStrictMode?: boolean;
  supportsLongCacheRetention?: boolean;
  supportsEagerToolInputStreaming?: boolean;
  supportsCacheControlOnTools?: boolean;
  supportsTemperature?: boolean;
  sendSessionAffinityHeaders?: boolean;
  sendSessionIdHeader?: boolean;
  zaiToolStream?: boolean;
  forceAdaptiveThinking?: boolean;
  allowEmptySignature?: boolean;
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  thinkingFormat?:
    | 'openai'
    | 'openrouter'
    | 'together'
    | 'deepseek'
    | 'zai'
    | 'qwen'
    | 'qwen-chat-template'
    | 'string-thinking'
    | 'ant-ling';
  cacheControlFormat?: 'anthropic';
}

export interface LocalModelConfig extends Omit<
  Partial<ModelConfig>,
  'limit' | 'modalities' | 'capabilities'
> {
  reasoning?: boolean;
  capabilities?: LocalModelCapabilities;
  limit?: LocalModelLimit;
  modalities?: LocalModelModalities;
  compat?: LocalModelCompatOverrides;
}

export interface LocalProviderOptions {
  apiKey?: string;
  baseURL?: string;
  authMode?: ProviderAuthMode;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

export interface LocalProviderConfig {
  name?: string;
  api?: string;
  options?: LocalProviderOptions;
  models?: Record<string, LocalModelConfig>;
  model_order?: string[];
}

export type LocalModelsConfig = Record<string, LocalProviderConfig>;

export interface LocalMinimaxApiConfig {
  apiKey?: string;
  baseURL?: string;
  modelContextLimits?: Record<string, number>;
}

export interface LocalCustomProviderConfig extends LocalProviderConfig {
  kind?: string;
  npm?: string;
  enabled?: boolean;
}

export type LocalCustomProvidersConfig = Record<string, LocalCustomProviderConfig>;
export type LocalBetaConfig = Partial<Config['beta']>;

/** Model configuration read by the resolution and management capabilities. */
export interface LocalRuntimeConfig {
  provider: LocalModelsConfig;
  minimax_api?: LocalMinimaxApiConfig;
  custom_provider?: LocalCustomProvidersConfig;
  minimaxModelSource?: 'token_plan' | 'minimax_api_key';
  defaultModel?: string;
  defaultModelVariant?: string;
  defaultModelThinking?: { effort?: string };
  defaultModelContextWindow?: number;
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'auto' | 'off';
  dataDir: string;
  beta?: LocalBetaConfig;
}

/** Conversation-owned read model of the process config. */
export interface LocalConversationRuntimeConfig extends LocalRuntimeConfig {
  readonly defaultLightModel?: string;
  /** Goal verifier policy consumed by process-local auxiliary model calls. */
  readonly goal?: Config['goal'];
  readonly memory?: Partial<Config['memory']>;
  /** Session title auto-generation flag — see @mavis/config SessionTitleConfig. */
  readonly sessionTitle?: Config['sessionTitle'];
  /** Runaway Guard local policy resolved from config.yaml. */
  readonly runawayGuard?: Config['runawayGuard'];
  /** ToolResult compaction values resolved from config.yaml. */
  readonly toolResultCompaction?: Config['toolResultCompaction'];
  /**
   * Widened past `Config['agents']`: the v2 Agent cutover also threads
   * already-resolved capabilities through this read model, and `default` is
   * absent until the config supplies it.
   */
  readonly agents?: {
    readonly default?: AgentCapabilityConfig | ResolvedAgentCapabilities;
  };
  readonly mcpToolSearch?: {
    readonly enabled?: boolean;
    readonly modelWhitelist?: readonly string[];
    readonly thresholdPct?: number;
    readonly minDeferCount?: number;
    readonly topKDefault?: number;
    readonly topKMax?: number;
    readonly systemHint?: boolean;
    readonly maxSchemaTextLen?: number;
  };
}

/** One profile-bound read/write authority for all Model System configuration. */
export interface ModelSystemConfigPort {
  readonly read: () => LocalRuntimeConfig;
  readonly updateByok: (
    mutate: (
      draft: LocalByokConfigDraft,
      currentConfig: LocalRuntimeConfig,
    ) => void | Promise<void>,
  ) => Promise<unknown>;
  readonly compareAndSetModelContext: (
    input: {
      readonly providerId: string;
      readonly modelId: string;
      readonly expectedContextLimit: number;
      readonly contextLimit: number;
    },
    beforeCommit: (currentConfig: LocalRuntimeConfig) => Promise<boolean>,
  ) => Promise<boolean>;
  readonly setDefaultModel: (
    modelKey: string,
    variant?: string,
    selection?: {
      readonly contextLimit?: number;
      readonly thinking?: { readonly effort?: string };
    },
  ) => Promise<void>;
  readonly removeProvider: (providerId: string) => Promise<unknown>;
}

/** Live local-runtime identity used by managed model and content-safety requests. */
export interface LocalRuntimeAuthContext {
  readonly accessToken?: string;
  readonly loginEpoch?: string;
  readonly realUserID?: string;
  readonly userEmail?: string;
  readonly userName?: string;
  readonly subUserName?: string;
  /** Electron-internal propagation state; omitted by non-Desktop hosts. */
  readonly authState?: 'pending' | 'authenticated' | 'logged_out';
}

export interface LocalByokProviderConfig {
  readonly minimax_api?: LocalMinimaxApiConfig;
  readonly custom_provider?: LocalCustomProvidersConfig;
  readonly minimaxModelSource?: 'token_plan' | 'minimax_api_key';
}

export interface LocalModelResolverLogger {
  info(fields: Readonly<Record<string, unknown>>, message: string): void;
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
}

export interface LocalModelResolverOptions {
  readonly providerConfig?: LocalModelsConfig;
  readonly providerConfigGetter?: () => LocalModelsConfig;
  readonly byokConfigGetter?: () => LocalByokProviderConfig | undefined;
  readonly authContextGetter?: () => LocalRuntimeAuthContext | undefined;
  /** Owner-side generation-aware recovery for a rejected managed OAuth request. */
  readonly authContextInvalidator?: (
    rejectedAccessToken?: string,
    loginEpoch?: string,
  ) => void | Promise<void>;
  readonly routingContextGetter?: () =>
    | import('@mavis/agent-tools/desktop').ManagedBackendRoutingContext
    | undefined;
  readonly providerAuthGetter?: (
    provider: string,
  ) => Promise<string | undefined> | string | undefined;
  readonly defaultApi?: Api;
  readonly streamFn?: StreamFn;
  readonly fetchImpl?: LLMModelConfig['fetch'];
  readonly logger?: LocalModelResolverLogger;
  /** Enables metadata-free custom-provider thinking only for the new TUI product. */
  readonly implicitCustomProviderThinking?: boolean;
}

export interface LocalModelResolveInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly agentConfig: IAgentConfig;
}

export interface LocalResolvedModelConfig extends LLMModelConfig {
  /** Final resolved ModelRef capability for OpenAI-compatible JSON object output. */
  readonly supportsJsonObjectOutput?: boolean;
  /** Provider-specific payload fields that preserve explicit Thinking Off on the wire. */
  readonly thinkingRequestPatch?: Readonly<Record<string, unknown>>;
  /** True only for the platform-owned Token Plan / Credits inference path. */
  readonly managedProvider?: boolean;
  /** Selected Model byte authority for Local Serialized Footprint admission; not wire-exact. */
  readonly maxRequestBodyBytes?: number;
  /** Managed-login File API transport identity; absent for every BYOK route. */
  readonly fileApiGatewayAuth?: {
    readonly gatewayHeaders: Readonly<Record<string, string>>;
    readonly callerIdentityHash: string;
  };
}

export interface LocalModelResolverLike {
  resolveModel(input: LocalModelResolveInput): Promise<LocalResolvedModelConfig>;
}

export type MiniMaxM3ThinkingMode = 'on' | 'off';

export type ModelProviderTestApi = ModelProviderApi;

export type ModelCacheState = 'unknown' | 'available' | 'failed';

export interface ModelCacheStatusEntry {
  state: ModelCacheState;
  /** Unix ms (repo rule: never ISO strings in storage). */
  last_tested_at?: number;
  last_error_code?: string;
  last_error_message?: string;
  /** SHA-256 of the effective provider + model request configuration. */
  config_fingerprint?: string;
}

export interface ModelCacheData {
  version: 3;
  provider_status: Record<string, ModelCacheStatusEntry>;
  model_status: Record<string, ModelCacheStatusEntry>;
}

export interface LocalModelCacheLike {
  load(): ModelCacheData;
  setProviderStatus(providerId: string, entry: ModelCacheStatusEntry): Promise<void>;
  setModelStatus(modelKey: string, entry: ModelCacheStatusEntry): Promise<void>;
  replaceModelStatus(
    modelKey: string,
    entry: ModelCacheStatusEntry,
  ): Promise<ModelCacheStatusEntry | undefined>;
  restoreModelStatusIfCurrent(
    modelKey: string,
    expectedCurrent: ModelCacheStatusEntry,
    previous: ModelCacheStatusEntry | undefined,
  ): Promise<boolean>;
  removeModelStatus(modelKey: string): Promise<void>;
  removeProvider(providerId: string): Promise<void>;
}

export interface ModelCacheStatusView {
  state: string;
  lastTestedAt?: number;
  lastErrorCode?: string;
  lastErrorMessage?: string;
}

export type ModelProviderKind = 'minimax-managed' | 'minimax-api-key' | 'oauth' | 'custom';

export interface ModelThinkingConfigView {
  mode: 'switchable' | 'forced_on' | 'forced_off' | 'hidden';
  default_value?: 'true' | 'false';
}

export interface ModelProviderModelEntry {
  providerId: string;
  modelId: string;
  modelConfigId: string;
  displayName: string;
  configurationSource?: 'manual' | 'discovered';
  enabled: boolean;
  selected: boolean;
  contextLimit?: number;
  defaultContextLimit?: number;
  thinking?: { effort?: string };
  contextWindowOptions?: number[];
  contextWindowOptionHints?: Record<string, 'higher_usage'>;
  maxOutputTokens?: number;
  effortOptions?: string[];
  defaultEffort?: string;
  supportedVariants?: string[];
  thinkingConfig?: ModelThinkingConfigView;
  variant?: string;
  providerSource: ModelProviderSource;
  providerKind: ModelProviderKind;
  providerName: string;
  apiFormat?: string;
  modalities?: { input?: string[]; output?: string[] };
  status?: ModelCacheStatusView;
}

export interface ModelProviderView {
  providerId: string;
  name: string;
  source: ModelProviderSource;
  kind: ModelProviderKind;
  enabled: boolean;
  baseUrl?: string;
  apiFormat?: string;
  hasApiKey: boolean;
  maskedApiKey?: string;
  headerNames?: string[];
  configRevision?: string;
  models: ModelProviderModelEntry[];
  status?: ModelCacheStatusView;
}

export interface ModelDiscoveryTarget {
  api: ModelProviderApi;
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
}

export interface DiscoveredModel {
  modelId: string;
  displayName?: string;
}

export type ModelDiscoveryResult =
  | { ok: true; models: DiscoveredModel[] }
  | { ok: false; errorCode: string; errorMessage: string };

export interface ModelDiscoveryClientLike {
  discover(target: ModelDiscoveryTarget): Promise<ModelDiscoveryResult>;
}

export interface ModelConnectionTestTarget {
  api: ModelProviderTestApi;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  headers?: Record<string, string>;
  effort?: string;
  minimaxM3ThinkingMode?: MiniMaxM3ThinkingMode;
  /**
   * Output budget the probe requests, taken from the model's configured output
   * limit. Mirrors what a real turn sends so an output-budget rejection can
   * never be the reason a working model reports as unavailable.
   */
  outputLimit?: number;
}

export interface ModelConnectionTestResult {
  ok: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export class LocalModelProviderError extends Error {
  override name = 'LocalModelProviderError';

  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface UserModelInputView {
  modelId: string;
  displayName?: string;
  configurationSource?: string;
  enabled?: boolean;
  attachment?: boolean;
  reasoning?: boolean;
  toolCall?: boolean;
  temperature?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; output?: number };
  thinkingConfig?: { mode?: string; defaultValue?: string };
  effortOptions?: string[];
}

export interface ByokProviderPresetView {
  providerId: string;
  name: string;
  baseUrl: string;
  apiFormat: ModelProviderApi;
  models: UserModelInputView[];
  iconUrl?: string;
}

export interface ModelProviderTestOutcome {
  ok: boolean;
  status: ModelCacheStatusView;
}

export interface UserModelProviderCandidateView {
  providerId?: string;
  expectedRevision?: string;
  name?: string;
  baseUrl: string;
  apiKey?: string;
  apiFormat?: string;
  models?: UserModelInputView[];
  headers?: Record<string, string>;
  removeHeaders?: string[];
}

export interface SaveUserModelProviderCandidateOutcome {
  ok: boolean;
  status?: ModelCacheStatusView;
  skippedTest?: boolean;
  provider?: ModelProviderView;
}

export interface ModelContextUpdateOutcome {
  ok: boolean;
  status?: ModelCacheStatusView;
}

export interface LocalModelProviderServiceDeps {
  configGetter: () => LocalRuntimeConfig;
  updateByokConfig: (
    mutate: (
      draft: LocalByokConfigDraft,
      currentConfig: LocalRuntimeConfig,
    ) => void | Promise<void>,
  ) => Promise<unknown>;
  cache: LocalModelCacheLike;
  tester: {
    test(dedupKey: string, target: ModelConnectionTestTarget): Promise<ModelConnectionTestResult>;
  };
  discoverer?: ModelDiscoveryClientLike;
  compareAndSetModelContext?: (
    input: {
      providerId: string;
      modelId: string;
      expectedContextLimit: number;
      contextLimit: number;
    },
    beforeCommit: (currentConfig: LocalRuntimeConfig) => Promise<boolean>,
  ) => Promise<boolean>;
  removeProviderCredentials?: (providerKey: string) => void | Promise<void>;
  selectModel: (modelKey: string) => Promise<void>;
  now?: () => number;
  randomHex?: () => string;
  /** Enables metadata-free thinking defaults only for the new TUI product. */
  implicitCustomProviderThinking?: boolean;
}
