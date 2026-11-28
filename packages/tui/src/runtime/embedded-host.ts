import { createLocalRuntimeHostV2, getDefaultLocalRuntimeConfig } from '@mavis/local-runtime-v2';
import type {
  CreateLocalRuntimeHostOptions,
  CreatedLocalRuntimeHost,
} from '@mavis/local-runtime-v2/process-local';
import type { CliService } from '@mavis/local-runtime-v2/cli-service';
import { guardTuiRuntimeOwner } from './owner-guard.js';
import { resolveTuiReviewPromptDir } from './review-assets.js';
import type { ProductBuildIdentity } from '@mavis/shared/product-build-identity';
import {
  isMcodeAdvisorAvailable,
  resolveMcodeBuildIdentity,
} from '../auth/environment.js';

export { getTuiRuntimeOwnerConflict, type TuiRuntimeOwnerConflict } from './owner-guard.js';

export type EmbeddedRuntimeHostOptions = Omit<
  CreateLocalRuntimeHostOptions,
  | 'runtimeOwnerKind'
  | 'runtimeMode'
  | 'legacyOpencodeEnabled'
  | 'enableLiveMcp'
  | 'capabilityProfile'
  | 'isContextWindowUsageEnabled'
> & {
  productCapabilities?: {
    mcodeTools: boolean;
  };
};

export type EmbeddedRuntimeHostFactory = (
  options: CreateLocalRuntimeHostOptions,
) => CreatedLocalRuntimeHost | Promise<CreatedLocalRuntimeHost>;

export type EmbeddedRuntimeHost = CreatedLocalRuntimeHost & {
  cliService: CliService;
};

type EmbeddedRuntimeConfig = ReturnType<NonNullable<CreateLocalRuntimeHostOptions['configGetter']>>;

export function projectEmbeddedRuntimeConfig(
  config: EmbeddedRuntimeConfig,
  buildIdentity: Pick<ProductBuildIdentity, 'isInternalBuild'> = resolveMcodeBuildIdentity(),
  mcodeToolsEnabled = false,
): EmbeddedRuntimeConfig {
  return {
    ...config,
    review: {
      ...config.review,
      mode:
        !config.review || config.review.modeSource === 'default'
          ? ('inline' as const)
          : config.review.mode,
    },
    beta: {
      ...config.beta,
      codexOAuth: buildIdentity.isInternalBuild,
      mcodeTools: mcodeToolsEnabled && config.beta?.mcodeTools === true,
      advisor: isMcodeAdvisorAvailable(config.beta?.advisor, buildIdentity),
    },
    memory: {
      ...config.memory,
      enabled: false,
    },
    // The TUI offers next-message suggestions by default in every build; an
    // explicit `promptSuggestion.enabled` in config.yaml still wins.
    promptSuggestion:
      typeof config.promptSuggestion?.enabled === 'boolean'
        ? config.promptSuggestion
        : { ...config.promptSuggestion, enabled: true },
  };
}


export async function createEmbeddedRuntimeHost(
  options: EmbeddedRuntimeHostOptions,
  factory: EmbeddedRuntimeHostFactory = createLocalRuntimeHostV2,
): Promise<EmbeddedRuntimeHost> {
  if (process.env.MAVIS_LOCAL_RUNTIME_V2_FORCE_LEGACY === '1') {
    throw new Error(
      'Minimax Code embedded Runtime requires the local-runtime-v2 front door; legacy fallback is disabled.',
    );
  }
  // Runs before `factory(...)` so this process has not written its own Runtime owner lease
  // yet and the scan only sees leases belonging to other processes. It reports a live foreign
  // owner only with explicit `MCODE_TUI_RUNTIME_OWNER_GUARD=warn|strict`; default startup skips it.
  await guardTuiRuntimeOwner({ dataDir: options.dataDir });
  const { productCapabilities, ...runtimeOptions } = options;
  const configGetter = runtimeOptions.configGetter ?? getDefaultLocalRuntimeConfig;
  const host = await factory({
    ...runtimeOptions,
    reviewPromptDir: runtimeOptions.reviewPromptDir ?? resolveTuiReviewPromptDir(),
    configGetter: () =>
      projectEmbeddedRuntimeConfig(
        configGetter(),
        resolveMcodeBuildIdentity(),
        productCapabilities?.mcodeTools === true,
      ),
    runtimeOwnerKind: 'tui',
    runtimeMode: 'clean',
    legacyOpencodeEnabled: false,
    enableLiveMcp: true,
    capabilityProfile: 'cli',
    isContextWindowUsageEnabled: () => true,
    capabilities: {
      ...runtimeOptions.capabilities,
      cliEmbedded: true,
    },
  });

  try {
    await host.ready;
    if (!host.cliService) {
      throw new Error('Minimax Code embedded Runtime does not expose CliService.');
    }
    await host.apiHost.ensureBuiltinAgents();
    return host as EmbeddedRuntimeHost;
  } catch (error) {
    try {
      await host.apiHost.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Embedded Runtime startup cleanup failed.');
    }
    throw error;
  }
}
