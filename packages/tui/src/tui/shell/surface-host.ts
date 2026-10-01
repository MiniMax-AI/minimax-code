import { getLayoutNode, LAYOUT_NODE, type LayoutNode, type TuiMode } from '../engine/public.js';
import { type Component, disposeComponents } from '../rendering/component.js';
import type {
  TuiFeaturePresentationSource,
  TuiRegularFeaturePresentationHandle,
  TuiRegularFeaturePresenter,
} from './regular-feature-presenter.js';

export interface TuiFeatureScreen extends TuiFeaturePresentationSource {
  readonly id: string;
}

export type TuiActiveSurface = { kind: 'chat'; id: 'chat' } | { kind: 'feature'; id: string };

export interface TuiFeatureScreenHandle {
  readonly id: string;
  close(): boolean;
  isActive(): boolean;
}

export interface TuiChatLayerHandle {
  readonly id: string;
  close(): boolean;
  isActive(): boolean;
  setFocus(component: Component): void;
}

interface SurfaceEntry {
  screen: TuiFeatureScreen;
  focus: Component;
  regularPresentation?: TuiRegularFeaturePresentationHandle;
}

interface ChatLayerEntry {
  readonly id: string;
  focus: Component;
  readonly priority: number;
  readonly sequence: number;
  readonly preemptsFeatures: boolean;
}

export interface TuiSurfaceHostOptions {
  chat: {
    component: Component;
    focus: Component;
    layoutRoot?: Component;
  };
  chatMode?: TuiMode;
  mode?(): TuiMode;
  viewportRows?(): number;
  regularFeaturePresenter: TuiRegularFeaturePresenter;
  setFocus(component: Component): void;
  requestRender(): void;
  switchMode?(mode: TuiMode): boolean;
}

export class TuiSurfaceHost implements Component {
  private readonly chatComponent: Component;
  private readonly chatLayoutRoot: Component;
  private chatFocus: Component;
  private readonly setFocus: TuiSurfaceHostOptions['setFocus'];
  private readonly requestRender: TuiSurfaceHostOptions['requestRender'];
  private readonly switchMode: TuiSurfaceHostOptions['switchMode'];
  private readonly mode: TuiSurfaceHostOptions['mode'];
  private readonly viewportRows: TuiSurfaceHostOptions['viewportRows'];
  private readonly regularFeaturePresenter: TuiRegularFeaturePresenter;
  private readonly featureStack: SurfaceEntry[] = [];
  private readonly chatLayers: ChatLayerEntry[] = [];
  private chatMode: TuiMode;
  private chatLayerSequence = 0;

  constructor(options: TuiSurfaceHostOptions) {
    this.chatComponent = options.chat.component;
    this.chatLayoutRoot = options.chat.layoutRoot ?? options.chat.component;
    this.chatFocus = options.chat.focus;
    this.setFocus = options.setFocus;
    this.requestRender = options.requestRender;
    this.switchMode = options.switchMode;
    this.mode = options.mode;
    this.viewportRows = options.viewportRows;
    this.regularFeaturePresenter = options.regularFeaturePresenter;
    this.chatMode = options.chatMode ?? 'regular';
  }

  getChatMode(): TuiMode {
    return this.chatMode;
  }

  setChatMode(mode: TuiMode): boolean {
    if (mode === this.chatMode) return true;
    const previousChatMode = this.chatMode;
    const previousRendererMode = this.currentMode();
    this.closeRegularFeaturePresentations();
    this.chatMode = mode;
    try {
      if (!this.reconcileMode()) {
        this.chatMode = previousChatMode;
        this.syncRegularFeaturePresentation();
        return false;
      }
      if (this.currentMode() !== mode) {
        this.chatMode = previousChatMode;
        this.restoreRendererMode(previousRendererMode);
        this.syncRegularFeaturePresentation();
        return false;
      }
      this.syncRegularFeaturePresentation();
    } catch (error) {
      this.chatMode = previousChatMode;
      const rollbackErrors: unknown[] = [];
      try {
        this.restoreRendererMode(previousRendererMode);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      try {
        this.syncRegularFeaturePresentation();
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          'TUI mode change failed and could not fully restore the feature presentation.',
        );
      }
      throw error;
    }
    this.activate(this.activeFocus());
    return true;
  }

  getActiveSurface(): TuiActiveSurface {
    const active = this.activeFeature();
    return active ? { kind: 'feature', id: active.screen.id } : { kind: 'chat', id: 'chat' };
  }

  pushFeature(options: { screen: TuiFeatureScreen; focus?: Component }): TuiFeatureScreenHandle {
    if (this.featureStack.some((entry) => entry.screen.id === options.screen.id)) {
      throw new Error(`Feature screen "${options.screen.id}" is already mounted.`);
    }
    const entry: SurfaceEntry = {
      screen: options.screen,
      focus: options.focus ?? options.screen,
    };
    this.featureStack.push(entry);
    try {
      this.syncRegularFeaturePresentation();
    } catch (error) {
      this.featureStack.pop();
      this.syncRegularFeaturePresentation();
      throw error;
    }
    this.activate(this.activeFocus());

    return {
      id: entry.screen.id,
      close: () => this.closeEntry(entry),
      isActive: () => this.activeFeature() === entry,
    };
  }

  pushChatLayer(options: {
    id: string;
    focus: Component;
    priority: number;
    preemptsFeatures?: boolean;
  }): TuiChatLayerHandle {
    if (this.chatLayers.some((entry) => entry.id === options.id)) {
      throw new Error(`Chat layer "${options.id}" is already mounted.`);
    }
    const entry: ChatLayerEntry = {
      ...options,
      sequence: this.chatLayerSequence++,
      preemptsFeatures: options.preemptsFeatures ?? false,
    };
    this.chatLayers.push(entry);
    try {
      this.syncRegularFeaturePresentation();
    } catch (error) {
      this.chatLayers.pop();
      this.syncRegularFeaturePresentation();
      throw error;
    }
    if (this.featureStack.length === 0 || entry.preemptsFeatures) this.activate(this.activeFocus());
    return {
      id: entry.id,
      close: () => this.closeChatLayer(entry),
      isActive: () => this.activeFeature() === undefined && this.activeChatLayer() === entry,
      setFocus: (component) => this.setChatLayerFocus(entry, component),
    };
  }

  popFeature(): boolean {
    const active = this.featureStack.at(-1);
    return active ? this.closeEntry(active) : false;
  }

  clearFeatures(): boolean {
    if (this.featureStack.length === 0) return true;
    const entries = this.featureStack.splice(0);
    this.closeRegularFeaturePresentations(entries);
    for (const entry of entries) {
      disposeComponents(entry.screen, entry.focus);
    }
    this.activate(this.activeChatFocus());
    return true;
  }

  setChatFocus(component: Component): void {
    this.chatFocus = component;
    if (this.featureStack.length === 0 && this.chatLayers.length === 0) {
      this.setFocus(component);
    }
  }

  invalidate(): void {
    const active = this.activeFeature();
    if (active && this.currentMode() === 'fullscreen') active.screen.invalidate();
    else this.chatComponent.invalidate();
  }

  getViewportLayoutKey(): string | undefined {
    const key = this.chatComponent.getViewportLayoutKey?.();
    return key === undefined ? undefined : JSON.stringify([this.activeFeature()?.screen.id, key]);
  }

  render(width: number): string[] {
    const active = this.activeFeature();
    if (!active || this.currentMode() === 'regular') return this.chatComponent.render(width);
    if (
      active.screen.renderViewport &&
      this.viewportRows &&
      !getLayoutNode(active.screen.layoutRoot)
    ) {
      return [...active.screen.renderViewport(width, Math.max(1, this.viewportRows()))];
    }
    return active.screen.render(width);
  }

  [LAYOUT_NODE](): LayoutNode | undefined {
    const active = this.activeFeature();
    return getLayoutNode(
      active && this.currentMode() === 'fullscreen'
        ? active.screen.layoutRoot
        : this.chatLayoutRoot,
    );
  }

  dispose(): void {
    this.closeRegularFeaturePresentations();
    for (const entry of this.featureStack) {
      disposeComponents(entry.screen, entry.focus);
    }
    for (const entry of this.chatLayers) {
      disposeComponents(entry.focus);
    }
    this.featureStack.length = 0;
    this.chatLayers.length = 0;
  }

  private closeEntry(entry: SurfaceEntry): boolean {
    if (this.featureStack.at(-1) !== entry) return false;
    this.featureStack.pop();
    this.closeRegularFeaturePresentations([entry]);
    try {
      this.syncRegularFeaturePresentation();
    } catch (error) {
      this.featureStack.push(entry);
      this.syncRegularFeaturePresentation();
      throw error;
    }
    disposeComponents(entry.screen, entry.focus);
    this.activate(this.activeFocus());
    return true;
  }

  private closeChatLayer(entry: ChatLayerEntry): boolean {
    const index = this.chatLayers.indexOf(entry);
    if (index < 0) return false;
    this.chatLayers.splice(index, 1);
    try {
      this.syncRegularFeaturePresentation();
    } catch (error) {
      this.chatLayers.splice(index, 0, entry);
      this.syncRegularFeaturePresentation();
      throw error;
    }
    disposeComponents(entry.focus);
    this.activate(this.activeFocus());
    return true;
  }

  private setChatLayerFocus(entry: ChatLayerEntry, component: Component): void {
    if (!this.chatLayers.includes(entry)) {
      throw new Error(`Chat layer "${entry.id}" is no longer mounted.`);
    }
    entry.focus = component;
    if (this.activeFeature() === undefined && this.activeChatLayer() === entry) {
      this.activate(component);
    }
  }

  private activeChatFocus(): Component {
    return this.activeChatLayer()?.focus ?? this.chatFocus;
  }

  private activeChatLayer(): ChatLayerEntry | undefined {
    return [...this.chatLayers].sort(
      (left, right) => right.priority - left.priority || right.sequence - left.sequence,
    )[0];
  }

  private activeFeature(): SurfaceEntry | undefined {
    return this.activePreemptiveChatLayer() ? undefined : this.featureStack.at(-1);
  }

  private activePreemptiveChatLayer(): ChatLayerEntry | undefined {
    return [...this.chatLayers]
      .filter((entry) => entry.preemptsFeatures)
      .sort((left, right) => right.priority - left.priority || right.sequence - left.sequence)[0];
  }

  private activeFocus(): Component {
    const active = this.activeFeature();
    return active?.regularPresentation?.focus ?? active?.focus ?? this.activeChatFocus();
  }

  private currentMode(): TuiMode {
    return this.mode?.() ?? this.chatMode;
  }

  private reconcileMode(): boolean {
    const desiredMode = this.chatMode;
    if (desiredMode === this.mode?.()) return true;
    return this.switchMode?.(desiredMode) !== false;
  }

  private restoreRendererMode(mode: TuiMode): void {
    if (this.currentMode() === mode) return;
    if (this.switchMode?.(mode) === false || this.currentMode() !== mode) {
      throw new Error(`Cannot restore TUI renderer mode to "${mode}".`);
    }
  }

  private syncRegularFeaturePresentation(): void {
    const active = this.currentMode() === 'regular' ? this.activeFeature() : undefined;
    for (const entry of this.featureStack) {
      if (entry === active) continue;
      entry.regularPresentation?.close();
      entry.regularPresentation = undefined;
    }
    if (!active || active.regularPresentation) return;
    active.regularPresentation = this.regularFeaturePresenter.show(active.screen, active.focus);
  }

  private closeRegularFeaturePresentations(entries = this.featureStack): void {
    for (const entry of entries) {
      entry.regularPresentation?.close();
      entry.regularPresentation = undefined;
    }
  }

  private activate(focus: Component): void {
    this.invalidateActiveSurface();
    this.setFocus(focus);
    this.requestRender();
  }

  private invalidateActiveSurface(): void {
    const active = this.activeFeature();
    if (active) active.screen.invalidate();
    else if (this.currentMode() === 'fullscreen') this.chatComponent.invalidate();
  }
}
