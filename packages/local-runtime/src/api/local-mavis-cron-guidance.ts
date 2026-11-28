/**
 * Retained compatibility helper: Cron moved to dedicated `cron_*` tools in 0.8.0,
 * so `LocalMavisToolDef` never exposes Cron guidance or Cron-only schema fields.
 */
export function withoutLocalMavisCronGuidance<T>(tool: T): T {
  return tool;
}
