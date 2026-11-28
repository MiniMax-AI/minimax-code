import {
  CUSTOM_PROVIDER_ID_PREFIX,
  MANAGED_MINIMAX_PROVIDER_ID,
  MINIMAX_API_PROVIDER_ID,
  listRouteModelIds,
  type ModelAvailabilityConfigView,
  type ModelAvailabilityProviderView,
} from './model-availability.js';
import type { PresetKey } from './config.js';
import { parseExplicitEnabled } from './prompt-suggestion-config.js';
import { isLegacyManagedMinimaxProvider } from './provider-auth-mode.js';

/**
 * The user's own choice for the global advisor switch, which the settings page and
 * `/advisor on|off` write. Absent means the user never chose; `resolveAdvisorEnabled` turns that
 * into the effective value.
 */
export interface AdvisorConfig {
  enabled?: boolean;
}

/** The `Config` fields this file owns, so `config.ts` does not grow for them. */
export interface AdvisorConfigFields {
  /** Advisor for new conversations (clients copy it in); set only through the advisor API. */
  defaultAdvisor?: DefaultAdvisorConfig;
  /** The global advisor switch; while it is off no Session uses or lists its advisor. */
  advisor?: AdvisorConfig;
}

export function parseAdvisorConfigFields(raw: Record<string, unknown>): AdvisorConfigFields {
  return {
    defaultAdvisor: parseDefaultAdvisorConfig(raw.defaultAdvisor),
    advisor: parseExplicitEnabled(raw.advisor),
  };
}

/** The catalog facts the switch's default reads, plus the user's own choice. */
export interface AdvisorSwitchConfigView extends ModelAvailabilityConfigView {
  readonly provider?: Readonly<
    Record<
      string,
      ModelAvailabilityProviderView & {
        readonly models?: Readonly<
          Record<string, { readonly enabled?: unknown; readonly advisorRecommended?: unknown }>
        >;
      }
    >
  >;
  readonly advisor?: { readonly enabled?: boolean };
}

/**
 * The switch's value while the user has not chosen, read from the models this config offers, so
 * it follows the catalog without any stored state. On when a provider of the user's own offers an
 * enabled model (a custom provider with the user's key, or a hand-configured provider), or when the official MiniMax catalog marks one of its
 * models `advisorRecommended`. The official MiniMax routes (sign-in, a MiniMax API key, a
 * generated legacy alias) offer the official catalog, which counts only through that mark. That
 * includes `provider.minimax` configured by hand with an API key, which the call routing
 * (`resolveModelCallRoute`) treats as a configured provider: its models are still MiniMax's own.
 */
export function resolveAdvisorDefaultEnabled(
  config: AdvisorSwitchConfigView,
  preset: PresetKey,
): boolean {
  const ownProviders = [
    ...Object.keys(config.provider ?? {}).filter(
      (id) => id !== MANAGED_MINIMAX_PROVIDER_ID && id !== MINIMAX_API_PROVIDER_ID,
    ),
    ...Object.entries(config.custom_provider ?? {})
      .map(([key, provider]) => ({ id: `${CUSTOM_PROVIDER_ID_PREFIX}${key}`, provider }))
      .filter(({ id, provider }) => !isLegacyManagedMinimaxProvider(id, baseUrlOf(provider)))
      .map(({ id }) => id),
  ];
  if (ownProviders.some((id) => listRouteModelIds(config, id, preset).length > 0)) return true;
  const official = config.provider?.[MANAGED_MINIMAX_PROVIDER_ID]?.models ?? {};
  return listRouteModelIds(config, MANAGED_MINIMAX_PROVIDER_ID, preset).some(
    (modelId) => official[modelId]?.advisorRecommended === true,
  );
}

function baseUrlOf(provider: ModelAvailabilityProviderView): string | undefined {
  const baseURL = provider.options?.baseURL;
  return typeof baseURL === 'string' ? baseURL : undefined;
}

/** The user's choice when there is one, else the catalog default; the build gate is the caller's. */
export function resolveAdvisorEnabled(config: AdvisorSwitchConfigView, preset: PresetKey): boolean {
  const explicit = config.advisor?.enabled;
  return typeof explicit === 'boolean' ? explicit : resolveAdvisorDefaultEnabled(config, preset);
}

/** Same shape as a Session's advisor selection; `enabled: false` may keep the stored model. */
export interface DefaultAdvisorConfig {
  readonly enabled: boolean;
  /** `providerId/modelId`. */
  readonly model?: string;
  readonly thinking?: { readonly effort: string };
  readonly contextWindow?: number;
}

/** Lenient like the other default-model fields: a malformed field is dropped on its own. */
export function parseDefaultAdvisorConfig(raw: unknown): DefaultAdvisorConfig | undefined {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.enabled !== 'boolean') return undefined;
  const model = typeof obj.model === 'string' && isModelKey(obj.model) ? obj.model : undefined;
  const effort =
    obj.thinking !== null && typeof obj.thinking === 'object'
      ? Reflect.get(obj.thinking, 'effort')
      : undefined;
  const contextWindow = obj.contextWindow;
  return {
    enabled: obj.enabled,
    ...(model ? { model } : {}),
    ...(typeof effort === 'string' && effort.trim() ? { thinking: { effort } } : {}),
    ...(isAdvisorContextWindow(contextWindow) ? { contextWindow } : {}),
  };
}

/** `providerId/modelId`; the model id may itself contain `/`. */
export function isModelKey(value: string): boolean {
  const slash = value.indexOf('/');
  return slash > 0 && slash < value.length - 1;
}

/** A positive window that fits the i32 the other default-model windows are held to. */
export function isAdvisorContextWindow(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 2_147_483_647;
}
