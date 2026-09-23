import type { Component } from '../rendering/component.js';
import type { TuiInlinePanelHost } from './inline-panel.js';
import type { TuiChatLayerHandle, TuiSurfaceHost } from './surface-host.js';

export class TuiInteractionSurface {
  private layer: TuiChatLayerHandle | undefined;

  constructor(
    private readonly host: TuiInlinePanelHost,
    private readonly surfaces: TuiSurfaceHost,
    private readonly requestRender: () => void,
    private readonly onActiveChanged?: (active: boolean) => void,
    private readonly followFullscreenBottom?: () => void,
  ) {}

  show(panel: Component): void {
    if (this.layer) {
      this.host.show(panel);
      this.layer.setFocus(panel);
    } else {
      this.host.show(panel);
      try {
        this.layer = this.surfaces.pushChatLayer({
          id: 'interaction',
          focus: panel,
          priority: 100,
          preemptsFeatures: true,
        });
      } catch (error) {
        this.host.close(panel);
        throw error;
      }
    }
    this.onActiveChanged?.(true);
    if (this.surfaces.getChatMode() === 'fullscreen') this.followFullscreenBottom?.();
    this.requestRender();
  }

  close(panel?: Component): boolean {
    if (!this.host.isActive(panel)) return false;
    if (this.layer && !this.layer.close()) return false;
    this.layer = undefined;
    if (!this.host.close(panel)) return false;
    this.onActiveChanged?.(false);
    this.requestRender();
    return true;
  }

  closeCurrent(): boolean {
    return this.close(this.host.current());
  }

  isActive(panel?: Component): boolean {
    return this.host.isActive(panel);
  }

  current(): Component | undefined {
    return this.host.current();
  }

  request(): void {
    this.requestRender();
  }
}
