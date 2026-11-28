/** Telemetry factories fall back to no-ops inside Vitest, so tests never reach a real endpoint. */
export function isVitestRuntime(): boolean {
  return (
    Boolean((import.meta as ImportMeta & { vitest?: unknown }).vitest) ||
    process.env.VITEST === 'true'
  );
}
