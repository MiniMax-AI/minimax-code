import type { LocalBrowserAdapter } from '@mavis/agent-tools/desktop';
import { resolveBrowserReadV2, type BrowserConfig, type Config } from '@mavis/config';
import {
  disposeHeadlessSessionStorage,
  HeadlessChromeBrowserProvider,
  type HeadlessChromeBrowserProviderOptions,
} from './browser/headless-chrome-provider.js';

export type TuiBrowserProvider = LocalBrowserAdapter & {
  close(): Promise<void>;
};

export interface TuiBrowserProviderConfig {
  readonly beta?: Partial<Pick<Config['beta'], 'browserUseTooling' | 'browserReadV2'>>;
  readonly browser?: BrowserConfig;
}

export type TuiBrowserProviderFactory = (
  options: HeadlessChromeBrowserProviderOptions,
) => TuiBrowserProvider;

export function resolveTuiBrowserProviderOptions(
  dataDir: string,
  config: TuiBrowserProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
): HeadlessChromeBrowserProviderOptions | undefined {
  if (config.beta?.browserUseTooling !== true) return undefined;
  const chromePath = env.MCODE_CHROME_PATH?.trim() || config.browser?.chromePath?.trim();
  const useSwiftShader = env.MCODE_BROWSER_USE_SWIFTSHADER?.trim().toLowerCase() === 'true';
  // MCODE_BROWSER_HEADLESS (true/false) overrides browser.headless for one launch.
  const headlessEnv = env.MCODE_BROWSER_HEADLESS?.trim().toLowerCase();
  const headless =
    headlessEnv === 'true' || headlessEnv === 'false'
      ? headlessEnv === 'true'
      : config.browser?.headless;
  return {
    dataDir,
    ...(chromePath ? { chromePath } : {}),
    // Read once at startup like every other Browser option; restart MCode to change it.
    // ARCHON_BETA_BROWSER_READ_V2 overrides config.yaml.
    ...(resolveBrowserReadV2(config.beta?.browserReadV2, env) ? { browserReadV2: true } : {}),
    ...(headless === false ? { headless: false } : {}),
    // CPU rendering is an explicit opt-in for trusted local tests on GPU-less hosts.
    ...(useSwiftShader
      ? {
          extraArgs: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
        }
      : {}),
  };
}

export function createTuiBrowserProvider(
  dataDir: string,
  config: TuiBrowserProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
  factory: TuiBrowserProviderFactory = (options) => new HeadlessChromeBrowserProvider(options),
): TuiBrowserProvider | undefined {
  const options = resolveTuiBrowserProviderOptions(dataDir, config, env);
  return options ? factory(options) : undefined;
}

/** Cleanup remains available after a restart where the Browser backend is not enabled. */
export function disposeTuiBrowserSessionStorage(dataDir: string, sessionId: string): Promise<void> {
  return disposeHeadlessSessionStorage({ dataDir }, sessionId);
}
