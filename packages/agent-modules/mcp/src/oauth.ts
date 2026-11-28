/**
 * `@mavis/mcp/oauth` — MCP SDK OAuth protocol primitives for hosts that run their own
 * authorization orchestration. Re-exported here so every host uses the same SDK (and zod)
 * instance as the transport layer. Hosts must not use the SDK `auth()` orchestrator or a
 * transport `authProvider`; see `runtime/auth.ts` for the request authorizer contract.
 */
export {
  buildDiscoveryUrls,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  extractWWWAuthenticateParams,
  parseErrorResponse,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
export {
  OAuthClientInformationFullSchema,
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
  OAuthTokensSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js';
export type {
  AuthorizationServerMetadata,
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthMetadata,
  OAuthProtectedResourceMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
export type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
