import type { TuiThemeColors } from '../../src/tui/theme/contracts.js';

type TuiThemeColorRole = keyof TuiThemeColors;

export const MINIMAX_CODE_THEME_CONTRAST_POLICY = Object.freeze({
  backgrounds: Object.freeze({
    dark: '#000000',
    light: '#FFFFFF',
  }),
  normalText: Object.freeze({
    minimum: 4.5,
    roles: Object.freeze([
      'signal',
      'orbit',
      'accent',
      'markdownHeading',
      'markdownCode',
      'markdownLink',
      'text',
      'muted',
      'success',
      'warning',
      'error',
    ] satisfies readonly TuiThemeColorRole[]),
    exceptions: Object.freeze([
      Object.freeze({ appearance: 'light', role: 'signal', minimum: 3 }),
      Object.freeze({ appearance: 'light', role: 'accent', minimum: 3 }),
    ] satisfies readonly {
      readonly appearance: 'light' | 'dark';
      readonly role: TuiThemeColorRole;
      readonly minimum: number;
    }[]),
  }),
  nonText: Object.freeze({
    minimum: 3,
    roles: Object.freeze(['line'] satisfies readonly TuiThemeColorRole[]),
  }),
});

export function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(hex: string): number {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(hex);
  if (!match) throw new Error(`Expected a six-digit hex color, received ${hex}`);
  const [, red = '00', green = '00', blue = '00'] = match;
  const linearize = (channel: string): number => {
    const value = Number.parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linearize(red) + 0.7152 * linearize(green) + 0.0722 * linearize(blue);
}
