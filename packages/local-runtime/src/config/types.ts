import type { AsrConfig, Config, ModelConfig, ProviderAuthMode } from '@mavis/config';

type LocalModelLimit = Partial<NonNullable<ModelConfig['limit']>>;
type LocalModelModalities = Partial<NonNullable<ModelConfig['modalities']>>;
type LocalModelCapabilities = Partial<{
  support_image: boolean;
  support_video: boolean;
  support_files_api: boolean;
  /** Legacy local config alias; normalized once at the model-ref boundary. */
  use_file_api: boolean;
  files_api_upload_endpoint: string;
  files_api_ref_scheme: string;
  files_api_file_id_ttl_sec: number;
  max_image_bytes_inline: number | string;
  max_video_bytes_inline: number | string;
  max_request_body_bytes: number | string;
  max_attachments_count: number | string;
}>;

export interface LocalProviderOptions {
  apiKey?: string;
  baseURL?: string;
  authMode?: ProviderAuthMode;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

export interface LocalModelConfig extends Omit<
  Partial<ModelConfig>,
  'limit' | 'modalities' | 'capabilities'
> {
  reasoning?: boolean;
  capabilities?: LocalModelCapabilities;
  limit?: LocalModelLimit;
  modalities?: LocalModelModalities;
}

export interface LocalProviderConfig {
  api?: string;
  name?: string;
  options?: LocalProviderOptions;
  models?: Record<string, LocalModelConfig>;
  model_order?: string[];
}

export type LocalModelsConfig = Record<string, LocalProviderConfig>;

/** BYOK: user's own MiniMax API key (mirrors `MinimaxApiConfig` in @mavis/config). */
export interface LocalMinimaxApiConfig {
  apiKey?: string;
  baseURL?: string;
  /** Hand-edited request headers; values may contain credentials and must not be displayed. */
  headers?: Record<string, string>;
  modelContextLimits?: Record<string, number>;
}

/** BYOK: user-created external provider (mirrors `CustomProviderConfig` in @mavis/config). */
export interface LocalCustomProviderConfig extends LocalProviderConfig {
  name?: string;
  kind?: string;
  /** Legacy adapter metadata. User saves remove it from custom providers. */
  npm?: string;
  enabled?: boolean;
}

export type LocalCustomProvidersConfig = Record<string, LocalCustomProviderConfig>;
export type LocalBetaConfig = Partial<Config['beta']>;

export interface LocalRuntimeConfig {
  provider: LocalModelsConfig;
  /** BYOK trees — read-only here; written only via the ModelProvider API. */
  minimax_api?: LocalMinimaxApiConfig;
  custom_provider?: LocalCustomProvidersConfig;
  minimaxModelSource?: 'token_plan' | 'minimax_api_key';
  defaultModel?: string;
  defaultModelVariant?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'auto' | 'off';
  /** Permission policy rollout; omitted local views inherit the config default. */
  permission?: Partial<Config['permission']>;
  dataDir: string;
  /**
   * Directory that startup seeds bundled builtin skills into. Defaults to
   * `<dataDir>/.builtin-skills` when unset (mirrors daemon `config.builtinSkillsDir`).
   */
  builtinSkillsDir?: string;
  beta?: LocalBetaConfig;
  agents?: Config['agents'];
  skills?: Config['skills'];
  asr?: Partial<AsrConfig>;
  contentReview?: Config['contentReview'];
  review?: Config['review'];
  /** Read-only projection. Sandbox writes use the dedicated transaction endpoint. */
  sandbox?: Config['sandbox'];
  askUser?: Config['askUser'];
  promptConfig?: Config['promptConfig'];
  runawayGuard?: Config['runawayGuard'];
  toolResultCompaction?: Config['toolResultCompaction'];
  mcp?: {
    nativeToolAllowlist?: string[];
  };
  mcpToolSearch?: {
    enabled?: boolean;
    modelWhitelist?: string[];
    thresholdPct?: number;
    minDeferCount?: number;
    topKDefault?: number;
    topKMax?: number;
    systemHint?: boolean;
    maxSchemaTextLen?: number;
  };
  memory?: {
    enabled?: boolean;
    proactive?: boolean;
  };
  hooks?: {
    enabled?: boolean;
  };
  browser?: Config['browser'] & {
    profile?: string;
  };
  skillHub?: {
    enabled?: boolean;
  };
  channelBridge?: {
    lanes?: Record<
      string,
      {
        maxConcurrent?: number;
      }
    >;
  };
  /**
   * Not a setting: the fallbacks `@mavis/config` recorded while parsing the
   * `goal` tree. Out-of-range values clamp to a safe default instead of
   * failing config load, so this is the only trace a mistyped `goal` key
   * leaves. Empty when the tree parsed clean.
   */
  goalWarnings?: readonly string[];
}
