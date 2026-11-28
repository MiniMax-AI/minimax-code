import { join } from 'node:path';
import {
  getRuntimeBuildEnv,
  readExplicitBetaFeatureFromFile,
  resolveBetaFeature,
  type MavisBuildEnv,
  type MavisRegion,
} from '@mavis/config';
import {
  resolveProductBuildIdentity,
  type ProductBuildIdentity,
} from '@mavis/shared/product-build-identity';

export type TuiBuildEnvironment = 'test' | 'staging' | 'prod';
export type TuiBuildVariant = 'standard' | 'internal';
export type McodeDataEnvironment = TuiBuildEnvironment | 'dev';

declare const __TUI_BUILD_ENV__: TuiBuildEnvironment | undefined;
declare const __TUI_BUILD_VARIANT__: TuiBuildVariant | undefined;

export interface ResolveMcodeAuthEnvironmentOptions {
  readonly embeddedBuildEnvironment?: TuiBuildEnvironment;
  readonly embeddedBuildVariant?: TuiBuildVariant;
  readonly runtimeRegion?: MavisRegion;
  readonly runtimeBuildEnv?: MavisBuildEnv;
}

export interface McodeAuthEnvironment {
  readonly region: MavisRegion;
  readonly buildEnv: MavisBuildEnv;
}

let startupBuildEnvironment: TuiBuildEnvironment | undefined;

export function setMcodeStartupBuildEnvironment(
  environment: TuiBuildEnvironment | undefined,
): void {
  startupBuildEnvironment = environment;
}

export function resolveMcodeBuildIdentity(
  options: ResolveMcodeAuthEnvironmentOptions = {},
): ProductBuildIdentity {
  const embeddedBuildEnvironment =
    options.embeddedBuildEnvironment ?? readEmbeddedBuildEnvironment();
  const embeddedBuildVariant = options.embeddedBuildVariant ?? readEmbeddedBuildVariant();
  const runtimeBuildEnv = options.runtimeBuildEnv ?? getRuntimeBuildEnv();

  return resolveProductBuildIdentity({
    buildEnv: embeddedBuildEnvironment ?? normalizeRuntimeBuildEnvironment(runtimeBuildEnv),
    internalBuild: embeddedBuildVariant === 'internal',
  });
}

/**
 * User-added Plugin marketplaces and the advisor ship in internal and test packages only.
 * Like Codex OAuth, the package identity decides: the process env does not carry the
 * internal-package flag, so the config file's resolved value cannot tell them apart.
 */
export function isMcodeInternalFeatureReleased(
  feature: 'pluginMarketplaces' | 'advisor',
  buildIdentity: Pick<ProductBuildIdentity, 'isInternalBuild'> &
    Partial<Pick<ProductBuildIdentity, 'buildEnv'>> = resolveMcodeBuildIdentity(),
): boolean {
  return resolveBetaFeature(feature, undefined, {
    ...(buildIdentity.buildEnv ? { buildEnv: buildIdentity.buildEnv } : {}),
    internalBuild: buildIdentity.isInternalBuild,
  });
}

/**
 * The advisor as this process offers it: the package rollout is the ceiling, and an explicit
 * `beta.advisor: false` in config.yaml turns it off. The embedded Runtime projection and the TUI
 * entry share it, so a visible `/advisor` never disagrees with what the action can do.
 */
export function isMcodeAdvisorAvailable(
  configured: boolean | undefined,
  buildIdentity: Pick<ProductBuildIdentity, 'isInternalBuild'> &
    Partial<Pick<ProductBuildIdentity, 'buildEnv'>> = resolveMcodeBuildIdentity(),
): boolean {
  return isMcodeInternalFeatureReleased('advisor', buildIdentity) && configured !== false;
}

/**
 * The explicit `beta.advisor` from config.yaml, read from the raw document so a resolved default
 * never passes for the user's own choice. An absent, unreadable or shapeless config leaves the
 * package rollout in charge; only an explicit `false` turns the advisor off.
 */
export function readMcodeAdvisorConfigured(dataDir: string): boolean | undefined {
  try {
    return readExplicitBetaFeatureFromFile(join(dataDir, 'config.yaml'), 'advisor');
  } catch {
    return undefined;
  }
}

export function resolveMcodeAuthEnvironment(
  options: ResolveMcodeAuthEnvironmentOptions = {},
): McodeAuthEnvironment {
  const buildIdentity = resolveMcodeBuildIdentity(options);

  return {
    region: options.runtimeRegion ?? 'cn',
    buildEnv: startupBuildEnvironment ?? buildIdentity.buildEnv ?? 'test',
  };
}

export function resolveMcodeDataEnvironment(
  embeddedBuildEnvironment: TuiBuildEnvironment | undefined = readEmbeddedBuildEnvironment(),
): McodeDataEnvironment {
  return startupBuildEnvironment ?? embeddedBuildEnvironment ?? 'dev';
}

function readEmbeddedBuildEnvironment(): TuiBuildEnvironment | undefined {
  if (typeof __TUI_BUILD_ENV__ === 'undefined') return undefined;
  return __TUI_BUILD_ENV__;
}

function readEmbeddedBuildVariant(): TuiBuildVariant | undefined {
  if (typeof __TUI_BUILD_VARIANT__ === 'undefined') return undefined;
  return __TUI_BUILD_VARIANT__;
}

function normalizeRuntimeBuildEnvironment(environment: MavisBuildEnv): MavisBuildEnv {
  return environment === 'dev' ? 'test' : environment;
}
