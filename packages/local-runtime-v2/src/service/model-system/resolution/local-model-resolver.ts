import {
  DEFAULT_LOCAL_PI_API,
  lookupLocalModelLimits,
  lookupLocalCatalogModel,
  positive,
} from '../../../infra/config/model-catalog.js';
import { type Api, type Model, type ThinkingLevelMap } from '@earendil-works/pi-ai';
import type { StreamFn, ThinkingLevel as PiThinkingLevel } from '@earendil-works/pi-agent-core';
import {
  knownMaxImagesPerRequestForBaseUrl,
  normalizeMaxImagesPerRequest,
  type ModelAudioInput,
  type ModelRequestImageLimit,
  type ModelRequestMediaSupport,
  type ModelThinkingPrefixBinding,
} from '@mavis/agent-core/pi-turn-runner';
import {
  isFirstPartyMinimaxMessagesRoute,
  resolveModelCallRoute,
  resolveProviderAuthMode,
  resolveProviderCredential,
  type ProviderAuthMode,
  type ProviderAuthModeSource,
} from '@mavis/config';
import { ThinkingLevel, type IAgentConfig, type IModelRef } from '@mavis/protocol';
import type { ManagedBackendRoutingContext } from '@mavis/agent-tools/desktop';
import { withOpenCodeGoHeaders, withOpenRouterAttributionHeaders } from '@mavis/shared';

import {
  ModelLoginRequiredError,
  type LocalModelCompatOverrides,
  type LocalModelResolveInput,
  type LocalModelResolverLike,
  type LocalModelResolverOptions,
  type LocalResolvedModelConfig,
  type LocalModelsConfig,
  type LocalProviderOptions,
} from '../contracts.js';
import type { LocalRuntimeAuthContext } from '../../../infra/config/auth-context.js';
import { normalizeProviderBaseUrl } from '../connectivity/provider-request.js';
import {
  isModelProviderApi,
  MANAGED_MINIMAX_PROVIDER_ID,
  MINIMAX_API_PROVIDER_ID,
  OPENAI_CODEX_PROVIDER_ID,
} from '../identity.js';
import { parseProviderId } from './model-key.js';
import {
  isMiniMaxM3ModelId,
  isMiniMaxM3ThinkingMode,
  type ByokThinkingProtocol,
  isThinkingEffortDisabled,
  type LocalModelRefCapabilities,
  modelLimitsFromConfig,
  readSelectedThinkingEffort,
  resolveByokThinkingProtocol,
  supportsJsonObjectOutput,
} from './model-ref.js';
import {
  planCustomProviderResolution,
  planMinimaxApiResolution,
  readStringRecord,
} from './model-resolver-byok.js';
import {
  buildLocalProviderHeaders,
  createManagedAuthRetryFetch,
  modelCallRouteView,
  readAgentHeaderId,
  stripUrlCredentials,
  turnPhaseHeaderFor,
} from './model-resolver-helpers.js';
import { hasOpenPlatformThinkingVariants } from './openplatform-thinking.js';
import { withByokErrorAttribution } from './byok-error-attribution.js';
import { withLocalDynamicMaxTokens } from './dynamic-max-tokens.js';
import { createByokKeyLifecycle } from '../byok-keys/key-lifecycle.js';
import { sharedByokKeyPool } from '../byok-keys/key-pool.js';
import { resolveLocalRequestBodyBytes } from './file-api-capabilities.js';
import { resolveLocalFileApiGatewayAuth } from './file-api-gateway-auth.js';
/** Strips trailing `char` repeats in linear time (no backtracking regex). */
function trimTrailingChar(value: string, char: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === char) end -= 1;
  return value.slice(0, end);
}

/**
 * Images per request for a model that declares none. The Messages API accepts
 * 100 on 200K-context models and 600 otherwise, OpenAI 1500; MiniMax M3 models
 * accept 20 and Mistral's API 8, recognized below.
 */
const LOCAL_DEFAULT_MAX_IMAGES_PER_REQUEST = 100;
const MINIMAX_M3_MAX_IMAGES_PER_REQUEST = 20;
const MINIMAX_M3_FAMILY = /^minimax-m3(?:[.-]|$)/iu;
export const MANAGED_PROVIDER_API_KEY_PLACEHOLDER = 'sk-xxx';

const THINKING_LEVEL_TO_PI: Record<ThinkingLevel, PiThinkingLevel> = {
  [ThinkingLevel.OFF]: 'off',
  [ThinkingLevel.MINIMAL]: 'minimal',
  [ThinkingLevel.LOW]: 'low',
  [ThinkingLevel.MEDIUM]: 'medium',
  [ThinkingLevel.HIGH]: 'high',
  [ThinkingLevel.XHIGH]: 'xhigh',
};

interface ModelIdentity {
  readonly modelRef: IModelRef;
  readonly provider: string;
  readonly modelId: string;
}

type ByokResolutionPlan = NonNullable<ReturnType<typeof planMinimaxApiResolution>>;

interface SelectedModel {
  readonly identity: ModelIdentity;
  readonly byokPlan?: ByokResolutionPlan;
  readonly route?: string;
}

interface FinishResolveInput extends ModelIdentity {
  readonly sessionId: string;
  readonly turnId: string;
  readonly agentConfig: IAgentConfig;
  readonly api: Api;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly managedProvider: boolean;
  readonly byokProvider: boolean;
  readonly customProvider: boolean;
  readonly runtimeProvider?: string;
  readonly configHeaders?: Record<string, string>;
  readonly modelCompat?: LocalModelCompatOverrides;
  readonly thinkingCapable?: true;
  readonly catalogModel?: Model<Api>;
  readonly authContext?: LocalRuntimeAuthContext;
  readonly routingContext?: ManagedBackendRoutingContext;
}

export class LocalModelResolver implements LocalModelResolverLike {
  private readonly defaultApi: Api;

  constructor(private readonly options: LocalModelResolverOptions = {}) {
    this.defaultApi = options.defaultApi ?? DEFAULT_LOCAL_PI_API;
  }

  async resolveModel(input: LocalModelResolveInput): Promise<LocalResolvedModelConfig> {
    const identity = requireModelIdentity(input.agentConfig);
    const providerConfig = this.options.providerConfigGetter?.() ?? this.options.providerConfig;
    const resolved = await this.resolveConfiguredModel(input, providerConfig);
    // A metric label only, so dashboards tell managed Token Plan calls from the user's keys.
    const route = resolveModelCallRoute(
      modelCallRouteView(providerConfig, this.options.byokConfigGetter?.()),
      identity.provider,
    );
    return { ...resolved, route, ...turnPhaseHeaderFor(route) };
  }

  private async resolveConfiguredModel(
    input: LocalModelResolveInput,
    providerConfig: LocalModelsConfig | undefined,
  ): Promise<LocalResolvedModelConfig> {
    const selected = selectModel(input.agentConfig, providerConfig, this.options);
    if (selected.byokPlan) return this.finishByok(input, selected);
    const switched = selectMinimaxByok(selected.identity, providerConfig, this.options);
    if (switched.byokPlan) return this.finishByok(input, switched);
    return this.resolveManagedModel(input, switched.identity, providerConfig);
  }


  private async finishByok(
    input: LocalModelResolveInput,
    selected: SelectedModel,
  ): Promise<LocalResolvedModelConfig> {
    const plan = selected.byokPlan;
    if (!plan || !selected.route) {
      throw new Error('LocalModelResolver: incomplete BYOK resolution plan');
    }
    const { apiKeys, ...resolvedPlan } = await resolveByokResolutionPlan(plan, this.options);
    this.logRoute(selected.identity.provider, selected.identity.modelId, selected.route);
    const resolved = this.finishResolve({
      sessionId: input.sessionId,
      turnId: input.turnId,
      agentConfig: input.agentConfig,
      ...selected.identity,
      managedProvider: false,
      byokProvider: true,
      customProvider: selected.route === 'custom_provider' && !plan.authProvider,
      ...(plan.runtimeProvider
        ? {
            catalogModel: lookupLocalCatalogModel(plan.runtimeProvider, selected.identity.modelId),
          }
        : {}),
      ...resolvedPlan,
    });
    return apiKeys ? this.withApiKeys(resolved, apiKeys, selected.identity.provider) : resolved;
  }

  /**
   * Several enabled keys: the call picks one per request. The first key not resting stands in
   * for hooks that read `apiKey` outside the call.
   */
  private withApiKeys(
    resolved: LocalResolvedModelConfig,
    apiKeys: NonNullable<ByokResolutionPlan['apiKeys']>,
    providerName: string,
  ): LocalResolvedModelConfig {
    const pool = this.options.byokKeyPool ?? sharedByokKeyPool();
    const first = pool.pick(apiKeys.providerKey, apiKeys.keys);
    return {
      ...resolved,
      ...(first ? { apiKey: first.value } : {}),
      callLifecycle: createByokKeyLifecycle({
        pool,
        providerKey: apiKeys.providerKey,
        providerName,
        keys: apiKeys.keys,
      }),
    };
  }

  private async resolveManagedModel(
    input: LocalModelResolveInput,
    identity: ModelIdentity,
    providerConfig: LocalModelsConfig | undefined,
  ): Promise<LocalResolvedModelConfig> {
    const { provider, modelId, modelRef } = identity;
    const currentAuthContext = this.options.authContextGetter?.();
    const authContext = currentAuthContext ? { ...currentAuthContext } : undefined;
    const routingContext = this.options.routingContextGetter?.();
    const credentials = resolveLocalProviderCredentials(
      provider,
      modelRef,
      providerConfig,
      authContext,
    );
    const limits = managedModelLimits(provider, modelId, providerConfig);
    const openAiCodex = provider === OPENAI_CODEX_PROVIDER_ID;
    const apiKey = await resolveProviderApiKey(provider, credentials.apiKey, this.options);
    const baseUrl = credentials.baseUrl ?? (openAiCodex ? limits.baseUrl : undefined);
    const usable = requireUsableCredentials(provider, apiKey, baseUrl, credentials);
    this.logRoute(provider, modelId, providerRouteForAuthMode(credentials.authMode));
    return this.finishResolve({
      sessionId: input.sessionId,
      turnId: input.turnId,
      agentConfig: input.agentConfig,
      ...identity,
      api: limits.api ?? this.defaultApi,
      apiKey: usable.apiKey,
      baseUrl: usable.baseUrl,
      contextWindow: limits.contextWindow,
      maxTokens: limits.maxTokens,
      managedProvider: credentials.authMode === 'managed-login',
      byokProvider: credentials.authMode === 'oauth',
      customProvider: false,
      configHeaders: credentials.headers,
      catalogModel: lookupLocalCatalogModel(provider, modelId),
      ...(authContext ? { authContext } : {}),
      ...(routingContext ? { routingContext } : {}),
    });
  }

  private finishResolve(input: FinishResolveInput): LocalResolvedModelConfig {
    const contextWindow = positive(input.modelRef.context_window) || input.contextWindow;
    const maxTokens = positive(input.modelRef.max_tokens) || input.maxTokens;
    const thinking = resolveThinking(input, this.options.implicitCustomProviderThinking === true);
    const baseUrl = normalizeResolvedBaseUrl(input.api, input.baseUrl);
    const maxRequestBodyBytes = resolveLocalRequestBodyBytes(input.modelRef.capabilities, {
      api: input.api,
      baseUrl,
    });
    const model = buildResolvedModel({ input, contextWindow, maxTokens, baseUrl, thinking });
    const streamFn = resolveModelStream(input, this.options.streamFn);
    const fileApiGatewayAuth = input.managedProvider
      ? resolveLocalFileApiGatewayAuth(input.authContext, input.routingContext)
      : undefined;
    const fetchImpl = resolveModelFetch(input, this.options);
    this.options.logger?.info(
      {
        sessionId: input.sessionId,
        provider: input.provider,
        modelId: input.modelId,
        api: input.api,
        baseUrl,
        managed: input.managedProvider,
        contextWindow,
        maxTokens,
        reasoning: thinking.enabled,
      },
      'Resolved local conversation model',
    );
    return {
      model,
      managedProvider: input.managedProvider,
      supportsJsonObjectOutput: supportsJsonObjectOutput(input.modelRef),
      apiKey: input.apiKey,
      maxTokens,
      maxRequestBodyBytes,
      headers: buildLocalProviderHeaders({
        headers: withOpenCodeGoHeaders(
          baseUrl,
          withOpenRouterAttributionHeaders(baseUrl, input.configHeaders),
          input.sessionId,
        ),
        managedProvider: input.managedProvider,
        routingContext: input.routingContext,
        sessionId: input.sessionId,
        turnId: input.turnId,
        agentId: readAgentHeaderId(input.agentConfig),
      }),
      ...(fileApiGatewayAuth ? { fileApiGatewayAuth } : {}),
      ...(streamFn ? { streamFn } : {}),
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
      ...(thinking.exposedLevel ? { thinkingLevel: thinking.exposedLevel } : {}),
      ...(thinking.requestPatch ? { thinkingRequestPatch: thinking.requestPatch } : {}),
    };
  }

  private logRoute(provider: string, modelId: string, route: string): void {
    this.options.logger?.info(
      { provider, modelId, route },
      'Resolved local conversation model route',
    );
  }
}

function resolveModelFetch(
  input: FinishResolveInput,
  options: LocalModelResolverOptions,
): LocalResolvedModelConfig['fetch'] {
  return input.managedProvider
    ? createManagedAuthRetryFetch({ ...options, authContext: input.authContext })
    : options.fetchImpl;
}

function selectModel(
  agentConfig: IAgentConfig,
  providerConfig: LocalModelsConfig | undefined,
  options: LocalModelResolverOptions,
): SelectedModel {
  const identity = requireModelIdentity(agentConfig);
  const parsed = parseProviderId(identity.provider);
  if (!parsed || parsed.source === 'provider') return { identity };
  const byokPlan = selectExternalByokPlan(identity, parsed, providerConfig, options);
  if (byokPlan) return { identity, byokPlan, route: parsed.source };
  // byok-v2 §8: a deleted provider, a disabled or removed model, or a missing
  // connection is a configuration error; never switch to another provider.
  throw unavailableByokModelError(identity.provider, identity.modelId);
}

function unavailableByokModelError(provider: string, modelId: string): Error {
  return new Error(
    `LocalModelResolver: BYOK model configuration "${provider}/${modelId}" is unavailable or disabled.`,
  );
}

function requireModelIdentity(agentConfig: IAgentConfig): ModelIdentity {
  const modelRef = agentConfig.model;
  if (!modelRef) throw new Error('LocalModelResolver: agentConfig.model is required');
  const provider = modelRef.provider?.trim() ?? '';
  const modelId = modelRef.model_id?.trim() ?? '';
  if (!provider) throw new Error('LocalModelResolver: ModelRef.provider is required');
  if (!modelId) throw new Error('LocalModelResolver: ModelRef.model_id is required');
  return { modelRef, provider, modelId };
}

function selectExternalByokPlan(
  identity: ModelIdentity,
  parsed: NonNullable<ReturnType<typeof parseProviderId>>,
  providerConfig: LocalModelsConfig | undefined,
  options: LocalModelResolverOptions,
): ByokResolutionPlan | undefined {
  if (parsed.source === 'minimax_api') {
    return planMinimaxApiResolution({
      byok: options.byokConfigGetter?.(),
      providerConfig,
      modelId: identity.modelId,
      catalog: lookupLocalModelLimits(MANAGED_MINIMAX_PROVIDER_ID, identity.modelId),
    });
  }
  return planCustomProviderResolution({
    byok: options.byokConfigGetter?.(),
    provider: identity.provider,
    providerKey: parsed.providerKey,
    modelId: identity.modelId,
  });
}

/**
 * Default limits of a managed model: the configured `limit` first, the built-in
 * catalog as fallback. Ordinary turns already carry the selected window on the
 * ModelRef; callers that pass only a model identity (Memory V2) get the window
 * the user configured instead of the catalog fallback, the same source the
 * BYOK path reads.
 */
function managedModelLimits(
  provider: string,
  modelId: string,
  providerConfig: LocalModelsConfig | undefined,
): ReturnType<typeof lookupLocalModelLimits> {
  const catalog = lookupLocalModelLimits(provider, modelId);
  const configured = modelLimitsFromConfig(providerConfig?.[provider]?.models?.[modelId]);
  return {
    ...catalog,
    contextWindow: positive(configured.context_window) || catalog.contextWindow,
    maxTokens: positive(configured.max_tokens) || catalog.maxTokens,
  };
}

function selectMinimaxByok(
  identity: ModelIdentity,
  providerConfig: LocalModelsConfig | undefined,
  options: LocalModelResolverOptions,
): SelectedModel {
  const byok = options.byokConfigGetter?.();
  if (
    identity.provider !== MANAGED_MINIMAX_PROVIDER_ID ||
    byok?.minimaxModelSource !== 'minimax_api_key'
  ) {
    return { identity };
  }
  const byokPlan = planMinimaxApiResolution({
    byok,
    providerConfig,
    modelId: identity.modelId,
    catalog: lookupLocalModelLimits(MANAGED_MINIMAX_PROVIDER_ID, identity.modelId),
  });
  // The user chose their own MiniMax API key; managed login is not a fallback.
  if (!byokPlan) throw unavailableByokModelError(MINIMAX_API_PROVIDER_ID, identity.modelId);
  return { identity, byokPlan, route: 'minimax_api_key' };
}

async function resolveProviderApiKey(
  provider: string,
  configuredApiKey: string | undefined,
  options: LocalModelResolverOptions,
): Promise<string | undefined> {
  if (provider !== OPENAI_CODEX_PROVIDER_ID) return configuredApiKey;
  const apiKey = (await options.providerAuthGetter?.(provider))?.trim();
  if (!apiKey) throw new ModelLoginRequiredError(provider);
  return apiKey;
}

type ResolvedByokResolutionPlan = Omit<ByokResolutionPlan, 'apiKey' | 'authProvider'> & {
  readonly apiKey: string;
};

async function resolveByokResolutionPlan(
  plan: ByokResolutionPlan,
  options: LocalModelResolverOptions,
): Promise<ResolvedByokResolutionPlan> {
  const { authProvider, apiKey: configuredApiKey, ...resolved } = plan;
  const apiKey = (
    authProvider ? await options.providerAuthGetter?.(authProvider) : configuredApiKey
  )?.trim();
  if (!apiKey) {
    if (authProvider) throw new ModelLoginRequiredError(authProvider);
    throw new Error(`LocalModelResolver: api_key not configured for provider "${plan.provider}".`);
  }
  return { ...resolved, apiKey };
}

interface ResolvedThinking {
  readonly enabled: boolean;
  /**
   * Thinking is off for a thinking-capable model on a protocol whose Pi
   * transport sends the disabled thinking config itself (Gemini). Pi only does
   * that for a reasoning model; other protocols disable through `requestPatch`.
   */
  readonly transportDisablesThinking?: true;
  readonly openPlatform: boolean;
  readonly exposedLevel?: PiThinkingLevel;
  readonly maxLevel?: string;
  readonly thinkingLevelMap?: ThinkingLevelMap;
  readonly requestPatch?: Readonly<Record<string, unknown>>;
  readonly forceAdaptiveThinking?: true;
  readonly completionsThinkingCompat?: {
    readonly thinkingFormat: 'openai';
    readonly supportsReasoningEffort: true;
  };
}

interface ThinkingResolutionContext {
  readonly enabled: boolean;
  readonly openPlatform: boolean;
  readonly protocolThinking?: ByokThinkingProtocol;
  readonly piLevel?: PiThinkingLevel;
  readonly shouldExposeLevel: boolean;
  readonly maxLevel?: string;
}

function resolveThinking(
  input: FinishResolveInput,
  implicitCustomProviderThinking: boolean,
): ResolvedThinking {
  const context = resolveThinkingContext(input, implicitCustomProviderThinking);
  return {
    enabled: context.enabled,
    openPlatform: context.openPlatform,
    ...(transportDisablesThinking(input, context) ? { transportDisablesThinking: true } : {}),
    ...exposedThinkingLevel(context),
    ...thinkingLevelMapFields(context),
    ...thinkingRequestPatchFields(context),
    ...maxThinkingLevelFields(context),
    ...thinkingCompatibilityFields(context),
  };
}

function transportDisablesThinking(
  input: FinishResolveInput,
  context: ThinkingResolutionContext,
): boolean {
  if (input.api !== 'google-generative-ai' || context.enabled) return false;
  return context.protocolThinking?.enabled === false || input.thinkingCapable === true;
}

function resolveThinkingContext(
  input: FinishResolveInput,
  implicitCustomProviderThinking: boolean,
): ThinkingResolutionContext {
  const thinkingLevel = input.modelRef.thinking_level;
  const thinkingToggleOn = isThinkingToggleOn(thinkingLevel);
  const selectedEffort =
    input.modelRef.thinking_effort ??
    readSelectedThinkingEffort(input.modelRef.capabilities as Record<string, unknown> | undefined);
  const protocolThinking = resolveConfiguredThinkingProtocol(
    input,
    thinkingToggleOn,
    selectedEffort,
  );
  const openPlatform = hasOpenPlatformThinkingVariants(input.modelRef);
  const enabled = resolveThinkingEnabled({
    customProvider: input.customProvider,
    implicitCustomProviderThinking,
    openPlatform,
    thinkingToggleOn,
    selectedEffort,
    protocolThinking,
  });
  return {
    enabled,
    openPlatform,
    ...(protocolThinking ? { protocolThinking } : {}),
    ...resolvePiThinkingLevel({
      enabled,
      protocolThinking,
      selectedEffort,
      thinkingLevel,
      modelId: input.modelId,
    }),
    shouldExposeLevel: shouldExposeThinkingLevel({
      input,
      enabled,
      protocolThinking,
      openPlatform,
      implicitCustomProviderThinking,
    }),
    ...resolveCatalogMaxThinkingLevel(selectedEffort, input.catalogModel),
  };
}

function isThinkingToggleOn(thinkingLevel: ThinkingLevel | undefined): boolean {
  return thinkingLevel !== undefined && thinkingLevel !== ThinkingLevel.OFF;
}

function resolveConfiguredThinkingProtocol(
  input: FinishResolveInput,
  thinkingToggleOn: boolean,
  selectedEffort: string | undefined,
): ByokThinkingProtocol | undefined {
  const configurable = input.customProvider || input.api === 'openai-codex-responses';
  if (!configurable || (!thinkingToggleOn && !selectedEffort)) return undefined;
  const api = supportedByokThinkingApi(input.api);
  return api ? resolveByokThinkingProtocol(api, selectedEffort, input.modelId) : undefined;
}

function supportedByokThinkingApi(api: Api): Api | undefined {
  return isModelProviderApi(api) || api === 'openai-codex-responses' ? api : undefined;
}

function resolveThinkingEnabled(input: {
  readonly customProvider: boolean;
  readonly implicitCustomProviderThinking: boolean;
  readonly openPlatform: boolean;
  readonly thinkingToggleOn: boolean;
  readonly selectedEffort?: string;
  readonly protocolThinking?: ByokThinkingProtocol;
}): boolean {
  if (isThinkingEffortDisabled(input.selectedEffort)) return false;
  if (input.selectedEffort) return true;
  if (!input.customProvider || input.openPlatform) return input.thinkingToggleOn;
  if (input.protocolThinking) return input.protocolThinking.enabled !== false;
  return input.implicitCustomProviderThinking && input.thinkingToggleOn;
}

function resolvePiThinkingLevel(input: {
  readonly enabled: boolean;
  readonly protocolThinking: ByokThinkingProtocol | undefined;
  readonly selectedEffort: string | undefined;
  readonly thinkingLevel: ThinkingLevel | undefined;
  readonly modelId: string;
}): Pick<ThinkingResolutionContext, 'piLevel'> {
  if (!input.enabled) return {};
  const piLevel =
    input.protocolThinking?.piLevel ??
    selectedEffortPiLevel(input.selectedEffort, input.thinkingLevel, input.modelId) ??
    piThinkingLevelFor(input.thinkingLevel);
  return piLevel ? { piLevel } : {};
}

function selectedEffortPiLevel(
  selectedEffort: string | undefined,
  thinkingLevel: ThinkingLevel | undefined,
  modelId: string | undefined,
): PiThinkingLevel | undefined {
  if (isMiniMaxM3ModelId(modelId) && isMiniMaxM3ThinkingMode(selectedEffort)) {
    return piThinkingLevelFor(thinkingLevel);
  }
  return selectedEffort as PiThinkingLevel | undefined;
}

function piThinkingLevelFor(thinkingLevel: ThinkingLevel | undefined): PiThinkingLevel | undefined {
  return thinkingLevel === undefined ? undefined : THINKING_LEVEL_TO_PI[thinkingLevel];
}

function shouldExposeThinkingLevel(options: {
  readonly input: FinishResolveInput;
  readonly enabled: boolean;
  readonly protocolThinking?: ByokThinkingProtocol;
  readonly openPlatform: boolean;
  readonly implicitCustomProviderThinking: boolean;
}): boolean {
  if (!options.enabled) return false;
  return (
    options.protocolThinking !== undefined ||
    options.input.api !== 'anthropic-messages' ||
    options.openPlatform ||
    (options.implicitCustomProviderThinking && options.input.customProvider)
  );
}

function resolveCatalogMaxThinkingLevel(
  selectedEffort: string | undefined,
  catalogModel: Model<Api> | undefined,
): Pick<ThinkingResolutionContext, 'maxLevel'> {
  const maxLevel = catalogModel?.thinkingLevelMap?.max;
  return selectedEffort === 'max' && typeof maxLevel === 'string' ? { maxLevel } : {};
}

function exposedThinkingLevel(
  context: ThinkingResolutionContext,
): Pick<ResolvedThinking, 'exposedLevel'> {
  return context.shouldExposeLevel && context.piLevel ? { exposedLevel: context.piLevel } : {};
}

function thinkingLevelMapFields(
  context: ThinkingResolutionContext,
): Pick<ResolvedThinking, 'thinkingLevelMap'> {
  return (context.enabled || context.protocolThinking?.enabled === false) &&
    context.protocolThinking
    ? { thinkingLevelMap: context.protocolThinking.thinkingLevelMap }
    : {};
}

function thinkingRequestPatchFields(
  context: ThinkingResolutionContext,
): Pick<ResolvedThinking, 'requestPatch'> {
  return context.protocolThinking ? { requestPatch: context.protocolThinking.requestPatch } : {};
}

function maxThinkingLevelFields(
  context: ThinkingResolutionContext,
): Pick<ResolvedThinking, 'maxLevel'> {
  return context.maxLevel ? { maxLevel: context.maxLevel } : {};
}

function thinkingCompatibilityFields(
  context: ThinkingResolutionContext,
): Pick<ResolvedThinking, 'forceAdaptiveThinking' | 'completionsThinkingCompat'> {
  if (!context.enabled || !context.protocolThinking) return {};
  if (context.protocolThinking.forceAdaptiveThinking) return { forceAdaptiveThinking: true };
  if (context.protocolThinking.completionsThinkingFormat === 'openai') {
    return {
      completionsThinkingCompat: {
        thinkingFormat: 'openai',
        supportsReasoningEffort: true,
      },
    };
  }
  return {};
}

function normalizeResolvedBaseUrl(api: Api, baseUrl: string): string {
  return isModelProviderApi(api)
    ? normalizeProviderBaseUrl(api, baseUrl)
    : trimTrailingChar(baseUrl, '/');
}

function buildResolvedModel(scope: {
  readonly input: FinishResolveInput;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly baseUrl: string;
  readonly thinking: ResolvedThinking;
}): Model<Api> {
  const { input, contextWindow, maxTokens, baseUrl, thinking } = scope;
  const thinkingLevelMap = resolvedThinkingLevelMap(thinking);
  const compat = resolvedModelCompatibility(input, thinking);
  const capabilities = input.modelRef.capabilities as LocalModelRefCapabilities | undefined;
  const maxImagesPerRequest =
    normalizeMaxImagesPerRequest(capabilities?.max_images_per_request) ??
    knownMaxImagesPerRequestForBaseUrl(baseUrl) ??
    (MINIMAX_M3_FAMILY.test(input.modelId.trim())
      ? MINIMAX_M3_MAX_IMAGES_PER_REQUEST
      : LOCAL_DEFAULT_MAX_IMAGES_PER_REQUEST);
  const model: Model<Api> &
    ModelRequestImageLimit &
    ModelRequestMediaSupport &
    ModelThinkingPrefixBinding &
    ModelAudioInput = {
    id: input.modelId,
    name: input.modelId,
    api: input.api,
    provider: input.runtimeProvider ?? input.provider,
    baseUrl,
    reasoning: thinking.enabled || thinking.transportDisablesThinking === true,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    input: deriveModelInput(input.modelRef),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    ...(compat ? { compat } : {}),
    // Request builders read this from the model so agent turns, compaction
    // checkpoints and footprint estimates share one image ceiling (#425).
    ...(maxImagesPerRequest === undefined ? {} : { maxImagesPerRequest }),
    ...modelMediaFlags(capabilities),
  };
  return model;
}

function modelMediaFlags(
  capabilities: LocalModelRefCapabilities | undefined,
): ModelRequestMediaSupport & ModelThinkingPrefixBinding & ModelAudioInput {
  const thinkingPrefixBinding = capabilities?.thinking_prefix_binding;
  return {
    // A model that cannot hear gets videos without their audio track.
    ...(capabilities?.support_audio === true ? { audioInput: true } : {}),
    // `input` folds video into `image` (see deriveModelInput); these flags keep
    // the two apart so request projection drops history media this model
    // cannot accept — videos for an image-only model, still images for a
    // video-only model — on the request copy, never in history.
    supportsImageInput: capabilities?.support_image === true,
    supportsVideoInput: capabilities?.support_video === true,
    // A declared value overrides the model-id inference in
    // `hasThinkingPrefixBinding`, which every prefix-protecting step reads.
    ...(typeof thinkingPrefixBinding === 'boolean' ? { thinkingPrefixBinding } : {}),
  };
}

function resolvedThinkingLevelMap(thinking: ResolvedThinking): ThinkingLevelMap | undefined {
  if (thinking.thinkingLevelMap) return thinking.thinkingLevelMap;
  return thinking.maxLevel ? { max: thinking.maxLevel } : undefined;
}

function resolvedModelCompatibility(
  input: FinishResolveInput,
  thinking: ResolvedThinking,
): Model<Api>['compat'] | undefined {
  let thinkingCompat: Model<Api>['compat'] | undefined = thinking.completionsThinkingCompat;
  if (
    thinking.forceAdaptiveThinking ||
    (input.api === 'anthropic-messages' && thinking.openPlatform && thinking.enabled)
  ) {
    thinkingCompat = { forceAdaptiveThinking: true };
  }
  const firstPartyMinimaxMessages = isFirstPartyMinimaxMessagesRoute(input.api, input.provider);
  const base = firstPartyMinimaxMessages
    ? { ...thinkingCompat, supportsLongCacheRetention: false }
    : thinkingCompat;
  // Pi applies any field present on `model.compat` ahead of its own provider/baseUrl
  // detection, so a provider config that declares its upstream protocol surface wins
  // over a fingerprint the gateway host has already masked.
  if (!input.modelCompat) return base;
  return { ...base, ...input.modelCompat };
}

function resolveModelStream(
  input: FinishResolveInput,
  streamFn: StreamFn | undefined,
): StreamFn | undefined {
  const dynamicStream = withLocalDynamicMaxTokens(streamFn);
  if (!input.byokProvider) return dynamicStream;
  return withByokErrorAttribution({
    providerId: input.provider,
    ...(dynamicStream ? { streamFn: dynamicStream } : {}),
  });
}

export function resolveLocalProviderCredentials(
  provider: string,
  modelRef: IModelRef,
  providerConfig?: LocalModelsConfig,
  authContext?: LocalRuntimeAuthContext,
): {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly headers?: Record<string, string>;
  readonly rawProviderOptions?: LocalProviderOptions;
  readonly authMode: ProviderAuthMode;
  readonly authModeSource: ProviderAuthModeSource;
  readonly managedBaseURL: boolean;
  readonly warnings: string[];
} {
  const options = providerConfig?.[provider]?.options;
  const configuredBaseUrl = modelRef.base_url?.trim() || options?.baseURL?.trim();
  const auth = resolveProviderAuthMode({
    authMode: options?.authMode,
    baseURL: configuredBaseUrl,
  });
  const optionHeaders = readStringRecord(options?.headers);
  const modelHeaders = readStringRecord(
    providerConfig?.[provider]?.models?.[modelRef.model_id?.trim() ?? '']?.headers,
  );
  const token = authContext?.accessToken?.trim();
  const headers = resolveCredentialHeaders(optionHeaders, modelHeaders, token, auth.authMode);
  return {
    apiKey: resolveCredentialApiKey(provider, modelRef, options, auth.authMode),
    baseUrl: resolveCredentialBaseUrl(configuredBaseUrl, auth.managedBaseURL),
    ...(headers ? { headers } : {}),
    ...(options ? { rawProviderOptions: options } : {}),
    authMode: auth.authMode,
    authModeSource: auth.source,
    managedBaseURL: auth.managedBaseURL,
    warnings: auth.warnings,
  };
}

function resolveCredentialApiKey(
  provider: string,
  modelRef: IModelRef,
  options: LocalProviderOptions | undefined,
  authMode: ProviderAuthMode,
): string | undefined {
  const configured =
    resolveProviderCredential({
      field: 'api_key',
      provider,
      value: modelRef.api_key,
    }) ??
    resolveProviderCredential({
      field: 'options.apiKey',
      provider,
      value: options?.apiKey,
    });
  if (configured) return configured;
  return authMode === 'managed-login' ? MANAGED_PROVIDER_API_KEY_PLACEHOLDER : undefined;
}

function providerRouteForAuthMode(authMode: ProviderAuthMode): string {
  if (authMode === 'managed-login') return 'token_plan';
  if (authMode === 'oauth') return 'oauth';
  return 'provider_api_key';
}

function resolveCredentialBaseUrl(
  configuredBaseUrl: string | undefined,
  managedBaseUrl: boolean,
): string | undefined {
  if (!configuredBaseUrl) return undefined;
  return managedBaseUrl ? stripUrlCredentials(configuredBaseUrl) : configuredBaseUrl;
}

function resolveCredentialHeaders(
  optionHeaders: Record<string, string> | undefined,
  modelHeaders: Record<string, string> | undefined,
  token: string | undefined,
  authMode: ProviderAuthMode,
): Record<string, string> | undefined {
  if (!optionHeaders && !modelHeaders && !token) return undefined;
  const managedToken = authMode === 'managed-login' ? token : undefined;
  return {
    ...optionHeaders,
    ...modelHeaders,
    ...(managedToken ? { Authorization: `Bearer ${managedToken}` } : {}),
  };
}

function requireUsableCredentials(
  provider: string,
  apiKey: string | undefined,
  baseUrl: string | undefined,
  credentials: ReturnType<typeof resolveLocalProviderCredentials>,
): { readonly apiKey: string; readonly baseUrl: string } {
  if (!apiKey) {
    throw new Error(
      provider === OPENAI_CODEX_PROVIDER_ID
        ? 'LocalModelResolver: openai-codex login required; no OAuth credentials found.'
        : `LocalModelResolver: api_key not configured for provider "${provider}".`,
    );
  }
  if (!baseUrl) {
    throw new Error(`LocalModelResolver: base_url not configured for provider "${provider}".`);
  }
  if (credentials.authMode === 'managed-login' && !credentials.managedBaseURL) {
    throw new Error(
      `LocalModelResolver: managed-login requires a known managed base_url for provider "${provider}".`,
    );
  }
  if (
    credentials.authMode === 'managed-login' &&
    apiKey === MANAGED_PROVIDER_API_KEY_PLACEHOLDER &&
    !credentials.headers?.Authorization
  ) {
    throw new Error(
      `LocalModelResolver: managed OAuth bearer is not synced for provider "${provider}".`,
    );
  }
  return { apiKey, baseUrl };
}

/**
 * Pi has one binary input flag, `image`: its transports keep or drop every
 * inline media block (image, video, audio, PDF) on it, so a model that accepts
 * any of them needs `'image'` here. Videos travel as `image` blocks with a
 * `video/*` mimeType; a video-only model therefore still needs `'image'` or its
 * supported videos would be dropped before the payload patcher turns them into
 * video blocks. Still images or videos such a model cannot accept are dropped
 * earlier, by agent-core's request projection, from `supportsImageInput` /
 * `supportsVideoInput` on the resolved model.
 */
function deriveModelInput(modelRef: IModelRef): Model<Api>['input'] {
  const capabilities = modelRef.capabilities as LocalModelRefCapabilities | undefined;
  return capabilities?.support_image ||
    capabilities?.support_video ||
    capabilities?.support_audio ||
    capabilities?.support_pdf
    ? ['text', 'image']
    : ['text'];
}
