import fs from 'node:fs';
import yaml from 'js-yaml';

import { prepareConfigFileForRead, resolveConfigFromRaw, type Config } from './config.js';

export type ConfigFileErrorCode =
  | 'CONFIG_READ_FAILED'
  | 'CONFIG_PARSE_FAILED'
  | 'CONFIG_ROOT_INVALID'
  | 'CONFIG_SECTION_INVALID';

export class ConfigFileError extends Error {
  readonly code: ConfigFileErrorCode;
  readonly configPath: string;

  constructor(
    code: ConfigFileErrorCode,
    configPath: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ConfigFileError';
    this.code = code;
    this.configPath = configPath;
  }
}

export interface LoadConfigFromFileOptions {
  dataDir: string;
  /**
   * `fallback` (default) matches getConfig(): an invalid section uses its
   * default and is listed in `configIssues`, so readers of the profile's own
   * config.yaml keep working. `reject` throws CONFIG_SECTION_INVALID and is for
   * files the user chose explicitly, such as `mcode exec --config`.
   */
  invalidSections?: 'reject' | 'fallback';
}

function readConfigDocument(configPath: string): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(configPath, 'utf-8');
  } catch (cause) {
    throw new ConfigFileError(
      'CONFIG_READ_FAILED',
      configPath,
      `Cannot read config ${configPath}.`,
      { cause },
    );
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(text);
  } catch (cause) {
    throw new ConfigFileError(
      'CONFIG_PARSE_FAILED',
      configPath,
      `Config is not valid YAML: ${configPath}`,
      { cause },
    );
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigFileError(
      'CONFIG_ROOT_INVALID',
      configPath,
      `Config root must be an object: ${configPath}`,
    );
  }

  return parsed as Record<string, unknown>;
}

/**
 * Loads a config file by path. Unreadable, malformed or non-mapping files always
 * throw. An invalid section falls back like getConfig() unless the caller asks
 * for `invalidSections: 'reject'`.
 */
export function loadConfigFromFile(configPath: string, options: LoadConfigFromFileOptions): Config {
  if (fs.existsSync(configPath)) prepareConfigFileForRead(configPath);

  const config = resolveConfigFromRaw(readConfigDocument(configPath), options.dataDir);
  const invalid = config.configIssues.filter((issue) => issue.kind === 'invalid_section');
  if (invalid.length > 0 && options.invalidSections === 'reject') {
    throw new ConfigFileError(
      'CONFIG_SECTION_INVALID',
      configPath,
      `Config has invalid settings: ${configPath} (${invalid
        .map((issue) => `${issue.section ?? 'config'}: ${issue.message}`)
        .join('; ')})`,
    );
  }
  return config;
}

export function readExplicitBetaFeatureFromFile(
  configPath: string,
  feature: keyof Config['beta'],
): boolean | undefined {
  const raw = readConfigDocument(configPath);
  if (raw.beta == null || typeof raw.beta !== 'object' || Array.isArray(raw.beta)) {
    return undefined;
  }
  const configured = (raw.beta as Record<string, unknown>)[feature];
  return typeof configured === 'boolean' ? configured : undefined;
}

/** The environment opt-out applies to all three interactive TUI upload channels. */
export function resolveTuiTelemetryPolicy(
  configPath: string,
  environment: NodeJS.ProcessEnv = process.env,
): { usageEnabled: boolean; diagnosticUploadsEnabled: boolean } {
  for (const name of ['MCODE_DISABLE_TELEMETRY', 'DO_NOT_TRACK']) {
    if (/^(?:1|true|yes|on)$/iu.test(environment[name]?.trim() ?? '')) {
      return { usageEnabled: false, diagnosticUploadsEnabled: false };
    }
  }

  let usageEnabled = false;
  try {
    const { telemetry } = readConfigDocument(configPath);
    usageEnabled =
      telemetry != null &&
      typeof telemetry === 'object' &&
      Object.hasOwn(telemetry, 'enabled') &&
      (telemetry as Record<string, unknown>).enabled === true;
  } catch {
    // Missing or malformed config isn't consent to collect usage events.
  }
  return { usageEnabled, diagnosticUploadsEnabled: true };
}
