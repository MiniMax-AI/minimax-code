import { getPrimaryDataDirPath, getProfile, resolveDataDir } from '@mavis/config';
import { resolveMcodeDataEnvironment, type McodeDataEnvironment } from '../auth/environment.js';
import { configureTuiRuntimeEnvironment } from '../cli/environment.js';

export type TuiDefaultDataDirResolver = () => string;

export interface TuiDataDirEnvironment {
  MINIMAX_DATA_DIR?: string;
  MAVIS_DATA_DIR?: string;
}

export interface PrepareTuiDataDirOptions {
  environment?: TuiDataDirEnvironment;
  getBuildEnv?: () => McodeDataEnvironment;
  getDefaultDataDir?: TuiDefaultDataDirResolver;
  configureRuntimeEnvironment?: typeof configureTuiRuntimeEnvironment;
}

// Linux must finish legacy directory resolution before the entry point exports
// MINIMAX_DATA_DIR; otherwise every later runtime treats that path as an override.
const resolveCliDefaultDataDir: typeof resolveDataDir = (options) => (
  process.platform === 'linux'
    ? resolveDataDir(options)
    : getPrimaryDataDirPath(options?.homeDir, options?.profile)
);

export function resolveDefaultTuiDataDir(
  _buildEnv: McodeDataEnvironment,
  resolveDefaultDataDir: typeof resolveDataDir = resolveCliDefaultDataDir,
  getCurrentProfile: typeof getProfile = getProfile,
): string {
  return resolveDefaultDataDir({ profile: getCurrentProfile() });
}

function getDefaultTuiDataDir(): string {
  return resolveDefaultTuiDataDir(resolveMcodeDataEnvironment());
}

function readDataDirOverride(environment: TuiDataDirEnvironment): string | undefined {
  const minimaxDataDir = environment.MINIMAX_DATA_DIR?.trim();
  if (minimaxDataDir) return minimaxDataDir;

  const mavisDataDir = environment.MAVIS_DATA_DIR?.trim();
  return mavisDataDir || undefined;
}

export function getTuiDataDirPath(
  environment: TuiDataDirEnvironment = process.env,
  getDefaultDataDir: () => string = getDefaultTuiDataDir,
): string {
  return readDataDirOverride(environment) ?? getDefaultDataDir();
}

export function resolveTuiDataDir(
  getDefaultDataDir: TuiDefaultDataDirResolver = getDefaultTuiDataDir,
  environment: TuiDataDirEnvironment = process.env,
): string {
  return getTuiDataDirPath(environment, getDefaultDataDir);
}

export function prepareTuiDataDir(options: PrepareTuiDataDirOptions = {}): Promise<string> {
  const buildEnv = (options.getBuildEnv ?? resolveMcodeDataEnvironment)();
  const dataDir = resolveTuiDataDir(
    options.getDefaultDataDir ?? (() => resolveDefaultTuiDataDir(buildEnv)),
    options.environment ?? process.env,
  );
  (options.configureRuntimeEnvironment ?? configureTuiRuntimeEnvironment)({
    dataDir,
  });
  return Promise.resolve(dataDir);
}
