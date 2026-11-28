import type { AuthNamespaceInput } from './contracts.js';
import { MCodeOAuthCore } from './auth-core.js';
import { createCredentialStore } from './credential-store/factory.js';
import { createAuthNamespace } from './namespace.js';
import { migrateLegacyAuthNamespace } from './namespace-migration.js';
import type { AuthDiagnosticObserver } from './diagnostics.js';
import { HttpOAuthClient, type HttpOAuthClientOptions } from './oauth-client.js';
import {
  createAuthManager,
  createTokenProvider,
  type MCodeAuthManager,
  type MCodeTokenProvider,
} from './token-provider.js';

export interface CreateMCodeLocalAuthOptions extends AuthNamespaceInput {
  fetchImpl?: typeof fetch;
  onDiagnostic?: AuthDiagnosticObserver;
  /** See HttpOAuthClientOptions.loginRequestTimeoutMs; unset keeps login requests unbounded. */
  loginRequestTimeoutMs?: number;
  endpoints: Pick<
    HttpOAuthClientOptions,
    | 'deviceAuthorizationEndpoint'
    | 'deviceAuthorizationHeaders'
    | 'tokenEndpoint'
    | 'revocationEndpoint'
  >;
}

export function createMCodeTokenProvider(options: CreateMCodeLocalAuthOptions): MCodeTokenProvider {
  return createTokenProvider(createCore(options));
}

export function createMCodeAuthManager(options: CreateMCodeLocalAuthOptions): MCodeAuthManager {
  return createAuthManager(createCore(options));
}

function createCore(options: CreateMCodeLocalAuthOptions): MCodeOAuthCore {
  const namespace = createAuthNamespace(options);
  return new MCodeOAuthCore({
    namespace,
    credentialStore: createCredentialStore({
      authHome: namespace.namespaceHome,
      root: namespace.authHome,
    }),
    oauthClient: new HttpOAuthClient({
      ...options.endpoints,
      fetchImpl: options.fetchImpl,
      loginRequestTimeoutMs: options.loginRequestTimeoutMs,
    }),
    initialize: () => migrateLegacyAuthNamespace(namespace),
    onDiagnostic: options.onDiagnostic,
  });
}
