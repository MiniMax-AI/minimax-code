/** Whole tokens from ten up; one decimal below, matching DeepSeek Harness. */
export function formatTokensPerSecond(value: number): string {
  return String(value >= 10 ? Math.round(value) : Math.round(value * 10) / 10);
}
