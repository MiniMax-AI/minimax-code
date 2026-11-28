import { betaResolutionContextFor } from './beta-resolution-context.js';
import { resolveBetaFeature } from './config.js';
import { resolvePtcToolCallMode } from './ptc-default-config.js';

/** The fields read here, so every config view the runtime hands around fits. */
export interface PtcConfigView {
  readonly beta?: { readonly ptc?: boolean } | undefined;
  readonly explicitPtc?: boolean | undefined;
  /** The build default follows the production build too, so the source stays `build`. */
  readonly productionParity?: boolean | undefined;
}

/**
 * The tool call mode new Sessions take, and what decided it. New Sessions, the post-compaction
 * refresh, `/config` and the process-local read all call this, so they cannot disagree.
 *
 * `config.beta.ptc` is the build default unless something set it. A value that differs from the
 * build default was set on purpose, which also covers the in-memory override of TUI `--ptc` and
 * the value Apollo wrote down once; only a value equal to the build default needs `explicitPtc`
 * to tell a choice from "unset".
 */
export function resolveEffectivePtc(
  config: PtcConfigView,
): ReturnType<typeof resolvePtcToolCallMode> {
  const buildDefault = resolveBetaFeature('ptc', undefined, betaResolutionContextFor(config));
  const configured = config.beta?.ptc;
  return resolvePtcToolCallMode({
    explicit:
      config.explicitPtc === undefined && configured === buildDefault ? undefined : configured,
    buildDefault,
  });
}
