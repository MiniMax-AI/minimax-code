import type { LocalBrowserAdapter } from '@mavis/agent-tools/desktop';
import type { BrowserConfig, Config } from '@mavis/config';
import {
  disposeHeadlessSessionStorage,
  HeadlessChromeBrowserProvider,
  type HeadlessChromeBrowserProviderOptions,
} from './browser/headless-chrome-provider.js';

export type TuiBrowserProvider = LocalBrowserAdapter & {
  close(): Promise<void>;
};

export interface TuiBrowserProviderConfig {
  readonly beta?: Partial<Pick<Config['beta'], 'browserUseTooling'>>;
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
  return {
    dataDir,
    ...(chromePath ? { chromePath } : {}),
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
