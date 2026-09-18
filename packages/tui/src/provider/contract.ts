export const MCODE_PROVIDER_API_FORMATS = [
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
] as const;
export type McodeProviderApiFormat = (typeof MCODE_PROVIDER_API_FORMATS)[number];

const MCODE_PROVIDER_API_FORMAT_SET = new Set<string>(MCODE_PROVIDER_API_FORMATS);

export function isModelProviderApiFormat(value: unknown): value is McodeProviderApiFormat {
  return typeof value === 'string' && MCODE_PROVIDER_API_FORMAT_SET.has(value);
}
export type McodeMiniMaxModelSource = 'token_plan' | 'minimax_api_key';
export type McodeProviderKind = 'codex-oauth' | 'minimax-oauth' | 'minimax-api-key' | 'custom';

export interface McodeProviderStatus {
  readonly state: string;
  readonly lastTestedAt?: number;
  readonly lastErrorCode?: string;
  readonly lastErrorMessage?: string;
}

export interface McodeProviderModel {
  readonly modelId: string;
  readonly displayName?: string;
  readonly selected?: boolean;
  readonly contextLimit?: number;
  readonly maxOutputTokens?: number;
  readonly status?: McodeProviderStatus;
}

export interface McodeRuntimeProviderView {
  readonly providerId: string;
  readonly name?: string;
  readonly kind?: string;
  readonly enabled?: boolean;
  readonly apiFormat?: string;
  readonly baseUrl?: string;
  readonly hasApiKey?: boolean;
  readonly maskedApiKey?: string;
  readonly rawApiKey?: string;
  readonly configRevision?: string;
  readonly models?: readonly McodeProviderModel[];
  readonly status?: McodeProviderStatus;
}

export interface McodeProviderView {
  readonly providerId: string;
  readonly name: string;
  readonly kind: McodeProviderKind;
  readonly active: boolean;
  readonly enabled: boolean;
  readonly readOnly: boolean;
  readonly configRevision?: string;
  readonly apiFormat?: McodeProviderApiFormat;
  readonly baseUrl?: string;
  readonly hasApiKey: boolean;
  readonly maskedApiKey?: string;
  readonly models: readonly McodeProviderModel[];
  readonly status?: McodeProviderStatus;
}

export interface McodeProviderSnapshot {
  readonly minimaxModelSource: McodeMiniMaxModelSource;
  readonly providers: readonly McodeProviderView[];
}

export interface McodeProviderModelInput {
  readonly modelId: string;
  readonly displayName?: string;
  readonly configurationSource?: 'manual' | 'discovered';
  readonly enabled?: boolean;
  readonly attachment?: boolean;
  readonly reasoning?: boolean;
  readonly toolCall?: boolean;
  readonly temperature?: boolean;
  readonly modalities?: { readonly input?: readonly string[]; readonly output?: readonly string[] };
  readonly limit?: { readonly context?: number; readonly output?: number };
}

export interface McodeProviderTemplate {
  readonly providerId: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly apiFormat: McodeProviderApiFormat;
  readonly models: readonly McodeProviderModelInput[];
}

export type McodeCodexOAuthState = 'hidden' | 'disconnected' | 'pending' | 'connected' | 'failed';

export type McodeCodexOAuthLoginMethod = 'browser' | 'device_code';
export interface McodeCodexOAuthLoginOptions {
  readonly method?: McodeCodexOAuthLoginMethod;
}
export interface McodeCodexOAuthStatus {
  readonly state: McodeCodexOAuthState;
  readonly providerId: 'openai-codex';
  readonly error?: string;
  readonly loginId?: string;
  readonly method?: McodeCodexOAuthLoginMethod;
  readonly authUrl?: string;
  readonly deviceCode?: {
    readonly userCode: string;
    readonly verificationUri: string;
    readonly expiresAt: number;
  };
}

export interface McodeCodexOAuthStartResult extends McodeCodexOAuthStatus {
  readonly authUrl?: string;
}

export interface McodeCreateProviderInput {
  readonly name?: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly apiFormat: McodeProviderApiFormat;
  readonly models: readonly McodeProviderModelInput[];
  readonly saveAndUse?: boolean;
}

export interface McodeUpdateProviderInput {
  readonly providerId: string;
  readonly name?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly apiFormat?: McodeProviderApiFormat;
  readonly enabled?: boolean;
  readonly models?: readonly McodeProviderModelInput[];
  readonly saveAndUse?: boolean;
}

export interface McodeSaveProviderCandidateInput extends Omit<
  McodeCreateProviderInput,
  'apiKey' | 'apiFormat' | 'models'
> {
  readonly providerId?: string;
  readonly expectedRevision?: string;
  readonly apiKey?: string;
  readonly apiFormat?: McodeProviderApiFormat;
  readonly models?: readonly McodeProviderModelInput[];
  readonly modelId: string;
  readonly skipConnectionTest?: boolean;
}

export interface McodeDiscoverProviderModelsInput {
  readonly providerId: string;
  readonly expectedRevision: string;
  readonly baseUrl: string;
}

export interface McodeSaveProviderCandidateResult {
  readonly success: boolean;
  readonly status?: McodeProviderStatus;
  readonly provider?: McodeRuntimeProviderView;
}

export interface McodeProviderTestResult {
  readonly success: boolean;
  readonly status: McodeProviderStatus;
}

export interface McodeProviderRuntimePort {
  discoverUserModelsCandidate(
    input: McodeDiscoverProviderModelsInput,
  ): Promise<readonly McodeProviderModel[]>;
  listProviderPresets(): Promise<readonly McodeProviderTemplate[]>;
  getCodexOAuthStatus(): Promise<McodeCodexOAuthStatus>;
  startCodexOAuthLogin(options?: McodeCodexOAuthLoginOptions): Promise<McodeCodexOAuthStartResult>;
  cancelCodexOAuthLogin(loginId: string): Promise<McodeCodexOAuthStatus>;
  listUserModelProviders(): Promise<readonly McodeRuntimeProviderView[]>;
  getMiniMaxApiKeyStatus(): Promise<{
    readonly hasApiKey: boolean;
    readonly maskedApiKey?: string;
    readonly rawApiKey?: string;
    readonly cachedStatus?: McodeProviderStatus;
  }>;
  getMiniMaxModelSource(): Promise<McodeMiniMaxModelSource>;
  setMiniMaxModelSource(source: McodeMiniMaxModelSource): Promise<McodeMiniMaxModelSource>;
  upsertMiniMaxApiKey(input: {
    readonly apiKey: string;
    readonly saveAndUse?: boolean;
  }): Promise<void>;
  createUserModelProvider(input: McodeCreateProviderInput): Promise<void>;
  saveUserModelProviderCandidate(
    input: McodeSaveProviderCandidateInput,
  ): Promise<McodeSaveProviderCandidateResult>;
  updateUserModelProvider(input: McodeUpdateProviderInput): Promise<void>;
  deleteUserModelProvider(providerId: string): Promise<void>;
  testUserModelProvider(providerId: string): Promise<McodeProviderTestResult>;
  testUserModel(providerId: string, modelId: string): Promise<McodeProviderTestResult>;
}
