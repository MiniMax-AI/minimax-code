import { createHash } from 'node:crypto';

import {
  managedBackendRoutingHeaders,
  type ManagedBackendRoutingContext,
} from '@mavis/agent-tools/desktop';
import type { MavisBuildEnv } from '@mavis/config';

import type { LocalRuntimeAuthContext } from '../../../infra/config/auth-context.js';

export interface LocalFileApiGatewayAuth {
  readonly gatewayHeaders: Readonly<Record<string, string>>;
  readonly callerIdentityHash: string;
}

/** Builds File API auth only from the managed local login identity. */
export function resolveLocalFileApiGatewayAuth(
  context: LocalRuntimeAuthContext | undefined,
  routingContext: ManagedBackendRoutingContext | undefined,
  buildEnv: MavisBuildEnv | undefined = currentBuildEnv(),
): LocalFileApiGatewayAuth | undefined {
  const accessToken = context?.accessToken?.trim();
  if (!accessToken || /[\u0000-\u001f\u007f]/u.test(accessToken)) return undefined;
  const callerIdentity = context?.realUserID?.trim() || context?.userEmail?.trim();
  if (!callerIdentity) return undefined;
  return {
    gatewayHeaders: {
      Authorization: `Bearer ${accessToken}`,
      ...managedBackendRoutingHeaders(routingContext, buildEnv),
    },
    callerIdentityHash: sha256(`local-runtime:${callerIdentity}`),
  };
}

function currentBuildEnv(): MavisBuildEnv | undefined {
  const value = process.env.MAVIS_BUILD_ENV;
  return value === 'dev' || value === 'test' || value === 'staging' || value === 'prod'
    ? value
    : undefined;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
