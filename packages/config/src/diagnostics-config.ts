import path from 'node:path';

/**
 * Verification-only runtime diagnostics. Product configs leave this tree out;
 * verification instances point it at files inside their own data dir.
 */
export interface DiagnosticsConfig {
  /**
   * Absolute path of a steer delivery fault rules file. When set, the runtime
   * reads it at each side-message steer delivery to substitute a race outcome.
   */
  steerFaultFile?: string;
  /** Verification only: Turn fault rules file, read at each Turn start before any history write. */
  turnFaultFile?: string;
}

/** Only absolute, non-empty fault file paths enable the tree; anything else is dropped. */
export function parseDiagnosticsConfig(raw: unknown): DiagnosticsConfig | undefined {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const config: DiagnosticsConfig = {};
  for (const key of ['steerFaultFile', 'turnFaultFile'] as const) {
    const value: unknown = Reflect.get(raw, key);
    if (typeof value === 'string' && path.isAbsolute(value)) config[key] = value;
  }
  return Object.keys(config).length ? config : undefined;
}
