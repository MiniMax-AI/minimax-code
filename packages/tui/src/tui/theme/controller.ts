import { applyTuiRenderTheme, paletteSignature } from './runtime.js';
import type {
  TuiColorLevel,
  TuiResolvedAppearance,
  TuiThemeDefinition,
  TuiThemeDetection,
  TuiThemeSnapshot,
} from './contracts.js';
import { type RgbColor, appearanceFromRgb, resolveEnvironmentAppearance } from './detection.js';
import { DEFAULT_THEME_ID } from './palettes.js';
import {
  loadCustomThemes,
  watchCustomThemes,
  type TuiThemeLoadIssue,
  type TuiThemeLoadResult,
} from './custom-themes.js';
import { TuiThemeRegistry } from './registry.js';
import type { TUI } from '../engine/public.js';

export type TuiThemeUi = Pick<
  TUI,
  | 'onTerminalColorSchemeChange'
  | 'queryTerminalBackgroundColor'
  | 'setTerminalColorSchemeNotifications'
>;

export interface TuiThemeControllerOptions {
  readonly ui: TuiThemeUi;
  readonly colorLevel: TuiColorLevel;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly queryTimeoutMs?: number;
  /** dataDir enables custom theme discovery and hot reload. */
  readonly dataDir?: string;
  /** Persisted or CLI-supplied selection, e.g. `aurora` or `aurora/dark`. */
  readonly theme?: string;
  readonly onDetection?: (detection: TuiThemeSnapshot) => void;
  readonly onThemesChanged?: (themes: readonly TuiThemeDefinition[]) => void;
}

export class TuiThemeController {
  private readonly ui: TuiThemeUi;
  private readonly colorLevel: TuiColorLevel;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly queryTimeoutMs: number;
  private readonly onDetection: ((detection: TuiThemeSnapshot) => void) | undefined;
  private readonly onThemesChanged: ((themes: readonly TuiThemeDefinition[]) => void) | undefined;
  private readonly registry = new TuiThemeRegistry();
  private state: TuiThemeSnapshot;
  private readonly listeners = new Set<(snapshot: TuiThemeSnapshot) => void>();
  private stopTracking: (() => void) | undefined;
  private stopThemeWatch: (() => void) | undefined;
  private refreshSequence = 0;
  private started = false;
  /**
   * Latest appearance pushed by the terminal through DEC 2031. It stays live for the whole
   * Session, so it outranks `COLORFGBG`, which is only a process-start snapshot.
   */
  private reportedAppearance: TuiResolvedAppearance | undefined;
  /** When set, auto-detection stops overriding the appearance. */
  private appearanceOverride: TuiResolvedAppearance | undefined;
  /** Latest terminal/env verdict, never replaced by {@link appearanceOverride}. */
  private latestDetection: TuiThemeDetection;
  /** Signature of the palette currently bound to the render layer. */
  private activeSignature = '';

  constructor(options: TuiThemeControllerOptions) {
    this.ui = options.ui;
    this.colorLevel = options.colorLevel;
    this.env = options.env ?? process.env;
    this.queryTimeoutMs = options.queryTimeoutMs ?? 250;
    this.onDetection = options.onDetection;
    this.onThemesChanged = options.onThemesChanged;

    if (options.dataDir) {
      this.applyLoadResult(loadCustomThemes(options.dataDir));
      this.startThemeWatch(options.dataDir);
    }
    const selection = this.registry.resolveSelection(options.theme);
    this.appearanceOverride = selection.appearanceOverride;
    const theme = this.registry.select(selection.themeId) ?? this.registry.selected();

    const detected = resolveEnvironmentAppearance(this.env);
    // Keep the terminal's own verdict separate from the pinned appearance so
    // clearing the pin can restore it without waiting for another query.
    this.latestDetection = detected;
    this.state = {
      ...detected,
      // A pinned appearance must win on the very first frame, not only after the
      // first terminal query resolves.
      appearance: this.appearanceOverride ?? detected.appearance,
      colorLevel: this.colorLevel,
      themeId: theme.id,
    };
    this.activeSignature = paletteSignature(this.registry.paletteFor(this.state.appearance));
    this.onDetection?.(this.snapshot());
    this.applyRenderTheme();
  }

  snapshot(): TuiThemeSnapshot {
    return { ...this.state };
  }

  onChange(listener: (snapshot: TuiThemeSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listThemes(): readonly TuiThemeDefinition[] {
    return this.registry.list();
  }

  themeIssues(): readonly TuiThemeLoadIssue[] {
    return this.registry.issuesList();
  }

  selectedThemeId(): string {
    return this.registry.selectedIdValue();
  }

  /**
   * Apply a theme by id without persisting it. Returns the resolved definition,
   * or `undefined` when the id is unknown so the caller can keep the previous
   * theme and report the failure.
   */
  setTheme(id: string): TuiThemeDefinition | undefined {
    const resolved = this.registry.select(id);
    if (!resolved) return undefined;
    this.commitTheme();
    return resolved;
  }

  /** Switch the active palette without touching the saved selection. */
  previewTheme(id: string): TuiThemeDefinition | undefined {
    const resolved = this.registry.select(id);
    if (!resolved) return undefined;
    this.applyRenderTheme();
    this.emit();
    return resolved;
  }

  /**
   * Pin the appearance (`light` / `dark`) or return to terminal-driven
   * detection when `value` is undefined.
   */
  setAppearanceOverride(value: string | undefined): TuiResolvedAppearance | undefined {
    this.appearanceOverride = value === 'light' || value === 'dark' ? value : undefined;
    this.commitDetection();
    return this.appearanceOverride;
  }

  appearanceOverrideValue(): TuiResolvedAppearance | undefined {
    return this.appearanceOverride;
  }

  async start(): Promise<void> {
    if (!this.started) {
      this.started = true;
      this.ui.setTerminalColorSchemeNotifications(true);
      this.bindTerminalColorSchemeListener();
    }
    await this.refresh();
  }

  rebindUi(): void {
    if (!this.started) return;
    this.refreshSequence += 1;
    this.stopTracking?.();
    this.bindTerminalColorSchemeListener();
    this.ui.setTerminalColorSchemeNotifications(true);
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    if (this.colorLevel === 0) return;
    const sequence = ++this.refreshSequence;
    const background = await this.ui
      .queryTerminalBackgroundColor({ timeoutMs: this.queryTimeoutMs })
      .catch(() => undefined);
    if (sequence !== this.refreshSequence) return;
    this.commitDetection(this.resolveDetection(background));
  }

  private commitDetection(detection?: TuiThemeDetection): void {
    if (detection) this.latestDetection = detection;
    const base = this.latestDetection;
    const appearance = this.appearanceOverride ?? base.appearance;
    const next: TuiThemeSnapshot = {
      ...base,
      // A pinned appearance wins over terminal evidence.
      appearance,
      colorLevel: this.colorLevel,
      themeId: this.registry.selectedIdValue(),
    };

    // Compare the palette content, not just its id: reloading a custom theme
    // file in place keeps the same id while every color may have changed.
    const signature = paletteSignature(this.registry.paletteFor(appearance));
    const renderingChanged =
      signature !== this.activeSignature ||
      next.colorLevel !== this.state.colorLevel ||
      next.themeId !== this.state.themeId;
    this.state = next;
    this.onDetection?.(this.snapshot());
    if (!renderingChanged) return;
    this.activeSignature = signature;
    this.applyRenderTheme();
    this.emit();
  }

  private commitTheme(): void {
    this.commitDetection();
  }

  private applyLoadResult(result: TuiThemeLoadResult): void {
    this.registry.applyLoadResult(result);
    this.stopThemeWatch?.();
    this.onThemesChanged?.(this.registry.list());
  }

  /**
   * Terminal evidence is ranked by how recently it was observed. OSC 11 is the most precise
   * because it reports the live background, the DEC 2031 report is the terminal's own live
   * signal, and `COLORFGBG` is last because it can only ever restate the appearance captured
   * when the process started.
   */
  private resolveDetection(background: RgbColor | undefined): TuiThemeDetection {
    if (background) {
      return {
        appearance: appearanceFromRgb(background),
        source: 'osc11',
        detail: `OSC 11 background rgb(${background.r}, ${background.g}, ${background.b})`,
      };
    }
    if (this.reportedAppearance) {
      return {
        appearance: this.reportedAppearance,
        source: 'terminal-report',
        detail: `DEC 2031 color scheme report ${this.reportedAppearance}`,
      };
    }
    return resolveEnvironmentAppearance(this.env);
  }

  dispose(): void {
    this.started = false;
    this.refreshSequence += 1;
    this.stopTracking?.();
    this.stopTracking = undefined;
    this.stopThemeWatch?.();
    this.stopThemeWatch = undefined;
    this.ui.setTerminalColorSchemeNotifications(false);
    this.listeners.clear();
  }

  private startThemeWatch(dataDir: string): void {
    this.stopThemeWatch = watchCustomThemes(dataDir, (result) => {
      this.registry.applyLoadResult(result);
      this.onThemesChanged?.(this.registry.list());
      this.commitDetection();
    });
  }

  private applyRenderTheme(): void {
    applyTuiRenderTheme(this.registry.paletteFor(this.state.appearance), this.state.colorLevel);
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private bindTerminalColorSchemeListener(): void {
    this.stopTracking = this.ui.onTerminalColorSchemeChange((scheme) => {
      this.reportedAppearance = scheme;
      void this.refresh();
    });
  }
}

export { DEFAULT_THEME_ID };
