import fs from 'node:fs';

import { createAuthNamespace, type AuthStatus } from '@mavis/oauth-core';
import {
  setLegacyByokProviderMigrationEnabled,
  setManagedPresetBaseUrlSyncEnabled,
} from '@mavis/config';

import {
  resolveMcodeAuthEnvironment,
  setMcodeStartupBuildEnvironment,
  type McodeAuthEnvironment,
  type ResolveMcodeAuthEnvironmentOptions,
  type TuiBuildEnvironment,
} from '../auth/environment.js';
import { readTuiRegionPreference } from '../auth/region-preference.js';

const MANAGED_BACKEND_LANE_PATTERN = /^[A-Za-z0-9._-]+$/u;
const STARTUP_ENVIRONMENT_OPTION = '--env';
const ROOT_OPTIONS_WITH_REQUIRED_VALUES = new Set([
  '--lane',
  '--resume',
  '--tui-mode',
  '-m',
  '--model',
]);
const STARTUP_ENVIRONMENT_ALIASES: Readonly<Record<string, TuiBuildEnvironment>> = Object.freeze({
  test: 'test',
  pre: 'staging',
  staging: 'staging',
  prod: 'prod',
});

export interface ConfigureTuiRuntimeEnvironmentOptions extends ResolveMcodeAuthEnvironmentOptions {
  readonly target?: Record<string, string | undefined>;
  readonly dataDir?: string;
  readonly startupBuildEnvironment?: TuiBuildEnvironment;
}

export function configureTuiRuntimeEnvironment(
  options: ConfigureTuiRuntimeEnvironmentOptions = {},
): McodeAuthEnvironment {
  setLegacyByokProviderMigrationEnabled(false);
  setManagedPresetBaseUrlSyncEnabled(false);
  const { target = process.env, dataDir, startupBuildEnvironment, ...environmentOptions } = options;
  if (startupBuildEnvironment) setMcodeStartupBuildEnvironment(startupBuildEnvironment);
  const buildEnvironment = resolveMcodeAuthEnvironment(environmentOptions);
  const preferredRegion = dataDir
    ? readTuiRegionPreference(dataDir, buildEnvironment.buildEnv)
    : undefined;
  const sharedAuthScope = dataDir
    ? readSharedAuthScope(dataDir, buildEnvironment.buildEnv)
    : undefined;
  const inheritedRegion = readRuntimeRegion(target.MAVIS_REGION);
  const environment = resolveMcodeAuthEnvironment({
    ...environmentOptions,
    runtimeRegion:
      environmentOptions.runtimeRegion ??
      inheritedRegion ??
      preferredRegion ??
      sharedAuthScope?.region ??
      'cn',
  });
  if (dataDir) {
    target.MINIMAX_DATA_DIR = dataDir;
    target.MAVIS_DATA_DIR = dataDir;
  }
  target.MAVIS_REGION = environment.region;
  target.MAVIS_BUILD_ENV = environment.buildEnv;
  target.__MAVIS_RUNTIME_MANAGED = '1';
  return environment;
}

export function parseTuiStartupEnvironment(value: string): TuiBuildEnvironment {
  const environment = STARTUP_ENVIRONMENT_ALIASES[value.trim()];
  if (!environment) {
    throw new Error('--env must be test, staging, pre, or prod.');
  }
  return environment;
}

export function resolveTuiStartupEnvironmentOption(
  argv: readonly string[],
  internalPackage: boolean,
): TuiBuildEnvironment | undefined {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === '--') break;
    if (argument === STARTUP_ENVIRONMENT_OPTION) {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) throw new Error('--env requires a value.');
      values.push(value);
      index += 1;
      continue;
    }
    if (argument.startsWith(`${STARTUP_ENVIRONMENT_OPTION}=`)) {
      values.push(argument.slice(STARTUP_ENVIRONMENT_OPTION.length + 1));
      continue;
    }
    if (ROOT_OPTIONS_WITH_REQUIRED_VALUES.has(argument)) {
      index += 1;
      continue;
    }
    if (argument === '--session' && argv[index + 1] && !argv[index + 1]?.startsWith('-')) {
      index += 1;
      continue;
    }
    if (!argument.startsWith('-')) break;
  }
  if (values.length === 0) return undefined;
  if (!internalPackage) {
    throw new Error('--env is only available in the internal MCode package.');
  }
  if (values.length > 1) throw new Error('--env may only be specified once.');
  return parseTuiStartupEnvironment(values[0] ?? '');
}

export function resolveTuiManagedBackendLane(
  value: string | undefined,
  buildEnv: McodeAuthEnvironment['buildEnv'] = resolveMcodeAuthEnvironment().buildEnv,
): string | undefined {
  if (value === undefined) return undefined;
  if (buildEnv !== 'test' && buildEnv !== 'staging') {
    throw new Error('--lane is only supported in test or staging builds.');
  }
  const lane = value.trim();
  if (!MANAGED_BACKEND_LANE_PATTERN.test(lane)) {
    throw new Error('--lane only accepts letters, numbers, dot, underscore, and hyphen.');
  }
  return lane;
}

function readSharedAuthScope(
  dataDir: string,
  buildEnv: McodeAuthEnvironment['buildEnv'],
): McodeAuthEnvironment | undefined {
  const authenticatedRegions = (['cn', 'en'] as const).filter((region) => {
    try {
      const namespace = createAuthNamespace({ dataDir, buildEnv, region });
      const state = JSON.parse(fs.readFileSync(namespace.statePath, 'utf8')) as Record<
        string,
        unknown
      >;
      return (
        state.buildEnv === buildEnv && state.region === region && isReusableAuthStatus(state.status)
      );
    } catch {
      return false;
    }
  });
  const region = authenticatedRegions.length === 1 ? authenticatedRegions[0] : undefined;
  return region ? { buildEnv, region } : undefined;
}

function isReusableAuthStatus(value: unknown): value is AuthStatus {
  return (
    value === 'authorizing' ||
    value === 'authenticated' ||
    value === 'refreshing' ||
    value === 'scope_upgrade_required' ||
    value === 'expired'
  );
}

function readRuntimeRegion(value: string | undefined): McodeAuthEnvironment['region'] | undefined {
  return value === 'cn' || value === 'en' ? value : undefined;
}
