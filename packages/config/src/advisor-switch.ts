import { currentBetaResolutionContext, getRuntimePresetKey, resolveBetaFeature } from './config.js';
import { resolveAdvisorEnabled, type AdvisorSwitchConfigView } from './advisor-config.js';

/** A config the advisor switch reads: its catalog, the user's choice and the build's `beta`. */
export type AdvisorSwitchConfig = AdvisorSwitchConfigView & {
  readonly beta?: { readonly advisor?: boolean };
};

/**
 * Whether this build ships the advisor (`beta.advisor`: on in every channel by default; an
 * explicit `beta.advisor: false` turns it off).
 * A product config carries the value it resolved for its package; one without it (a bare
 * runtime config) resolves for this process, the same way `getConfig()` would.
 */
export function isAdvisorReleasedInConfig(config: Pick<AdvisorSwitchConfig, 'beta'>): boolean {
  return (
    config.beta?.advisor ?? resolveBetaFeature('advisor', undefined, currentBetaResolutionContext())
  );
}

/**
 * The global advisor switch every advisor read obeys: off in a build without the advisor, else
 * the user's `advisor.enabled`, else the catalog default. Computed on every read, never stored.
 */
export function resolveAdvisorSwitch(config: AdvisorSwitchConfig): boolean {
  return isAdvisorReleasedInConfig(config) && resolveAdvisorEnabled(config, getRuntimePresetKey());
}

/**
 * Fills the effective switch into a config snapshot, so the runtime and the config the settings
 * page reads see one value instead of each re-deriving it.
 */
export function withEffectiveAdvisor<T extends AdvisorSwitchConfig>(config: T): T {
  return { ...config, advisor: { ...config.advisor, enabled: resolveAdvisorSwitch(config) } };
}
