import type { NotificationsConfig, PluginsConfig, StartupRecoveryFaultConfig } from './config.js';

export function parsePluginsConfig(raw: unknown): PluginsConfig {
  if (raw === undefined) return { forbidden: [] };
  if (
    raw === null ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    (Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null)
  ) {
    throw new Error('Invalid plugins config: expected an object.');
  }
  const { forbidden } = raw as Record<string, unknown>;
  if (forbidden === undefined) return { forbidden: [] };
  if (!Array.isArray(forbidden)) {
    throw new Error('Invalid plugins.forbidden config: expected an array of plugin names.');
  }

  const names = new Set<string>();
  for (const [index, name] of forbidden.entries()) {
    if (!isPluginNameEntry(name)) {
      throw new Error(
        `Invalid plugins.forbidden[${index}]: expected a non-empty plugin name string.`,
      );
    }
    names.add(normalizePluginName(name));
  }
  return { forbidden: [...names] };
}

/** What counts as one plugins.forbidden entry; the parser and the fail-closed path share it. */
function isPluginNameEntry(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * How plugin names compare against plugins.forbidden: trimmed, NFKC, lowercased.
 * Every place that enforces the deny-list uses this, so it cannot drift from
 * what the list stores.
 */
export function normalizePluginName(name: string): string {
  return name.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

/**
 * The plugins.forbidden names that are still readable in an invalid plugins
 * section. Failing closed keeps them: dropping the list would load official
 * plugins the user turned off.
 */
export function readableForbiddenPlugins(raw: unknown): string[] {
  const forbidden =
    raw != null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).forbidden
      : undefined;
  if (!Array.isArray(forbidden)) return [];
  return [...new Set(forbidden.filter(isPluginNameEntry).map(normalizePluginName))];
}

export function parseStartupRecoveryFault(raw: unknown): {
  startupRecoveryFault?: StartupRecoveryFaultConfig;
} {
  if (!raw || typeof raw !== 'object') return {};
  const step: unknown = Reflect.get(raw, 'step');
  const mode: unknown = Reflect.get(raw, 'mode');
  if (typeof step !== 'string' || (mode !== 'hang' && mode !== 'fail')) return {};
  return { startupRecoveryFault: { step, mode } };
}

export function parseNotificationsConfig(raw: unknown): NotificationsConfig | undefined {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  return {
    branchFinish: typeof obj.branchFinish === 'boolean' ? obj.branchFinish : false,
  };
}
