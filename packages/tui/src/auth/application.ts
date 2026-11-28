import type { MavisBuildEnv, MavisRegion } from '@mavis/config';
import {
  requiresLocalCredentialReset,
  type AuthStatusSnapshot,
  type DeviceAuthorizationPrompt,
  type LoginOptions,
  type LoginResult,
  type LogoutResult,
} from '@mavis/oauth-core';

import type {
  McodeBusinessEventMap,
  McodeBusinessTelemetry,
  McodeLoginFailReason,
  McodeLoginSource,
} from '../analytics/business-telemetry.js';
import { resolveMcodeAuthEnvironment } from './environment.js';
import { buildMcodeLogoutUrl } from './logout-url.js';

export type McodeAuthProgress = {
  readonly state: 'device-authorization';
} & DeviceAuthorizationPrompt;

export interface McodeAuthResult {
  readonly state: 'already-authenticated' | 'authenticated' | 'already-signed-out' | 'signed-out';
  readonly message: string;
  readonly restartRequired?: boolean;
  readonly logoutUrl?: string;
}

export interface McodeAuthPort {
  login(
    onProgress?: (progress: McodeAuthProgress) => void,
    region?: MavisRegion,
  ): Promise<McodeAuthResult>;
  logout(): Promise<McodeAuthResult>;
}

export interface McodeSharedAuthCore {
  getStatus(): Promise<AuthStatusSnapshot>;
  login(options?: LoginOptions): Promise<LoginResult>;
  logout(options: { revoke: boolean }): Promise<LogoutResult>;
}

export interface McodeAuthApplicationOptions {
  readonly dataDir: string;
  readonly sharedAuthCore: McodeSharedAuthCore;
  readonly resolveSharedAuthCore?: (region: MavisRegion) => McodeSharedAuthCore;
  readonly region?: MavisRegion;
  readonly buildEnv?: MavisBuildEnv;
  readonly telemetry?: McodeBusinessTelemetry;
  readonly telemetrySource?: McodeLoginSource;
  readonly writeRegionPreference?: (
    dataDir: string,
    preference: { region: MavisRegion; buildEnv: MavisBuildEnv },
  ) => unknown;
}

export class McodeAuthApplication implements McodeAuthPort {
  private readonly scope: { region: MavisRegion; buildEnv: MavisBuildEnv };

  constructor(private readonly options: McodeAuthApplicationOptions) {
    const environment = resolveMcodeAuthEnvironment({
      runtimeRegion: process.env.MAVIS_REGION === 'en' ? 'en' : 'cn',
    });
    this.scope = {
      region: options.region ?? environment.region,
      buildEnv: options.buildEnv ?? environment.buildEnv,
    };
  }

  async login(
    onProgress?: (progress: McodeAuthProgress) => void,
    region: MavisRegion = this.scope.region,
  ): Promise<McodeAuthResult> {
    this.track('login_click', {});
    try {
      const requestedScope = { ...this.scope, region };
      const switchesRegion = !isSameScope(requestedScope, this.scope);
      let sharedAuthCore = this.options.sharedAuthCore;
      if (switchesRegion) {
        if (!this.options.resolveSharedAuthCore) {
          throw new Error(formatEnvironmentConflict(this.scope, requestedScope));
        }
        sharedAuthCore = this.options.resolveSharedAuthCore(region);
      }
      const wasAuthenticated = (await sharedAuthCore.getStatus()).status === 'authenticated';
      let deviceFlowStarted = false;
      await sharedAuthCore.login({
        onDeviceAuthorization: (authorization: DeviceAuthorizationPrompt) => {
          deviceFlowStarted = true;
          onProgress?.({ state: 'device-authorization', ...authorization });
        },
      });
      this.persistRegionPreference(requestedScope);
      const alreadyAuthenticated = wasAuthenticated && !deviceFlowStarted;
      const result = {
        state: alreadyAuthenticated
          ? ('already-authenticated' as const)
          : ('authenticated' as const),
        message: alreadyAuthenticated
          ? switchesRegion
            ? `Already signed in with ${formatRegion(requestedScope.region)}.`
            : 'Already signed in with MiniMax.'
          : switchesRegion
            ? `Signed in with ${formatRegion(requestedScope.region)}.`
            : 'Signed in with MiniMax.',
        ...(switchesRegion ? { restartRequired: true as const } : {}),
      };
      this.trackLoginResult('1', '');
      return result;
    } catch (error) {
      this.trackLoginResult('2', classifyLoginFailure(error));
      throw error;
    }
  }

  async logout(): Promise<McodeAuthResult> {
    this.track('logout_click', {});
    const status = await this.readStatusBeforeLogout();
    // Always run the shared logout: signing out while already signed out is a
    // safe no-op in the core, and never blocking /logout keeps a wedged local
    // state recoverable.
    const result = await this.options.sharedAuthCore.logout({ revoke: true });
    const logoutUrl = buildMcodeLogoutUrl(this.scope);
    if (status?.status === 'anonymous' && result.status === 'anonymous') {
      return { state: 'already-signed-out', message: 'Already signed out of MiniMax.', logoutUrl };
    }
    return {
      state: 'signed-out',
      logoutUrl,
      message:
        result.status === 'logout_pending'
          ? `Signed out locally from ${formatRegion(this.scope.region)} across MCode. Server revocation is pending until the network recovers.`
          : `Signed out of ${formatRegion(this.scope.region)} on Desktop, CLI/TUI, and embedded mcode-tools.`,
    };
  }

  /**
   * An unreadable or corrupt auth.json makes the status unknown; the shared logout
   * then resets the local credentials instead of failing.
   */
  private async readStatusBeforeLogout(): Promise<AuthStatusSnapshot | undefined> {
    try {
      return await this.options.sharedAuthCore.getStatus();
    } catch (error) {
      if (requiresLocalCredentialReset(error)) return undefined;
      throw error;
    }
  }

  private trackLoginResult(resultType: '1' | '2', failReason: McodeLoginFailReason): void {
    this.track('login_result', {
      source: this.options.telemetrySource ?? 'mcode_cli',
      result_type: resultType,
      fail_reason: failReason,
      login_type: 'minimax_oauth',
    });
  }

  private persistRegionPreference(scope: { region: MavisRegion; buildEnv: MavisBuildEnv }): void {
    try {
      this.options.writeRegionPreference?.(this.options.dataDir, scope);
    } catch {
      // Region persistence must not invalidate an already completed OAuth login.
    }
  }

  private track<Event extends 'login_click' | 'logout_click' | 'login_result'>(
    event: Event,
    properties: McodeBusinessEventMap[Event],
  ): void {
    try {
      this.options.telemetry?.track(event, properties);
    } catch {
      // Business telemetry must not affect authentication.
    }
  }
}

function classifyLoginFailure(error: unknown): McodeLoginFailReason {
  const message = error instanceof Error ? error.message : String(error);
  if (/cancel/iu.test(message)) return '3';
  if (/network|offline|fetch|ECONN|ENOTFOUND|ETIMEDOUT/iu.test(message)) return '2';
  if (/oauth|authorization|login failed|invalid login state/iu.test(message)) return '5';
  if (/server|HTTP 5\d\d/iu.test(message)) return '1';
  return '4';
}

function isSameScope(
  left: { region: MavisRegion; buildEnv: MavisBuildEnv },
  right: { region: MavisRegion; buildEnv: MavisBuildEnv },
): boolean {
  return left.region === right.region && left.buildEnv === right.buildEnv;
}

function formatEnvironmentConflict(
  active: { region: MavisRegion; buildEnv: MavisBuildEnv },
  requested: { region: MavisRegion; buildEnv: MavisBuildEnv },
): string {
  if (active.region !== requested.region) {
    return `Signed in to ${formatRegion(active.region)}. Run \`mcode logout\` before signing in to ${formatRegion(requested.region)}.`;
  }
  return `Signed in to another MiniMax ${active.buildEnv} environment. Run \`mcode logout\` before signing in to ${requested.buildEnv}.`;
}

function formatRegion(region: MavisRegion): string {
  return region === 'cn' ? 'MiniMax China' : 'MiniMax Global';
}
