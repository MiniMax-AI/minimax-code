import type { ChalkInstance } from 'chalk';
import type { Theme } from 'cli-highlight';
import { type TuiThemeSyntaxTones, type TuiResolvedAppearance } from './contracts.js';

export type SyntaxTone = keyof TuiThemeSyntaxTones;

export const CATPPUCCIN_SYNTAX_TONES: Readonly<Record<TuiResolvedAppearance, TuiThemeSyntaxTones>> =
  Object.freeze({
    dark: Object.freeze({
      blue: '#89B4FA',
      flamingo: '#F2CDCD',
      green: '#A6E3A1',
      mauve: '#CBA6F7',
      overlay2: '#9399B2',
      peach: '#FAB387',
      pink: '#F5C2E7',
      red: '#F38BA8',
      sapphire: '#74C7EC',
      subtext0: '#A6ADC8',
      teal: '#94E2D5',
      text: '#CDD6F4',
      yellow: '#F9E2AF',
    }),
    light: Object.freeze({
      blue: '#1E66F5',
      flamingo: '#DD7878',
      green: '#40A02B',
      mauve: '#8839EF',
      overlay2: '#7C7F93',
      peach: '#FE640B',
      pink: '#EA76CB',
      red: '#D20F39',
      sapphire: '#209FB5',
      subtext0: '#6C6F85',
      teal: '#179299',
      text: '#4C4F69',
      yellow: '#DF8E1D',
    }),
  });

/**
 * Pastel RGB colors collapse to white when Chalk approximates them to ANSI16.
 * Keep token families distinct using the terminal's own semantic palette.
 */
const ANSI16_SYNTAX_STYLES = {
  dark: {
    blue: 'blueBright',
    flamingo: 'magentaBright',
    green: 'greenBright',
    mauve: 'magentaBright',
    overlay2: 'whiteBright',
    peach: 'yellowBright',
    pink: 'magentaBright',
    red: 'redBright',
    sapphire: 'cyanBright',
    subtext0: 'white',
    teal: 'cyanBright',
    text: 'white',
    yellow: 'yellowBright',
  },
  light: {
    blue: 'blue',
    flamingo: 'magenta',
    green: 'green',
    mauve: 'magenta',
    overlay2: 'gray',
    peach: 'yellow',
    pink: 'magenta',
    red: 'red',
    sapphire: 'cyan',
    subtext0: 'black',
    teal: 'cyan',
    text: 'black',
    yellow: 'yellow',
  },
} as const satisfies Record<TuiResolvedAppearance, Record<SyntaxTone, keyof ChalkInstance>>;

/**
 * Builds the Highlight.js token map for whichever theme is currently active.
 * `tones` is read on every call so a theme switch is picked up without
 * re-creating the highlight theme object.
 */
export function createSyntaxHighlightTheme(
  chalk: ChalkInstance,
  tones: () => TuiThemeSyntaxTones,
  appearance: () => TuiResolvedAppearance,
): Theme {
  const color = (tone: SyntaxTone) => (text: string) => {
    const mode = appearance();
    if (chalk.level !== 1) return chalk.hex(tones()[tone])(text);
    const styled = chalk[ANSI16_SYNTAX_STYLES[mode][tone]](text);
    // Bright white + dim remains legible where ANSI bright-black is very dark.
    return mode === 'dark' && tone === 'overlay2' ? chalk.dim(styled) : styled;
  };
  const strong = (text: string) => chalk.bold(color('red')(text));

  // Highlight.js token mapping, adapted to ANSI output. As in Codex,
  // terminal-hostile italic, underline, and syntax-theme backgrounds are intentionally omitted.
  return {
    default: color('text'),
    keyword: color('mauve'),
    built_in: color('red'),
    type: color('yellow'),
    literal: color('peach'),
    number: color('peach'),
    regexp: color('pink'),
    string: color('green'),
    subst: color('subtext0'),
    symbol: color('flamingo'),
    class: color('yellow'),
    function: color('blue'),
    title: color('blue'),
    params: color('text'),
    comment: color('overlay2'),
    doctag: color('red'),
    meta: color('peach'),
    'meta-keyword': color('peach'),
    'meta-string': color('green'),
    section: color('blue'),
    tag: color('teal'),
    name: color('mauve'),
    'builtin-name': color('red'),
    attr: color('blue'),
    attribute: color('green'),
    variable: color('mauve'),
    bullet: color('teal'),
    code: color('green'),
    emphasis: color('red'),
    strong,
    formula: color('teal'),
    link: color('sapphire'),
    quote: color('green'),
    'selector-tag': color('yellow'),
    'selector-id': color('blue'),
    'selector-class': color('teal'),
    'selector-attr': color('mauve'),
    'selector-pseudo': color('teal'),
    'template-tag': color('flamingo'),
    'template-variable': color('flamingo'),
    addition: color('green'),
    deletion: color('red'),
  };
}
