// ── Plugin Recommendation ────────────────────────────────────────

/** Canonical marketplace plugin name accepted by `pluginRecommendation.dismissedPlugins`. */
const PLUGIN_RECOMMENDATION_PLUGIN_NAME_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const PLUGIN_RECOMMENDATION_PLUGIN_NAME_MAX_LENGTH = 80;
export const PLUGIN_RECOMMENDATION_DISMISSED_MAX = 200;

/**
 * Desktop plugin recommendation preferences, stored per data directory.
 * `enabled` defaults to true; `dismissedPlugins` lists canonical plugin names
 * the user chose "don't recommend again" for.
 */
export interface PluginRecommendationConfig {
  enabled?: boolean;
  dismissedPlugins?: string[];
}

export function isPluginRecommendationPluginName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= PLUGIN_RECOMMENDATION_PLUGIN_NAME_MAX_LENGTH &&
    PLUGIN_RECOMMENDATION_PLUGIN_NAME_PATTERN.test(value)
  );
}

/** Read-side parse: invalid or duplicate names are dropped, the list is capped. */
export function parsePluginRecommendationConfig(
  raw: Record<string, unknown>,
): PluginRecommendationConfig {
  const value = raw.pluginRecommendation;
  const obj =
    value != null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const dismissed = Array.isArray(obj.dismissedPlugins)
    ? [...new Set(obj.dismissedPlugins.filter(isPluginRecommendationPluginName))].slice(
        0,
        PLUGIN_RECOMMENDATION_DISMISSED_MAX,
      )
    : [];
  return {
    enabled: typeof obj.enabled === 'boolean' ? obj.enabled : true,
    dismissedPlugins: dismissed,
  };
}
