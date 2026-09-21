import {
  isViewportTUI,
  TuiAltScreen,
  TuiMainScreen,
  type Component,
  type Terminal,
  type TUI,
  type TuiAltScreenOptions,
  type TuiInputListener,
  type TuiMode,
  type TuiStopOptions,
} from '../engine/public.js';
import { captureTuiIncidentBestEffort, type TuiIncidentSink } from '../../observability/index.js';

export interface McodeInteractiveRendererOptions {
  readonly terminal: Terminal;
  readonly initialMode?: TuiMode;
  readonly showHardwareCursor?: boolean;
  readonly logDirectory?: string;
  readonly altScreen?: TuiAltScreenOptions;
  readonly fullscreenLayoutRoot?: Component;
  readonly incidentReporter?: TuiIncidentSink;
  readonly onRendererChanged?: (renderer: TuiMainScreen | TuiAltScreen) => void;
}

export function createActiveTuiReference(getTui: () => TUI): TUI {
  return new Proxy({} as TUI, {
    get: (_target, property) => {
      const tui = getTui();
      const value = Reflect.get(tui, property, tui);
      if (typeof value !== 'function') return value;
      let methodTui = tui;
      let method = value;
      return (...args: unknown[]) => {
        const currentTui = getTui();
        if (currentTui !== methodTui) {
          const currentMethod = Reflect.get(currentTui, property, currentTui);
          if (typeof currentMethod !== 'function') {
            throw new TypeError(`TUI property ${String(property)} is not callable`);
          }
          methodTui = currentTui;
          method = currentMethod;
        }
        return Reflect.apply(method, methodTui, args);
      };
    },
    set: (_target, property, value) => Reflect.set(getTui(), property, value, getTui()),
    has: (_target, property) => Reflect.has(getTui(), property),
    getPrototypeOf: () => Reflect.getPrototypeOf(getTui()),
  });
}

export class McodeInteractiveRenderer {
  readonly ui: TUI;
  readonly firstFrame: Promise<void>;

  private renderer: TuiMainScreen | TuiAltScreen;
  private readonly listeners = new Set<TuiInputListener>();
  private readonly listenerDisposers = new Map<TuiInputListener, () => void>();
  private fullscreenLayoutRoot: Component | undefined;
  private mainScreenRenderState: ReturnType<TuiMainScreen['captureRenderState']> | undefined;
  private resolveFirstFrame: (() => void) | undefined;
  private started = false;
  private disposed = false;
  private initialRegularViewportCleared = false;

  constructor(private readonly options: McodeInteractiveRendererOptions) {
    this.fullscreenLayoutRoot = options.fullscreenLayoutRoot;
    this.renderer = this.createRenderer(options.initialMode ?? 'regular');
    this.ui = createActiveTuiReference(() => this.renderer);
    this.firstFrame = new Promise<void>((resolve) => {
      this.resolveFirstFrame = resolve;
    });
    this.mountFullscreenLayout(this.renderer);
  }

  get mode(): TuiMode {
    return this.renderer.mode;
  }

  get activeRenderer(): TuiMainScreen | TuiAltScreen {
    return this.renderer;
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.bindInputListeners();
    if (this.renderer.mode === 'regular' && !this.initialRegularViewportCleared) {
      this.options.terminal.clearScreen();
    }
    this.renderer.start();
    if (this.renderer.mode === 'regular') this.initialRegularViewportCleared = true;
    this.started = true;
    this.renderer.renderNow();
    this.resolveFirstFrame?.();
    this.resolveFirstFrame = undefined;
  }

  stop(options: TuiStopOptions = {}): void {
    if (!this.started) return;
    this.unbindInputListeners();
    this.renderer.stop(options);
    this.started = false;
  }

  prepareTranscriptExit(): void {
    if (!this.started || this.renderer.mode !== 'fullscreen') return;
    while (this.renderer.hasOverlayEntries) this.renderer.hideOverlay();
    if (!this.switchMode('regular')) {
      throw new Error('Cannot switch the TUI to regular mode for terminal exit.');
    }
    this.activeRenderer.renderNow();
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.listeners.clear();
    this.disposed = true;
  }

  addInputListener(listener: TuiInputListener): () => void {
    if (this.disposed) throw new Error('Cannot add input listeners after renderer disposal.');
    if (this.listeners.has(listener)) return () => this.removeInputListener(listener);
    this.listeners.add(listener);
    if (this.started)
      this.listenerDisposers.set(listener, this.renderer.addInputListener(listener));
    return () => this.removeInputListener(listener);
  }

  setFullscreenLayoutRoot(component: Component | undefined): void {
    this.fullscreenLayoutRoot = component;
    this.mountFullscreenLayout(this.renderer);
    if (this.renderer.mode === 'fullscreen') this.renderer.requestImmediateRender();
  }

  switchMode(mode: TuiMode): boolean {
    const previous = this.renderer;
    if (mode === previous.mode) return true;
    if (previous.hasOverlayEntries) return false;

    const components = [...previous.children];
    const focus = previous.getFocusedComponent();
    const showHardwareCursor = previous.getShowHardwareCursor();
    const clearOnShrink = previous.getClearOnShrink();
    const onDebug = previous.onDebug;
    const wasStarted = this.started;
    if (previous instanceof TuiMainScreen) {
      this.mainScreenRenderState = previous.captureRenderState();
    }

    const next = this.createRenderer(mode, showHardwareCursor);
    next.setClearOnShrink(clearOnShrink);
    next.onDebug = onDebug;
    if (next instanceof TuiMainScreen && this.mainScreenRenderState) {
      next.restoreRenderState(this.mainScreenRenderState);
    }
    for (const component of components) next.addChild(component);
    this.mountFullscreenLayout(next);

    let previousStopAttempted = false;
    let nextStartAttempted = false;
    let rendererChangedAttempted = false;
    try {
      this.unbindInputListeners();
      if (wasStarted) {
        previousStopAttempted = true;
        previous.stop({ preserveScreen: true });
      }
      previous.setFocus(null);
      next.setFocus(focus);
      this.renderer = next;
      next.invalidate();
      this.bindInputListeners();
      if (wasStarted) {
        nextStartAttempted = true;
        next.start();
      }
      rendererChangedAttempted = true;
      this.options.onRendererChanged?.(next);
    } catch (error) {
      this.rollbackModeSwitch({
        previous,
        next,
        focus,
        wasStarted,
        previousStopAttempted,
        nextStartAttempted,
        rendererChangedAttempted,
        cause: error,
      });
    }

    previous.clear();
    if (isViewportTUI(previous)) previous.setLayoutRoot(undefined);
    return true;
  }

  private rollbackModeSwitch(options: {
    previous: TuiMainScreen | TuiAltScreen;
    next: TuiMainScreen | TuiAltScreen;
    focus: Component | null;
    wasStarted: boolean;
    previousStopAttempted: boolean;
    nextStartAttempted: boolean;
    rendererChangedAttempted: boolean;
    cause: unknown;
  }): never {
    const rollbackErrors: unknown[] = [];
    if (this.renderer === options.next) {
      try {
        this.unbindInputListeners();
      } catch (error) {
        rollbackErrors.push(error);
      }
      if (options.wasStarted && options.nextStartAttempted) {
        try {
          options.next.stop({ preserveScreen: true });
        } catch (error) {
          rollbackErrors.push(error);
        }
      }
    }

    this.renderer = options.previous;
    try {
      this.bindInputListeners();
    } catch (error) {
      rollbackErrors.push(error);
    }
    if (options.wasStarted && options.previousStopAttempted) {
      try {
        options.previous.start();
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    try {
      options.previous.setFocus(options.focus);
    } catch (error) {
      rollbackErrors.push(error);
    }
    if (options.rendererChangedAttempted) {
      try {
        this.options.onRendererChanged?.(options.previous);
      } catch (error) {
        rollbackErrors.push(error);
      }
    }

    const rollbackSucceeded = rollbackErrors.length === 0;
    const failure = rollbackSucceeded
      ? options.cause
      : new AggregateError(
          [options.cause, ...rollbackErrors],
          'TUI mode switch failed and could not fully restore the previous renderer.',
        );
    captureTuiIncidentBestEffort(this.options.incidentReporter, {
      eventType: 'cli_render_error',
      error: failure,
      component: 'renderer',
      operation: 'switch-mode',
      codeLocation: 'src/tui/renderer/interactive-renderer.ts#McodeInteractiveRenderer.switchMode',
      severity: 'error',
      impact: rollbackSucceeded ? 'action_failed' : 'screen_unavailable',
      handled: rollbackSucceeded,
      context: {
        previousMode: options.previous.mode,
        nextMode: options.next.mode,
        rollbackSucceeded,
      },
    });
    throw failure;
  }

  private createRenderer(
    mode: TuiMode,
    // Older ConPTY renderers omit hidden cursor positions from their output,
    // leaving browser-terminal IME composition at the last painted cell.
    // Keep explicit options and PI_HARDWARE_CURSOR authoritative.
    showHardwareCursor = this.options.showHardwareCursor ??
      (process.platform === 'win32' && process.env.PI_HARDWARE_CURSOR === undefined
        ? true
        : undefined),
  ): TuiMainScreen | TuiAltScreen {
    if (mode === 'fullscreen') {
      return new TuiAltScreen(
        this.options.terminal,
        showHardwareCursor,
        this.options.logDirectory,
        this.options.altScreen,
      );
    }
    return new TuiMainScreen(this.options.terminal, showHardwareCursor, this.options.logDirectory);
  }

  private mountFullscreenLayout(renderer: TuiMainScreen | TuiAltScreen): void {
    if (isViewportTUI(renderer)) renderer.setLayoutRoot(this.fullscreenLayoutRoot);
  }

  private removeInputListener(listener: TuiInputListener): void {
    this.listeners.delete(listener);
    this.listenerDisposers.get(listener)?.();
    this.listenerDisposers.delete(listener);
  }

  private bindInputListeners(): void {
    for (const listener of this.listeners) {
      if (!this.listenerDisposers.has(listener)) {
        this.listenerDisposers.set(listener, this.renderer.addInputListener(listener));
      }
    }
  }

  private unbindInputListeners(): void {
    const disposers = [...this.listenerDisposers.values()];
    this.listenerDisposers.clear();
    const errors: unknown[] = [];
    for (const dispose of disposers) {
      try {
        dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0)
      throw new AggregateError(errors, 'Failed to unbind TUI input listeners.');
  }
}
