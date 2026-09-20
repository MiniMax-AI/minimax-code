import {
  getKeybindings,
  getLayoutNode,
  isFocusable,
  isKeyRelease,
  renderLayoutFrame,
  type Component,
  type LayoutFrame,
  type Terminal,
  type TUI,
} from '../engine/public.js';

const PAGE_SCROLL_OVERLAP = 4;

export interface TuiFeaturePresentationSource extends Component {
  readonly id: string;
  readonly layoutRoot: Component;
  renderViewport?(width: number, height: number): readonly string[];
}

export interface TuiRegularFeaturePresentationHandle {
  readonly focus: Component;
  close(): void;
}

export interface TuiRegularFeaturePresenter {
  show(screen: TuiFeaturePresentationSource, focus: Component): TuiRegularFeaturePresentationHandle;
}

export class TuiOverlayRegularFeaturePresenter implements TuiRegularFeaturePresenter {
  constructor(
    private readonly terminal: Terminal,
    private readonly tui: TUI,
    private readonly requestRender: () => void,
  ) {}

  show(
    screen: TuiFeaturePresentationSource,
    focus: Component,
  ): TuiRegularFeaturePresentationHandle {
    const viewport = new TuiRegularFeatureViewport(
      screen,
      focus,
      this.terminal,
      this.requestRender,
    );
    const overlay = this.tui.showOverlay(viewport, {
      width: '100%',
      maxHeight: '100%',
      row: 0,
      col: 0,
    });
    return {
      focus: viewport,
      close: () => overlay.hide(),
    };
  }
}

class TuiRegularFeatureViewport implements Component {
  private layout: LayoutFrame | undefined;
  private focusedValue = false;

  constructor(
    private readonly screen: TuiFeaturePresentationSource,
    private readonly focusTarget: Component,
    private readonly terminal: Terminal,
    private readonly requestRender: () => void,
  ) {}

  get focused(): boolean {
    return this.focusedValue;
  }

  set focused(value: boolean) {
    this.focusedValue = value;
    if (isFocusable(this.focusTarget)) this.focusTarget.focused = value;
  }

  get wantsKeyRelease(): boolean {
    return this.focusTarget.wantsKeyRelease ?? false;
  }

  handleInput(data: string): void {
    if (this.handleViewportInput(data)) return;
    this.focusTarget.handleInput?.(data);
  }

  render(width: number): string[] {
    if (this.screen.renderViewport && !getLayoutNode(this.screen.layoutRoot)) {
      this.layout = undefined;
      const height = Math.max(1, this.terminal.rows);
      const lines = this.screen.renderViewport(width, height);
      // Feature screens own the viewport even when their content is short.
      return Array.from({ length: height }, (_, index) => lines[index] ?? '');
    }
    this.layout = renderLayoutFrame(
      this.screen.layoutRoot,
      width,
      Math.max(1, this.terminal.rows),
      this.requestRender,
    );
    return this.layout.lines;
  }

  invalidate(): void {
    this.screen.invalidate();
  }

  private handleViewportInput(data: string): boolean {
    const scrollView = this.layout?.primaryScrollView;
    if (!scrollView) return false;
    const keybindings = getKeybindings();
    const isRelease = isKeyRelease(data);
    if (keybindings.matches(data, 'tui.altScreen.pageUp')) {
      if (!isRelease) {
        scrollView.scrollBy(-Math.max(1, scrollView.viewportHeight - PAGE_SCROLL_OVERLAP));
      }
      return true;
    }
    if (keybindings.matches(data, 'tui.altScreen.pageDown')) {
      if (!isRelease) {
        scrollView.scrollBy(Math.max(1, scrollView.viewportHeight - PAGE_SCROLL_OVERLAP));
      }
      return true;
    }
    if (keybindings.matches(data, 'tui.altScreen.halfPageUp')) {
      if (!isRelease) scrollView.scrollBy(-Math.max(1, Math.floor(scrollView.viewportHeight / 2)));
      return true;
    }
    if (keybindings.matches(data, 'tui.altScreen.halfPageDown')) {
      if (!isRelease) scrollView.scrollBy(Math.max(1, Math.floor(scrollView.viewportHeight / 2)));
      return true;
    }
    if (keybindings.matches(data, 'tui.altScreen.lineUp')) {
      if (!isRelease) scrollView.scrollBy(-1);
      return true;
    }
    if (keybindings.matches(data, 'tui.altScreen.lineDown')) {
      if (!isRelease) scrollView.scrollBy(1);
      return true;
    }
    if (keybindings.matches(data, 'tui.altScreen.top')) {
      if (!isRelease) scrollView.scrollToStart();
      return true;
    }
    if (keybindings.matches(data, 'tui.altScreen.bottom')) {
      if (!isRelease) scrollView.scrollToEnd();
      return true;
    }
    return false;
  }
}
