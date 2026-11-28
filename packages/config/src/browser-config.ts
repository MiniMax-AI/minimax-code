import { readEnvSwitch } from './browser-beta-flags.js';

/** Browser configuration shared by local providers (`browser:` in config.yaml). */
export interface BrowserConfig {
  /** Optional Chrome executable path. Omit it to use Chrome for Testing. */
  chromePath?: string;
  /** `false` shows the Chrome window; omitted or `true` keeps Chrome headless. */
  headless?: boolean;
  /** Automatic post-action screenshots. */
  screenshot?: {
    /**
     * Browser calls inside a run_code program get the automatic post-action
     * screenshot. Omitted: yes.
     */
    ptcAuto?: boolean;
  };
  /**
   * The model reads `inspect` and semantic `query` pages as one line per
   * element (`ref role name [state]`), and gets the short Browser description
   * and the short builtin Skill. Omitted: on. Resolved by
   * `resolveBrowserCompactInspect`, where `ARCHON_BROWSER_COMPACT_INSPECT`
   * overrides this value.
   */
  compactInspect?: boolean;
}

export const BROWSER_CONFIG_DEFAULTS: BrowserConfig = {};

export function parseBrowserConfig(raw: unknown): BrowserConfig {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...BROWSER_CONFIG_DEFAULTS };
  }
  const chromePath = Reflect.get(raw, 'chromePath');
  const headless = Reflect.get(raw, 'headless');
  const screenshot: unknown = Reflect.get(raw, 'screenshot');
  const ptcAuto =
    screenshot !== null && typeof screenshot === 'object'
      ? Reflect.get(screenshot, 'ptcAuto')
      : undefined;
  const compactInspect = Reflect.get(raw, 'compactInspect');
  return {
    ...BROWSER_CONFIG_DEFAULTS,
    ...(typeof chromePath === 'string' && chromePath.trim()
      ? { chromePath: chromePath.trim() }
      : {}),
    ...(typeof headless === 'boolean' ? { headless } : {}),
    ...(typeof ptcAuto === 'boolean' ? { screenshot: { ptcAuto } } : {}),
    ...(typeof compactInspect === 'boolean' ? { compactInspect } : {}),
  };
}

/**
 * `browser.compactInspect`: compact `inspect`/semantic `query` text for the
 * model plus the short Browser description and builtin Skill. On unless
 * config.yaml says `browser.compactInspect: false`; a set
 * `ARCHON_BROWSER_COMPACT_INSPECT` wins over config.yaml (`1`/`true`/`on`
 * enables, `0`/`false`/`off` disables; any other value keeps config.yaml).
 */
export function resolveBrowserCompactInspect(
  configured: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return readEnvSwitch(env, 'ARCHON_BROWSER_COMPACT_INSPECT') ?? configured !== false;
}
