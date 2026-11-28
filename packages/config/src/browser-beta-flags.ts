/**
 * Decision points for the Browser beta switches and `browser.compactInspect`.
 * A set environment variable wins over config.yaml (`1`/`true`/`on` enables,
 * `0`/`false`/`off` disables); unset, empty or any other value keeps the
 * configured value. Electron reads them per Browser call, TUI and the local
 * runtime when they build the Browser tools.
 */

/** The environment override of a switch: true, false, or undefined when unset or unrecognized. */
export function readEnvSwitch(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const override = env[name]?.trim().toLowerCase();
  if (override === '1' || override === 'true' || override === 'on') return true;
  if (override === '0' || override === 'false' || override === 'off') return false;
  return undefined;
}

function resolveBrowserSwitch(
  name: string,
  configured: boolean | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  return readEnvSwitch(env, name) ?? configured === true;
}

/**
 * `beta.browserReadV2`: DOM, rows, inspect and editable reads carry live
 * form-control state. `ARCHON_BETA_BROWSER_READ_V2` overrides config.yaml.
 */
export function resolveBrowserReadV2(
  configured: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolveBrowserSwitch('ARCHON_BETA_BROWSER_READ_V2', configured, env);
}

/**
 * Whether a Browser call inside a run_code program gets the automatic
 * post-action screenshot (`browser.screenshot.ptcAuto`, on when omitted).
 */
export function resolveBrowserPtcAutoScreenshot(config: {
  readonly ptcAuto?: boolean | undefined;
}): boolean {
  return config.ptcAuto ?? true;
}
