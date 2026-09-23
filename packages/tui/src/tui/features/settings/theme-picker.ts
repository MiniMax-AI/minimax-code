import { panelLayout, renderPanelFrame } from '../../widgets/panel-frame.js';
import { getKeybindings, matchesKey } from '../../engine/public.js';
import type { Component } from '../../rendering/component.js';
import { visibleWidth } from '../../rendering/text.js';
import { tuiChalk as chalk, tuiColors as colors } from '../../theme/runtime.js';
import type {
  TuiResolvedAppearance,
  TuiThemeColors,
  TuiThemeDefinition,
} from '../../theme/contracts.js';

export type TuiThemeAppearanceChoice = 'auto' | TuiResolvedAppearance;

const APPEARANCE_CHOICES = ['light', 'auto', 'dark'] as const satisfies
  readonly TuiThemeAppearanceChoice[];

export interface TuiThemePickerOptions {
  readonly themes: readonly TuiThemeDefinition[];
  readonly currentThemeId: string;
  readonly currentAppearance: TuiResolvedAppearance;
  readonly appearanceOverride: TuiResolvedAppearance | undefined;
  /** Apply without persisting, so moving the cursor previews live. */
  readonly preview: (themeId: string) => void;
  readonly setAppearance: (choice: TuiThemeAppearanceChoice) => void;
  readonly save: (themeId: string, appearance: TuiThemeAppearanceChoice) => Promise<void> | void;
  readonly onClose: () => void;
  readonly requestRender: () => void;
}

/**
 * Theme chooser. Cursor movement previews each palette immediately so the user
 * can judge a theme in the real transcript behind the panel; `Enter` persists
 * and `Esc` restores the theme that was active when the picker opened.
 */
export class TuiThemePicker implements Component {
  private selectedIndex: number;
  private originalThemeId: string;
  private originalAppearance: TuiThemeAppearanceChoice;
  private appearance: TuiThemeAppearanceChoice;
  private busy = false;
  private error = false;
  private disposed = false;

  constructor(private readonly options: TuiThemePickerOptions) {
    this.originalThemeId = options.currentThemeId;
    this.originalAppearance = options.appearanceOverride ?? 'auto';
    this.appearance = this.originalAppearance;
    const index = options.themes.findIndex((theme) => theme.id === options.currentThemeId);
    this.selectedIndex = index >= 0 ? index : 0;
  }

  handleInput(data: string): void {
    if (this.busy || this.disposed) return;
    const keys = getKeybindings();
    if (keys.matches(data, 'tui.select.cancel') || matchesKey(data, 'ctrl+c')) {
      this.restore();
      this.options.onClose();
      return;
    }
    if (keys.matches(data, 'tui.select.confirm')) {
      this.commit();
      return;
    }
    const themes = this.options.themes;
    if (themes.length === 0) return;
    if (keys.matches(data, 'tui.select.up')) {
      this.selectedIndex = (this.selectedIndex - 1 + themes.length) % themes.length;
    } else if (keys.matches(data, 'tui.select.down')) {
      this.selectedIndex = (this.selectedIndex + 1) % themes.length;
    } else if (matchesKey(data, 'left')) {
      this.shiftAppearance(-1);
    } else if (matchesKey(data, 'right')) {
      this.shiftAppearance(1);
    } else {
      return;
    }
    const focused = themes[this.selectedIndex];
    if (focused) this.options.preview(focused.id);
    this.options.requestRender();
  }

  dispose(): void {
    this.disposed = true;
  }

  invalidate(): void {}

  render(width: number): string[] {
    return this.renderViewport(width, 20);
  }

  renderViewport(width: number, height: number): string[] {
    const rows = Math.max(0, Math.floor(height));
    if (width <= 0 || rows === 0) return [];
    const themes = this.options.themes;
    const layout = panelLayout(width, rows, footerText(width, this.busy));
    if (themes.length === 0) {
      return renderPanelFrame(
        { title: 'Theme', body: ['No themes available.'], footer: footerText(width, false) },
        width,
        rows,
      );
    }
    const focused = themes[Math.min(this.selectedIndex, themes.length - 1)];
    if (!focused) return [];
    const active = focused.id === this.originalThemeId;
    const nameWidth = Math.max(
      ...themes.map((theme) => visibleWidth(theme.label)),
      visibleWidth('Appearance'),
    );
    const swatch = renderSwatch(focused, this.resolvedAppearance());
    const detail = [
      `${chalk.hex(colors.muted)('Appearance')}  ${appearanceLabel(this.appearance, this.options.currentAppearance)}`,
      `${chalk.hex(colors.muted)('Source')}     ${focused.source === 'custom' ? 'custom file' : 'built-in'}`,
      ...(focused.description
        ? [`${chalk.hex(colors.muted)('About')}      ${focused.description}`]
        : []),
      `${chalk.hex(colors.muted)('Palette')}   ${swatch}`,
    ];
    if (this.error) detail.push(chalk.hex(colors.error)('Could not save the theme selection.'));

    if (rows < 10) {
      return layout.render({
        title: 'Theme',
        body: [
          renderRow(
            focused.label,
            active,
            this.options.currentThemeId === focused.id,
            nameWidth,
            this.resolvedAppearance(),
            focused,
          ),
          ...(layout.bodyHeight >= 4 ? detail.slice(0, 2) : []),
        ],
      });
    }

    const listRows = Math.max(1, Math.min(themes.length, layout.bodyHeight - detail.length - 1));
    const start = Math.max(
      0,
      Math.min(this.selectedIndex - listRows + 1, themes.length - listRows),
    );
    return layout.render({
      title: 'Theme',
      meta: `${themes.length} available`,
      body: [
        ...themes
          .slice(start, start + listRows)
          .map((theme) =>
            renderRow(
              theme.label,
              theme.id === this.originalThemeId,
              theme.id === focused.id,
              nameWidth,
              this.resolvedAppearance(),
              theme,
            ),
          ),
        ...detail,
      ],
    });
  }

  private resolvedAppearance(): TuiResolvedAppearance {
    return this.appearance === 'auto' ? this.options.currentAppearance : this.appearance;
  }

  private shiftAppearance(step: -1 | 1): void {
    const index = APPEARANCE_CHOICES.indexOf(this.appearance);
    const next = APPEARANCE_CHOICES[Math.max(0, Math.min(index + step, APPEARANCE_CHOICES.length - 1))]!;
    if (next === this.appearance) return;
    this.appearance = next;
    this.options.setAppearance(next);
  }

  private restore(): void {
    const theme = this.options.themes.find((candidate) => candidate.id === this.originalThemeId);
    if (theme) this.options.preview(this.originalThemeId);
    this.appearance = this.originalAppearance;
    this.options.setAppearance(this.originalAppearance);
  }

  private async commit(): Promise<void> {
    const theme = this.options.themes[this.selectedIndex];
    if (!theme) return;
    if (theme.id === this.originalThemeId && this.appearance === this.originalAppearance) {
      this.options.onClose();
      return;
    }
    this.busy = true;
    this.error = false;
    this.options.requestRender();
    try {
      await this.options.save(theme.id, this.appearance);
      this.originalThemeId = theme.id;
      this.originalAppearance = this.appearance;
      if (!this.disposed) this.options.onClose();
    } catch {
      this.error = true;
    } finally {
      this.busy = false;
      if (!this.disposed) this.options.requestRender();
    }
  }
}

function appearanceLabel(
  choice: TuiThemeAppearanceChoice,
  detected: TuiResolvedAppearance,
): string {
  if (choice === 'auto') return `auto (${detected})`;
  return choice === 'light' ? 'light (pinned)' : 'dark (pinned)';
}

function renderSwatch(theme: TuiThemeDefinition, appearance: TuiResolvedAppearance): string {
  const palette = appearance === 'light' ? theme.light : theme.dark;
  const roles = [
    'brand',
    'accent',
    'markdownHeading',
    'markdownCode',
    'success',
    'warning',
    'error',
  ] as const satisfies readonly (keyof TuiThemeColors)[];
  return roles.map((role) => chalk.bgHex(palette.colors[role])('  ')).join('');
}

function renderRow(
  label: string,
  saved: boolean,
  focused: boolean,
  nameWidth: number,
  appearance: TuiResolvedAppearance,
  theme: TuiThemeDefinition,
): string {
  const marker = focused ? '›' : ' ';
  const name = focused ? chalk.bold.hex(colors.signal)(label) : chalk.hex(colors.text)(label);
  // Pad both columns so the swatches line up regardless of which row is current.
  const pad = ' '.repeat(Math.max(0, nameWidth - visibleWidth(label)));
  const badge = saved ? chalk.hex(colors.success)(CURRENT_BADGE.trim()) : '';
  const badgePad = ' '.repeat(Math.max(0, visibleWidth(CURRENT_BADGE) - visibleWidth(badge)));
  return `${marker} ${name}${pad} ${badge}${badgePad} ${renderSwatch(theme, appearance)}`;
}

const CURRENT_BADGE = ' current ';

function footerText(width: number, busy: boolean): string {
  if (busy) return 'Saving…';
  return width >= 64
    ? '↑↓ theme · ←→ appearance · Enter save · Esc cancel'
    : '↑↓ ←→ · Enter · Esc';
}
