export interface TuiProductFeatures {
  readonly queue: boolean;
  /** `/advisor`: the launcher turns it off in packages without the advisor (`beta.advisor`). */
  readonly advisor: boolean;
}

export const MINIMAX_CODE_MVP_TUI_PRODUCT_FEATURES: TuiProductFeatures = Object.freeze({
  queue: true,
  advisor: true,
});

export function resolveTuiProductFeatures(
  overrides: Partial<TuiProductFeatures> | undefined,
): TuiProductFeatures {
  return {
    ...MINIMAX_CODE_MVP_TUI_PRODUCT_FEATURES,
    ...overrides,
  };
}
