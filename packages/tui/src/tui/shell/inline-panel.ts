import { disposeComponents, type Component } from '../rendering/component.js';
import { stripAnsi } from '../rendering/text.js';
import type { TuiMouseEvent } from '../engine/public.js';

interface ViewportInteraction extends Component {
  renderViewport(width: number, height: number): readonly string[];
}

interface ScrollableInteraction extends Component {
  scrollByRows(delta: number): number;
  scrollByPage(direction: -1 | 1): number;
}

interface MouseInteraction extends Component {
  handleMouse(event: TuiMouseEvent): boolean;
}

/** An interaction that can switch to a full, read-only view of its subject. */
interface FullViewInteraction extends Component {
  toggleFullView(): boolean;
}

/** An interaction that explains transcript rows held above it. */
interface HeldRowsHintInteraction extends Component {
  heldRowsHint(): string | undefined;
}

/**
 * Single-slot interaction region rendered directly above the Composer.
 *
 * Replacing the active component is intentional: a terminal has one current
 * interaction, while completed outcomes belong in the Transcript.
 */
export class TuiInlinePanelHost implements Component {
  private activeComponent: Component | undefined;

  show(component: Component): void {
    if (this.activeComponent === component) return;
    disposeComponents(this.activeComponent);
    this.activeComponent = component;
  }

  close(component?: Component): boolean {
    if (!this.activeComponent || (component && component !== this.activeComponent)) return false;
    const closed = this.activeComponent;
    this.activeComponent = undefined;
    disposeComponents(closed);
    return true;
  }

  dispose(): void {
    this.close();
  }

  isActive(component?: Component): boolean {
    return component ? this.activeComponent === component : this.activeComponent !== undefined;
  }

  current(): Component | undefined {
    return this.activeComponent;
  }

  /** Compact selectors can keep their controls together in the fullscreen body. */
  get fullscreenViewport(): boolean {
    return Boolean(
      this.activeComponent &&
      'fullscreenViewport' in this.activeComponent &&
      this.activeComponent.fullscreenViewport === true,
    );
  }

  invalidate(): void {
    this.activeComponent?.invalidate();
  }

  render(width: number): string[] {
    return this.activeComponent ? [...this.activeComponent.render(width)] : [];
  }

  renderViewport(width: number, height: number): string[] {
    if (!this.activeComponent) return [];
    return isViewportInteraction(this.activeComponent)
      ? [...this.activeComponent.renderViewport(width, height)]
      : clipInteractionViewport(this.activeComponent.render(width), height);
  }

  scrollByRows(delta: number): number | undefined {
    return isScrollableInteraction(this.activeComponent)
      ? this.activeComponent.scrollByRows(delta)
      : undefined;
  }

  scrollByPage(direction: -1 | 1): number | undefined {
    return isScrollableInteraction(this.activeComponent)
      ? this.activeComponent.scrollByPage(direction)
      : undefined;
  }

  handleMouse(event: TuiMouseEvent): boolean {
    return isMouseInteraction(this.activeComponent)
      ? this.activeComponent.handleMouse(event)
      : false;
  }

  /** Returns false when the current interaction has no full view to toggle. */
  toggleFullView(): boolean {
    return isFullViewInteraction(this.activeComponent)
      ? this.activeComponent.toggleFullView()
      : false;
  }

  /** Replaces the generic notice for held transcript rows, when the interaction owns them. */
  heldRowsHint(): string | undefined {
    return isHeldRowsHintInteraction(this.activeComponent)
      ? this.activeComponent.heldRowsHint()
      : undefined;
  }
}

function isViewportInteraction(component: Component): component is ViewportInteraction {
  return 'renderViewport' in component && typeof component.renderViewport === 'function';
}

function clipInteractionViewport(lines: readonly string[], rawHeight: number): string[] {
  return selectInteractionViewportRows(lines, rawHeight).map((index) => lines[index] ?? '');
}

/**
 * Indices of the rows `clipInteractionViewport` keeps, in display order, so an
 * interaction can map a viewport-local mouse row back to its rendered row.
 */
export function selectInteractionViewportRows(
  lines: readonly string[],
  rawHeight: number,
): number[] {
  const height = Math.max(1, Math.floor(rawHeight));
  if (lines.length <= height) return lines.map((_, index) => index);

  const selectedRows = new Set<number>();
  const headRows = Math.min(5, Math.max(1, height - 3));
  const tailRows = Math.min(2, Math.max(0, height - headRows));
  for (let index = 0; index < headRows; index += 1) selectedRows.add(index);
  for (let index = Math.max(headRows, lines.length - tailRows); index < lines.length; index += 1) {
    selectedRows.add(index);
  }

  const anchor = lines.findIndex((line) => /[›→]/u.test(stripAnsi(line)));
  if (anchor >= 0) {
    for (let distance = 0; selectedRows.size < height; distance += 1) {
      const before = anchor - distance;
      const after = anchor + distance;
      if (before >= headRows && before < lines.length - tailRows) selectedRows.add(before);
      if (after >= headRows && after < lines.length - tailRows) selectedRows.add(after);
      if (before < headRows && after >= lines.length - tailRows) break;
    }
  }
  for (
    let index = headRows;
    selectedRows.size < height && index < lines.length - tailRows;
    index += 1
  ) {
    selectedRows.add(index);
  }
  return [...selectedRows].sort((left, right) => left - right).slice(0, height);
}

function isScrollableInteraction(
  component: Component | undefined,
): component is ScrollableInteraction {
  return Boolean(
    component &&
    'scrollByRows' in component &&
    typeof component.scrollByRows === 'function' &&
    'scrollByPage' in component &&
    typeof component.scrollByPage === 'function',
  );
}

function isMouseInteraction(component: Component | undefined): component is MouseInteraction {
  return Boolean(
    component && 'handleMouse' in component && typeof component.handleMouse === 'function',
  );
}

function isFullViewInteraction(component: Component | undefined): component is FullViewInteraction {
  return Boolean(
    component && 'toggleFullView' in component && typeof component.toggleFullView === 'function',
  );
}

function isHeldRowsHintInteraction(
  component: Component | undefined,
): component is HeldRowsHintInteraction {
  return Boolean(
    component && 'heldRowsHint' in component && typeof component.heldRowsHint === 'function',
  );
}
