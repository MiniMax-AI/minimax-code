import type { TuiResolvedAppearance, TuiThemeDefinition, TuiThemePalette } from './contracts.js';
import type { TuiThemeLoadIssue, TuiThemeLoadResult } from './custom-themes.js';
import { BUILT_IN_THEMES, DEFAULT_THEME, DEFAULT_THEME_ID } from './palettes.js';

/**
 * Owns the set of selectable themes for one TUI process.
 *
 * Built-ins are always present; custom files are layered on top and may be
 * replaced at runtime when a watched theme file changes. A selected id that no
 * longer resolves (file deleted, renamed, invalid) degrades to the default
 * theme instead of leaving the TUI unpainted.
 */
export class TuiThemeRegistry {
  private customThemes: readonly TuiThemeDefinition[] = [];
  private issues: readonly TuiThemeLoadIssue[] = [];
  private selectedId: string = DEFAULT_THEME_ID;

  applyLoadResult(result: TuiThemeLoadResult): void {
    this.customThemes = result.themes;
    this.issues = result.issues;
    if (!this.resolve(this.selectedId)) this.selectedId = DEFAULT_THEME_ID;
  }

  setIssues(issues: readonly TuiThemeLoadIssue[]): void {
    this.issues = issues;
  }

  list(): readonly TuiThemeDefinition[] {
    return [...BUILT_IN_THEMES, ...this.customThemes];
  }

  issuesList(): readonly TuiThemeLoadIssue[] {
    return this.issues;
  }

  resolve(id: string): TuiThemeDefinition | undefined {
    const normalized = id.trim().toLowerCase();
    return this.list().find((theme) => theme.id === normalized);
  }

  selected(): TuiThemeDefinition {
    return this.resolve(this.selectedId) ?? DEFAULT_THEME;
  }

  selectedIdValue(): string {
    return this.selected().id;
  }

  /**
   * Select a theme by id. Returns the resolved definition, or `undefined` when
   * the id is unknown so the caller can surface the failure without mutating
   * the current selection.
   */
  select(id: string): TuiThemeDefinition | undefined {
    const resolved = this.resolve(id);
    if (!resolved) return undefined;
    this.selectedId = resolved.id;
    return resolved;
  }

  /**
   * Normalize a persisted or CLI-supplied value. `light/dark` selects an
   * explicit appearance while keeping the current theme, which is the syntax
   * MCode uses to pin a terminal that reports its background unreliably.
   */
  resolveSelection(value: string | undefined): {
    readonly themeId: string;
    readonly appearanceOverride?: TuiResolvedAppearance;
  } {
    const raw = value?.trim();
    if (!raw) return { themeId: DEFAULT_THEME_ID };
    const pair = /^([a-z0-9._-]+)\/(light|dark)$/iu.exec(raw);
    if (pair?.[1] && pair[2]) {
      const theme = this.resolve(pair[1]);
      if (theme)
        return {
          themeId: theme.id,
          appearanceOverride: pair[2].toLowerCase() as TuiResolvedAppearance,
        };
    }
    return { themeId: this.resolve(raw)?.id ?? DEFAULT_THEME_ID };
  }

  palette(themeId: string, appearance: TuiResolvedAppearance): TuiThemePalette {
    const theme = this.resolve(themeId) ?? DEFAULT_THEME;
    return appearance === 'light' ? theme.light : theme.dark;
  }

  paletteFor(appearance: TuiResolvedAppearance): TuiThemePalette {
    return this.palette(this.selectedIdValue(), appearance);
  }
}
