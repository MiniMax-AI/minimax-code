import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_THEMES,
  DEFAULT_THEME_ID,
  MINIMAX_CODE_DARK_THEME,
  MINIMAX_CODE_LIGHT_THEME,
} from '../../../../src/tui/theme/palettes.js';
import {
  TUI_SYNTAX_TONE_NAMES,
  TUI_THEME_COLOR_NAMES,
} from '../../../../src/tui/theme/contracts.js';
import {
  MINIMAX_CODE_THEME_CONTRAST_POLICY,
  contrastRatio,
} from '../../../helpers/theme-contrast.js';

/** Every palette in both appearances of every built-in theme. */
const ALL_PALETTES = BUILT_IN_THEMES.flatMap((theme) => [
  { theme, palette: theme.dark },
  { theme, palette: theme.light },
]);

describe('built-in TUI themes', () => {
  it('keeps the default MCode palette byte-identical to the pre-theme implementation', () => {
    // The default theme is what every existing user sees, so it must not move.
    expect(MINIMAX_CODE_DARK_THEME.colors).toEqual({
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
    });
    expect(MINIMAX_CODE_LIGHT_THEME.colors.text).toBe('#303030');
    expect(DEFAULT_THEME_ID).toBe('minimax');
  });

  it.each(ALL_PALETTES)(
    'enforces readable semantic colors for $theme.id $palette.appearance',
    ({ palette }) => {
      const background = MINIMAX_CODE_THEME_CONTRAST_POLICY.backgrounds[palette.appearance];

      for (const role of MINIMAX_CODE_THEME_CONTRAST_POLICY.normalText.roles) {
        const exception = MINIMAX_CODE_THEME_CONTRAST_POLICY.normalText.exceptions.find(
          (candidate) => candidate.appearance === palette.appearance && candidate.role === role,
        );
        expect(
          contrastRatio(palette.colors[role], background),
          `${palette.id}.${palette.appearance}.${role} must remain readable against ${background}`,
        ).toBeGreaterThanOrEqual(
          exception?.minimum ?? MINIMAX_CODE_THEME_CONTRAST_POLICY.normalText.minimum,
        );
      }
      for (const role of MINIMAX_CODE_THEME_CONTRAST_POLICY.nonText.roles) {
        expect(
          contrastRatio(palette.colors[role], background),
          `${palette.id}.${palette.appearance}.${role} must stay distinguishable against ${background}`,
        ).toBeGreaterThanOrEqual(MINIMAX_CODE_THEME_CONTRAST_POLICY.nonText.minimum);
      }
    },
  );

  it.each(ALL_PALETTES)(
    'defines every color and syntax tone for $theme.id $palette.appearance',
    ({ palette }) => {
      for (const name of TUI_THEME_COLOR_NAMES) {
        expect(palette.colors[name], `${palette.id}.${name}`).toMatch(
          /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu,
        );
      }
      for (const tone of TUI_SYNTAX_TONE_NAMES) {
        expect(palette.syntax[tone], `${palette.id}.syntax.${tone}`).toMatch(
          /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu,
        );
      }
    },
  );

  it.each(ALL_PALETTES)(
    'keeps syntax text legible for $theme.id $palette.appearance',
    ({ palette }) => {
      const background = MINIMAX_CODE_THEME_CONTRAST_POLICY.backgrounds[palette.appearance];
      // Comments are the lowest-emphasis token but still have to be readable.
      expect(contrastRatio(palette.syntax.overlay2, background)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(palette.syntax.text, background)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it('gives every built-in theme a matching id across both appearances', () => {
    for (const theme of BUILT_IN_THEMES) {
      expect(theme.dark.id).toBe(theme.id);
      expect(theme.light.id).toBe(theme.id);
      expect(theme.source).toBe('builtin');
      expect(theme.label.length).toBeGreaterThan(0);
    }
    const ids = BUILT_IN_THEMES.map((theme) => theme.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
