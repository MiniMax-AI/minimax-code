import {
  MCODE_OAUTH_SCOPES,
  type AccessTokenLease,
  type UnauthorizedContext,
} from './contracts.js';
import type {
  AuthStatusSnapshot,
  DeviceAuthorizationPrompt,
  LoginOptions,
  LoginResult,
  LogoutResult,
  MCodeOAuthCore,
} from './auth-core.js';

export interface MCodeTokenProvider {
  getStatus(): Promise<AuthStatusSnapshot>;
  getAccessToken(options: { minValidityMs: number }): Promise<AccessTokenLease>;
  handleUnauthorized(context: UnauthorizedContext): Promise<'retry' | 'logout'>;
}

export interface MCodeAuthManager extends MCodeTokenProvider {
  login(options?: LoginOptions): Promise<LoginResult>;
  cancelLogin(): Promise<void>;
  logout(options: { revoke: boolean }): Promise<LogoutResult>;
  /** Clears an unreadable or corrupt local credential file; see MCodeOAuthCore.resetLocalCredentials. */
  resetLocalCredentials(): Promise<LogoutResult>;
  watch(listener: (status: AuthStatusSnapshot) => void): () => void;
}

export function createTokenProvider(core: MCodeOAuthCore): MCodeTokenProvider {
  return Object.freeze({
    getStatus: () => core.getStatus(),
    getAccessToken: (options: { minValidityMs: number }) =>
      core.getAccessToken({
        requiredScopes: [...MCODE_OAUTH_SCOPES],
        minValidityMs: options.minValidityMs,
      }),
    handleUnauthorized: (context: UnauthorizedContext) => core.handleUnauthorized(context),
  });
}

export function createAuthManager(core: MCodeOAuthCore): MCodeAuthManager {
  const provider = createTokenProvider(core);
  return Object.freeze({
    ...provider,
    login: (options?: {
      onDeviceAuthorization?: (authorization: DeviceAuthorizationPrompt) => void;
    }) => core.login(options),
    cancelLogin: () => core.cancelLogin(),
    logout: (options: { revoke: boolean }) => core.logout(options),
    resetLocalCredentials: () => core.resetLocalCredentials(),
    watch: (listener: (status: AuthStatusSnapshot) => void) => core.watch(listener),
  });
}
