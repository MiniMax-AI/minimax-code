import {
  ConfigFileError,
  loadConfigFromFile,
  type Config,
  type LoadConfigFromFileOptions,
} from '@mavis/config';

import { TuiExecError } from './exit-policy.js';

export async function loadTuiRuntimeConfig(
  configPath: string,
  options: Omit<LoadConfigFromFileOptions, 'invalidSections'>,
): Promise<Config> {
  try {
    // A file passed with --config is a deliberate choice: report invalid
    // sections instead of silently running with their defaults.
    return loadConfigFromFile(configPath, { ...options, invalidSections: 'reject' });
  } catch (error) {
    const message =
      error instanceof ConfigFileError
        ? error.message
        : `Config is invalid: ${configPath}${error instanceof Error ? ` (${error.message})` : ''}`;
    throw new TuiExecError('config', message, {
      cause: error,
    });
  }
}
