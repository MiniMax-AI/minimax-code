import type {
  TuiResolvedAppearance,
  TuiThemeColors,
  TuiThemeDefinition,
  TuiThemeSyntaxTones,
} from './contracts.js';
import { CATPPUCCIN_SYNTAX_TONES } from './syntax.js';

function palette(
  id: string,
  appearance: TuiResolvedAppearance,
  colors: TuiThemeColors,
  syntax: TuiThemeSyntaxTones,
) {
  return Object.freeze({
    id,
    appearance,
    colors: Object.freeze(colors),
    syntax: Object.freeze(syntax),
  });
}

/**
 * Default MCode palette. The values are frozen in place so a theme switch can
 * never mutate a palette another theme still references.
 */
export const MINIMAX_CODE_DARK_THEME = palette(
  'minimax',
  'dark',
  {
    brand: '#68C0FF',
    wordmarkHighlight: '#93D2FF',
    wordmarkShadow: '#3DAEFF',
    signal: '#68C0FF',
    orbit: '#1CCDD2',
    accent: '#68C0FF',
    markdownHeading: '#CBA6F7',
    markdownCode: '#A6E3A1',
    markdownLink: '#68C0FF',
    userMessageBg: '#262626',
    diffAddedBg: '#213A2B',
    diffRemovedBg: '#4A221D',
    text: '#D6D6D6',
    muted: '#ADADAD',
    dim: '#666666',
    border: '#303030',
    line: '#666666',
    success: '#28C567',
    warning: '#FFC340',
    error: '#FF5E6C',
  },
  CATPPUCCIN_SYNTAX_TONES.dark,
);

export const MINIMAX_CODE_LIGHT_THEME = palette(
  'minimax',
  'light',
  {
    brand: '#0094FC',
    wordmarkHighlight: '#3DAEFF',
    wordmarkShadow: '#0077D9',
    signal: '#0094FC',
    orbit: '#00767D',
    accent: '#0094FC',
    markdownHeading: '#8839EF',
    markdownCode: '#267A3F',
    markdownLink: '#0066CC',
    userMessageBg: '#F5F5F5',
    diffAddedBg: '#DAFBE1',
    diffRemovedBg: '#FFEBE9',
    text: '#303030',
    muted: '#666666',
    dim: '#949494',
    border: '#EDEDED',
    line: '#949494',
    success: '#008635',
    warning: '#916300',
    error: '#E31937',
  },
  CATPPUCCIN_SYNTAX_TONES.light,
);

/** Default palette for the active appearance. */
export function defaultPalette(appearance: TuiResolvedAppearance) {
  return appearance === 'light' ? MINIMAX_CODE_LIGHT_THEME : MINIMAX_CODE_DARK_THEME;
}

// ---------------------------------------------------------------------------
// Built-in named themes
// ---------------------------------------------------------------------------

/**
 * Midnight keeps the MCode blue but deepens the background toward a blue-black
 * and lifts foreground contrast, which suits high-DPI and OLED terminals.
 */
const MIDNIGHT: TuiThemeDefinition = Object.freeze({
  id: 'midnight',
  label: 'Midnight',
  description: 'Deep blue-black with lifted contrast',
  source: 'builtin',
  dark: palette(
    'midnight',
    'dark',
    {
      brand: '#5AB9FF',
      wordmarkHighlight: '#8FD0FF',
      wordmarkShadow: '#3A9BE0',
      signal: '#5AB9FF',
      orbit: '#2AD4DE',
      accent: '#5AB9FF',
      markdownHeading: '#B79CFF',
      markdownCode: '#7EE787',
      markdownLink: '#5AB9FF',
      userMessageBg: '#141A22',
      diffAddedBg: '#12301F',
      diffRemovedBg: '#3D1A1A',
      text: '#E6EDF3',
      muted: '#9AA7B4',
      dim: '#6B7785',
      border: '#232C36',
      line: '#7D8B99',
      success: '#3FB950',
      warning: '#E3B341',
      error: '#F85149',
    },
    {
      blue: '#79C0FF',
      flamingo: '#F0B7B0',
      green: '#7EE787',
      mauve: '#D2A8FF',
      overlay2: '#8B949E',
      peach: '#FFA657',
      pink: '#F778BA',
      red: '#FF7B72',
      sapphire: '#A5D6FF',
      subtext0: '#B1BAC4',
      teal: '#39C5CF',
      text: '#C9D1D9',
      yellow: '#D29922',
    },
  ),
  light: palette(
    'midnight',
    'light',
    {
      brand: '#0A6FCE',
      wordmarkHighlight: '#3DAEFF',
      wordmarkShadow: '#07599F',
      signal: '#0A6FCE',
      orbit: '#0B7A82',
      accent: '#0A6FCE',
      markdownHeading: '#7A3FD1',
      markdownCode: '#1A7F37',
      markdownLink: '#0550AE',
      userMessageBg: '#F2F5F9',
      diffAddedBg: '#DDFBE4',
      diffRemovedBg: '#FFE7E5',
      text: '#1F2933',
      muted: '#52606D',
      dim: '#7B8794',
      border: '#E4E9EF',
      line: '#6B7785',
      success: '#0F7B33',
      warning: '#8A6100',
      error: '#C21F39',
    },
    {
      blue: '#0550AE',
      flamingo: '#B3594F',
      green: '#116329',
      mauve: '#8250DF',
      overlay2: '#6E7781',
      peach: '#953800',
      pink: '#BF3989',
      red: '#CF222E',
      sapphire: '#1F6FEB',
      subtext0: '#57606A',
      teal: '#137C8B',
      text: '#24292F',
      yellow: '#9A6700',
    },
  ),
});

/** Graphite strips most chroma from surfaces so dense logs stay calm. */
const GRAPHITE: TuiThemeDefinition = Object.freeze({
  id: 'graphite',
  label: 'Graphite',
  description: 'Neutral low-chroma surfaces for dense output',
  source: 'builtin',
  dark: palette(
    'graphite',
    'dark',
    {
      brand: '#68C0FF',
      wordmarkHighlight: '#9BD8FF',
      wordmarkShadow: '#3D9AD6',
      signal: '#68C0FF',
      orbit: '#5AC8D2',
      accent: '#68C0FF',
      markdownHeading: '#C9D1D9',
      markdownCode: '#A5D6A7',
      markdownLink: '#68C0FF',
      userMessageBg: '#22262B',
      diffAddedBg: '#1B3324',
      diffRemovedBg: '#3B2426',
      text: '#DDE1E6',
      muted: '#A8B0B8',
      dim: '#71797F',
      border: '#2E3338',
      line: '#848C94',
      success: '#3FB463',
      warning: '#E0A92E',
      error: '#F2606B',
    },
    {
      blue: '#7FB8E8',
      flamingo: '#D9A0A8',
      green: '#9CCFA5',
      mauve: '#B5AEDA',
      overlay2: '#8A9199',
      peach: '#D9A97E',
      pink: '#D5A8C4',
      red: '#E08087',
      sapphire: '#8FC9E0',
      subtext0: '#AEB5BC',
      teal: '#7FC5CB',
      text: '#D7DBDF',
      yellow: '#D6C07A',
    },
  ),
  light: palette(
    'graphite',
    'light',
    {
      brand: '#0B6FB8',
      wordmarkHighlight: '#3DAEFF',
      wordmarkShadow: '#07558F',
      signal: '#0B6FB8',
      orbit: '#0C7680',
      accent: '#0B6FB8',
      markdownHeading: '#3D444D',
      markdownCode: '#1F7A3D',
      markdownLink: '#0A5C9E',
      userMessageBg: '#F4F5F6',
      diffAddedBg: '#E2F3E6',
      diffRemovedBg: '#FBE6E7',
      text: '#2B3036',
      muted: '#565E66',
      dim: '#7C848C',
      border: '#E6E8EA',
      line: '#767E86',
      success: '#0F7033',
      warning: '#835A00',
      error: '#B5202E',
    },
    {
      blue: '#2C6FAF',
      flamingo: '#9E5A5F',
      green: '#2F7A42',
      mauve: '#6A5AA8',
      overlay2: '#6D747B',
      peach: '#96602A',
      pink: '#9A4E80',
      red: '#B23A44',
      sapphire: '#2A7F9E',
      subtext0: '#5B636B',
      teal: '#237A82',
      text: '#2B3036',
      yellow: '#8A6D1F',
    },
  ),
});

/** Aurora pushes the secondary ramp toward cyan and mint. */
const AURORA: TuiThemeDefinition = Object.freeze({
  id: 'aurora',
  label: 'Aurora',
  description: 'Cool cyan and mint secondary ramp',
  source: 'builtin',
  dark: palette(
    'aurora',
    'dark',
    {
      brand: '#5CC8E8',
      wordmarkHighlight: '#8FE0F5',
      wordmarkShadow: '#38A5C4',
      signal: '#5CC8E8',
      orbit: '#5FE3B0',
      accent: '#5CC8E8',
      markdownHeading: '#8FD9C0',
      markdownCode: '#7BE0B4',
      markdownLink: '#5CC8E8',
      userMessageBg: '#16232A',
      diffAddedBg: '#113028',
      diffRemovedBg: '#3A1F26',
      text: '#DCE9EE',
      muted: '#93AAB3',
      dim: '#647D86',
      border: '#22333B',
      line: '#7E99A3',
      success: '#4FD18B',
      warning: '#E8C15A',
      error: '#F2788A',
    },
    {
      blue: '#6FC7E8',
      flamingo: '#E8A9A0',
      green: '#6FE0AE',
      mauve: '#8FC9D9',
      overlay2: '#7E99A3',
      peach: '#E8B88C',
      pink: '#E5A8CE',
      red: '#F2788A',
      sapphire: '#5AD4D4',
      subtext0: '#A8C0C9',
      teal: '#5FE3B0',
      text: '#DCE9EE',
      yellow: '#E8D08A',
    },
  ),
  light: palette(
    'aurora',
    'light',
    {
      brand: '#0A6E8C',
      wordmarkHighlight: '#2FA8C9',
      wordmarkShadow: '#07536A',
      signal: '#0A6E8C',
      orbit: '#0C7A5C',
      accent: '#0A6E8C',
      markdownHeading: '#0F6B57',
      markdownCode: '#0F7350',
      markdownLink: '#075C78',
      userMessageBg: '#F1F6F8',
      diffAddedBg: '#DDF3E9',
      diffRemovedBg: '#FBE7EC',
      text: '#1E2B31',
      muted: '#4E646D',
      dim: '#758D96',
      border: '#E2EBEE',
      line: '#6B8590',
      success: '#0E7A52',
      warning: '#856000',
      error: '#B32B45',
    },
    {
      blue: '#0E6E8C',
      flamingo: '#9E5A56',
      green: '#0F7350',
      mauve: '#0F6A72',
      overlay2: '#6B8590',
      peach: '#8A5A28',
      pink: '#8E4470',
      red: '#B32B45',
      sapphire: '#0A7A7D',
      subtext0: '#5A737D',
      teal: '#0C7A5C',
      text: '#1E2B31',
      yellow: '#7A6418',
    },
  ),
});

export const DEFAULT_THEME_ID = 'minimax';

/**
 * The theme every lookup falls back to. Exported as a concrete value so callers
 * never have to assert a built-in exists.
 */
export const DEFAULT_THEME: TuiThemeDefinition = Object.freeze({
  id: MINIMAX_CODE_DARK_THEME.id,
  label: 'MCode',
  description: 'The default MCode blue palette',
  source: 'builtin',
  dark: MINIMAX_CODE_DARK_THEME,
  light: MINIMAX_CODE_LIGHT_THEME,
});

export const BUILT_IN_THEMES: readonly TuiThemeDefinition[] = Object.freeze([
  DEFAULT_THEME,
  MIDNIGHT,
  GRAPHITE,
  AURORA,
]);

export function builtinTheme(id: string): TuiThemeDefinition | undefined {
  return BUILT_IN_THEMES.find((theme) => theme.id === id);
}
