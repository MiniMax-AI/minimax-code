export type TuiResolvedAppearance = 'light' | 'dark';
export type TuiColorLevel = 0 | 1 | 2 | 3;

export type TuiThemeDetectionSource = 'terminal-report' | 'osc11' | 'colorfgbg' | 'fallback';

export interface TuiThemeDetection {
  readonly appearance: TuiResolvedAppearance;
  readonly source: TuiThemeDetectionSource;
  readonly detail: string;
}

export interface TuiThemeColors {
  readonly brand: string;
  readonly wordmarkHighlight: string;
  readonly wordmarkShadow: string;
  readonly signal: string;
  readonly orbit: string;
  readonly accent: string;
  readonly markdownHeading: string;
  readonly markdownCode: string;
  readonly markdownLink: string;
  readonly userMessageBg: string;
  readonly diffAddedBg: string;
  readonly diffRemovedBg: string;
  readonly text: string;
  readonly muted: string;
  readonly dim: string;
  readonly border: string;
  readonly line: string;
  readonly success: string;
  readonly warning: string;
  readonly error: string;
}

/**
 * Syntax tones drive `cli-highlight` token mapping. They are kept beside — not
 * inside — {@link TuiThemeColors} so terminal ANSI16 role resolution keeps
 * iterating a flat list of paintable colors.
 */
export interface TuiThemeSyntaxTones {
  readonly blue: string;
  readonly flamingo: string;
  readonly green: string;
  readonly mauve: string;
  readonly overlay2: string;
  readonly peach: string;
  readonly pink: string;
  readonly red: string;
  readonly sapphire: string;
  readonly subtext0: string;
  readonly teal: string;
  readonly text: string;
  readonly yellow: string;
}

export const TUI_SYNTAX_TONE_NAMES = [
  'blue',
  'flamingo',
  'green',
  'mauve',
  'overlay2',
  'peach',
  'pink',
  'red',
  'sapphire',
  'subtext0',
  'teal',
  'text',
  'yellow',
] as const satisfies readonly (keyof TuiThemeSyntaxTones)[];

export type TuiThemeSyntaxTone = (typeof TUI_SYNTAX_TONE_NAMES)[number];

export const TUI_THEME_COLOR_NAMES = [
  'brand',
  'wordmarkHighlight',
  'wordmarkShadow',
  'signal',
  'orbit',
  'accent',
  'markdownHeading',
  'markdownCode',
  'markdownLink',
  'userMessageBg',
  'diffAddedBg',
  'diffRemovedBg',
  'text',
  'muted',
  'dim',
  'border',
  'line',
  'success',
  'warning',
  'error',
] as const satisfies readonly (keyof TuiThemeColors)[];

export type TuiThemeColorName = (typeof TUI_THEME_COLOR_NAMES)[number];

export interface TuiThemePalette {
  readonly id: string;
  readonly appearance: TuiResolvedAppearance;
  readonly colors: TuiThemeColors;
  readonly syntax: TuiThemeSyntaxTones;
}

export type TuiThemeSource = 'builtin' | 'custom';

/**
 * A user-selectable named theme. Every theme ships both appearances so a
 * terminal that switches to light never falls back to a foreign palette.
 */
export interface TuiThemeDefinition {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly source: TuiThemeSource;
  readonly dark: TuiThemePalette;
  readonly light: TuiThemePalette;
  /** Absolute path for custom themes, used to offer file-level feedback. */
  readonly filePath?: string;
  /** Validation diagnostics for partially loaded custom themes. */
  readonly issues?: readonly string[];
}

export interface TuiThemeSnapshot extends TuiThemeDetection {
  readonly colorLevel: TuiColorLevel;
  readonly themeId: string;
}
