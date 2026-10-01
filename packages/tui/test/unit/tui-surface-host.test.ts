import { describe, expect, it, vi } from 'vitest';
import type { Terminal, TUI } from '../../src/tui/engine/public.js';
import type { Component } from '../../src/tui/rendering/component.js';
import {
  TuiSurfaceHost,
  type TuiFeatureScreen,
  type TuiSurfaceHostOptions,
} from '../../src/tui/shell/surface-host.js';
import {
  TuiOverlayRegularFeaturePresenter,
  type TuiRegularFeaturePresenter,
} from '../../src/tui/shell/regular-feature-presenter.js';
import { TuiInteractionSurface } from '../../src/tui/shell/interaction-surface.js';
import { TuiInlinePanelHost } from '../../src/tui/shell/inline-panel.js';
import { TuiActivityLine } from '../../src/tui/shell/activity-line.js';

function component(lines: readonly string[]): Component {
  return {
    render: () => lines,
    invalidate: () => undefined,
  };
}

function screen(id: string, render: (width: number) => readonly string[]): TuiFeatureScreen {
  const layoutRoot: Component = { render, invalidate: () => undefined };
  return {
    id,
    layoutRoot,
    render: (width) => [...render(width)],
    invalidate: () => undefined,
  };
}

function createSurfaceHost(
  options: Omit<TuiSurfaceHostOptions, 'regularFeaturePresenter'> & {
    regularFeaturePresenter?: TuiRegularFeaturePresenter;
  },
): TuiSurfaceHost {
  return new TuiSurfaceHost({
    regularFeaturePresenter: {
      show: (_screen, focus) => ({ focus, close: () => undefined }),
    },
    ...options,
  });
}

function createRecordingPresenter(): {
  presenter: TuiRegularFeaturePresenter;
  presentations: Array<{
    id: string;
    focus: Component;
    close: ReturnType<typeof vi.fn>;
  }>;
} {
  const presentations: Array<{
    id: string;
    focus: Component;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  return {
    presenter: {
      show: (feature, focus) => {
        const presentation = { id: feature.id, focus, close: vi.fn() };
        presentations.push(presentation);
        return presentation;
      },
    },
    presentations,
  };
}

describe('TuiSurfaceHost', () => {
  it.each([
    { mode: 'regular', fullscreenViewport: true },
    { mode: 'regular', fullscreenViewport: false },
    { mode: 'fullscreen', fullscreenViewport: true },
  ] as const)('leaves layout restoration to the renderer on interaction close ($mode, $fullscreenViewport)', ({ mode, fullscreenViewport }) => {
    const inline = new TuiInlinePanelHost();
    const host = createSurfaceHost({
      chat: { component: inline, focus: component([]) },
      chatMode: mode,
      mode: () => mode,
      setFocus: vi.fn(),
      requestRender: vi.fn(),
    });
    const requestRender = vi.fn();
    const interaction = new TuiInteractionSurface(inline, host, requestRender);
    const panel = { ...component(['inspection']), fullscreenViewport };

    interaction.show(panel);
    requestRender.mockClear();
    expect(interaction.close(panel)).toBe(true);
    expect(requestRender).toHaveBeenCalledOnce();
    expect(requestRender).toHaveBeenCalledWith();
  });

  it.each(['regular', 'fullscreen'] as const)(
    'passes current terminal size to leaf features in %s',
    (mode) => {
      const terminal = { rows: 30 } as Terminal;
      const overlays: Component[] = [];
      const presenter = new TuiOverlayRegularFeaturePresenter(
        terminal,
        {
          showOverlay: (overlay: Component) => {
            overlays.push(overlay);
            return { hide: vi.fn() };
          },
        } as unknown as TUI,
        vi.fn(),
      );
      const renderViewport = vi.fn((width: number, height: number) => [`${width}x${height}`]);
      const host = createSurfaceHost({
        chat: { component: component(['chat']), focus: component([]) },
        chatMode: mode,
        mode: () => mode,
        viewportRows: () => terminal.rows,
        regularFeaturePresenter: presenter,
        setFocus: vi.fn(),
        requestRender: vi.fn(),
      });
      host.pushFeature({ screen: { ...screen('history', () => ['unbounded']), renderViewport } });
      const render = () => (mode === 'regular' ? overlays[0]!.render(40) : host.render(40));
      expect(render()).toEqual(
        mode === 'regular' ? ['40x30', ...Array(29).fill('')] : ['40x30'],
      );
      terminal.rows = 8;
      expect(render()).toEqual(mode === 'regular' ? ['40x8', ...Array(7).fill('')] : ['40x8']);
      host.dispose();
    },
  );

  it('invalidates only the mounted chat root in regular mode', () => {
    const chatInvalidate = vi.fn();
    const featureInvalidate = vi.fn();
    const host = createSurfaceHost({
      chat: {
        component: { render: () => ['chat'], invalidate: chatInvalidate },
        focus: component([]),
      },
      setFocus: vi.fn(),
      requestRender: vi.fn(),
    });
    const handle = host.pushFeature({
      screen: {
        ...screen('sessions', () => ['sessions']),
        invalidate: featureInvalidate,
      },
    });
    expect(chatInvalidate).not.toHaveBeenCalled();
    expect(featureInvalidate).toHaveBeenCalledOnce();
    chatInvalidate.mockClear();
    featureInvalidate.mockClear();

    host.invalidate();

    expect(chatInvalidate).toHaveBeenCalledOnce();
    expect(featureInvalidate).not.toHaveBeenCalled();

    chatInvalidate.mockClear();
    expect(handle.close()).toBe(true);
    expect(chatInvalidate).not.toHaveBeenCalled();
  });

  it('invalidates only the active fullscreen feature', () => {
    const chatInvalidate = vi.fn();
    const firstInvalidate = vi.fn();
    const secondInvalidate = vi.fn();
    const host = createSurfaceHost({
      chat: {
        component: { render: () => ['chat'], invalidate: chatInvalidate },
        focus: component([]),
      },
      chatMode: 'fullscreen',
      mode: () => 'fullscreen',
      setFocus: vi.fn(),
      requestRender: vi.fn(),
    });
    host.pushFeature({
      screen: { ...screen('first', () => ['first']), invalidate: firstInvalidate },
    });
    host.pushFeature({
      screen: { ...screen('second', () => ['second']), invalidate: secondInvalidate },
    });
    chatInvalidate.mockClear();
    firstInvalidate.mockClear();
    secondInvalidate.mockClear();

    host.invalidate();

    expect(chatInvalidate).not.toHaveBeenCalled();
    expect(firstInvalidate).not.toHaveBeenCalled();
    expect(secondInvalidate).toHaveBeenCalledOnce();
  });

  it('lets a feature screen own invalidation of its Pi layout root', () => {
    const overlays: Component[] = [];
    const tui = {
      showOverlay: vi.fn((overlay: Component) => {
        overlays.push(overlay);
        return { hide: vi.fn() };
      }),
    } as unknown as TUI;
    const layoutInvalidate = vi.fn();
    const screenInvalidate = vi.fn(() => layoutInvalidate());
    const feature = {
      id: 'sessions',
      layoutRoot: { render: () => ['layout'], invalidate: layoutInvalidate },
      render: () => ['sessions'],
      invalidate: screenInvalidate,
    };
    const presenter = new TuiOverlayRegularFeaturePresenter({ rows: 24 } as Terminal, tui, vi.fn());

    presenter.show(feature, feature);
    overlays[0]?.invalidate();

    expect(screenInvalidate).toHaveBeenCalledOnce();
    expect(layoutInvalidate).toHaveBeenCalledOnce();
  });

  it('stops periodic terminal renders while an interaction owns the viewport', () => {
    vi.useFakeTimers();
    try {
      const requestActivityRender = vi.fn();
      const activity = new TuiActivityLine(
        { phase: 'running', runId: 'turn-1' },
        { requestRender: requestActivityRender },
      );
      const host = new TuiInlinePanelHost();
      const surfaces = createSurfaceHost({
        chat: { component: component(['chat']), focus: component([]) },
        setFocus: vi.fn(),
        requestRender: vi.fn(),
      });
      const interaction = new TuiInteractionSurface(host, surfaces, vi.fn(), (active) =>
        activity.setAnimationPaused(active),
      );
      const panel = component(['question']);

      vi.advanceTimersByTime(160);
      expect(requestActivityRender).toHaveBeenCalledTimes(2);

      interaction.show(panel);
      requestActivityRender.mockClear();
      vi.advanceTimersByTime(320);
      expect(requestActivityRender).not.toHaveBeenCalled();

      interaction.close(panel);
      vi.advanceTimersByTime(80);
      expect(requestActivityRender).toHaveBeenCalledOnce();

      activity.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the default chat surface inline and persistent', () => {
    const chat = component(['chat']);
    const focus = component([]);
    const host = createSurfaceHost({
      chat: { component: chat, focus },
      setFocus: vi.fn(),
      requestRender: vi.fn(),
    });

    expect(host.getActiveSurface()).toEqual({ kind: 'chat', id: 'chat' });
    expect(host.render(40)).toEqual(['chat']);
  });

  it('presents a regular feature over the persistent chat document and restores chat focus on close', () => {
    const chat = component(['chat']);
    const chatFocus = component([]);
    const featureFocus = component([]);
    const setFocus = vi.fn();
    const requestRender = vi.fn();
    const { presenter, presentations } = createRecordingPresenter();
    const host = createSurfaceHost({
      chat: { component: chat, focus: chatFocus },
      regularFeaturePresenter: presenter,
      setFocus,
      requestRender,
    });
    const feature = screen('sessions', () => ['header', 'body', 'footer']);

    const handle = host.pushFeature({ screen: feature, focus: featureFocus });

    expect(host.getActiveSurface()).toEqual({ kind: 'feature', id: 'sessions' });
    expect(host.render(40)).toEqual(['chat']);
    expect(presentations.map(({ id }) => id)).toEqual(['sessions']);
    expect(setFocus).toHaveBeenLastCalledWith(featureFocus);
    expect(requestRender).toHaveBeenLastCalledWith();

    expect(handle.close()).toBe(true);
    expect(host.getActiveSurface()).toEqual({ kind: 'chat', id: 'chat' });
    expect(host.render(40)).toEqual(['chat']);
    expect(presentations[0]?.close).toHaveBeenCalledOnce();
    expect(setFocus).toHaveBeenLastCalledWith(chatFocus);
    expect(requestRender).toHaveBeenLastCalledWith();
  });

  it('uses a central stack for nested feature screens', () => {
    const chatFocus = component([]);
    const firstFocus = component([]);
    const secondFocus = component([]);
    const setFocus = vi.fn();
    const host = createSurfaceHost({
      chat: { component: component(['chat']), focus: chatFocus },
      setFocus,
      requestRender: vi.fn(),
    });
    const first = host.pushFeature({
      screen: screen('sessions', () => ['sessions']),
      focus: firstFocus,
    });
    const second = host.pushFeature({
      screen: screen('session-detail', () => ['detail']),
      focus: secondFocus,
    });

    expect(first.close()).toBe(false);
    expect(second.close()).toBe(true);
    expect(host.getActiveSurface()).toEqual({ kind: 'feature', id: 'sessions' });
    expect(setFocus).toHaveBeenLastCalledWith(firstFocus);
    expect(first.close()).toBe(true);
    expect(setFocus).toHaveBeenLastCalledWith(chatFocus);
  });

  it('keeps a regular renderer stable while a feature stack opens and closes', () => {
    let mode: 'regular' | 'fullscreen' = 'regular';
    const switchMode = vi.fn((next: typeof mode) => {
      mode = next;
      return true;
    });
    const host = createSurfaceHost({
      chat: { component: component(['chat']), focus: component([]) },
      mode: () => mode,
      setFocus: vi.fn(),
      requestRender: vi.fn(),
      switchMode,
    });

    const first = host.pushFeature({ screen: screen('first', () => ['first']) });
    const second = host.pushFeature({ screen: screen('second', () => ['second']) });

    expect(mode).toBe('regular');
    expect(switchMode).not.toHaveBeenCalled();
    second.close();
    first.close();
    expect(mode).toBe('regular');
    expect(switchMode).not.toHaveBeenCalled();
  });

  it('keeps chat and feature screens fullscreen when fullscreen is the configured chat mode', () => {
    const switchMode = vi.fn(() => true);
    const host = createSurfaceHost({
      chat: { component: component(['chat']), focus: component([]) },
      chatMode: 'fullscreen',
      mode: () => 'fullscreen',
      setFocus: vi.fn(),
      requestRender: vi.fn(),
      switchMode,
    });

    const feature = host.pushFeature({ screen: screen('sessions', () => ['sessions']) });

    expect(host.getChatMode()).toBe('fullscreen');
    expect(switchMode).not.toHaveBeenCalled();
    expect(feature.close()).toBe(true);
    expect(host.getActiveSurface()).toEqual({ kind: 'chat', id: 'chat' });
    expect(switchMode).not.toHaveBeenCalled();
  });

  it('switches the visible chat immediately when its configured mode changes', () => {
    const switchMode = vi.fn(() => true);
    const host = createSurfaceHost({
      chat: { component: component(['chat']), focus: component([]) },
      setFocus: vi.fn(),
      requestRender: vi.fn(),
      switchMode,
    });

    expect(host.setChatMode('fullscreen')).toBe(true);
    expect(host.getChatMode()).toBe('fullscreen');
    expect(switchMode).toHaveBeenCalledOnce();
    expect(switchMode).toHaveBeenCalledWith('fullscreen');
  });

  it('changes the renderer immediately while keeping the active feature in the selected mode', () => {
    let mode: 'regular' | 'fullscreen' = 'fullscreen';
    const switchMode = vi.fn((next: typeof mode) => {
      mode = next;
      return true;
    });
    const { presenter, presentations } = createRecordingPresenter();
    const host = createSurfaceHost({
      chat: { component: component(['chat']), focus: component([]) },
      chatMode: 'fullscreen',
      mode: () => mode,
      regularFeaturePresenter: presenter,
      setFocus: vi.fn(),
      requestRender: vi.fn(),
      switchMode,
    });
    const feature = host.pushFeature({ screen: screen('sessions', () => ['sessions']) });

    expect(host.setChatMode('regular')).toBe(true);
    expect(host.getChatMode()).toBe('regular');
    expect(switchMode).toHaveBeenCalledOnce();
    expect(switchMode).toHaveBeenCalledWith('regular');
    expect(presentations.map(({ id }) => id)).toEqual(['sessions']);

    expect(feature.close()).toBe(true);
    expect(switchMode).toHaveBeenCalledOnce();
    expect(presentations[0]?.close).toHaveBeenCalledOnce();
  });

  it('rolls back the configured chat mode when Pi refuses the renderer switch', () => {
    const switchMode = vi.fn(() => false);
    const host = createSurfaceHost({
      chat: { component: component(['chat']), focus: component([]) },
      setFocus: vi.fn(),
      requestRender: vi.fn(),
      switchMode,
    });

    expect(host.setChatMode('fullscreen')).toBe(false);
    expect(host.getChatMode()).toBe('regular');
  });

  it('rolls back the configured chat mode when the renderer switch throws', () => {
    const host = createSurfaceHost({
      chat: { component: component(['chat']), focus: component([]) },
      setFocus: vi.fn(),
      requestRender: vi.fn(),
      switchMode: () => {
        throw new Error('terminal restart failed');
      },
    });

    expect(() => host.setChatMode('fullscreen')).toThrow('terminal restart failed');
    expect(host.getChatMode()).toBe('regular');
    expect(host.getActiveSurface()).toEqual({ kind: 'chat', id: 'chat' });
  });

  it('restores fullscreen when a regular feature cannot be presented after a mode change', () => {
    let mode: 'regular' | 'fullscreen' = 'fullscreen';
    const switchMode = vi.fn((next: typeof mode) => {
      mode = next;
      return true;
    });
    const host = createSurfaceHost({
      chat: { component: component(['chat']), focus: component([]) },
      chatMode: 'fullscreen',
      mode: () => mode,
      regularFeaturePresenter: {
        show: () => {
          throw new Error('regular feature presentation failed');
        },
      },
      setFocus: vi.fn(),
      requestRender: vi.fn(),
      switchMode,
    });
    host.pushFeature({ screen: screen('sessions', () => ['sessions']) });

    expect(() => host.setChatMode('regular')).toThrow('regular feature presentation failed');
    expect(host.getChatMode()).toBe('fullscreen');
    expect(mode).toBe('fullscreen');
    expect(switchMode.mock.calls.map(([next]) => next)).toEqual(['regular', 'fullscreen']);
    expect(host.getActiveSurface()).toEqual({ kind: 'feature', id: 'sessions' });
  });

  it('does not mutate the feature stack when the regular presenter refuses a feature', () => {
    const host = createSurfaceHost({
      chat: { component: component(['chat']), focus: component([]) },
      regularFeaturePresenter: {
        show: () => {
          throw new Error('regular feature presentation failed');
        },
      },
      setFocus: vi.fn(),
      requestRender: vi.fn(),
    });
    const feature = screen('sessions', () => ['sessions']);

    expect(() => host.pushFeature({ screen: feature })).toThrow(
      'regular feature presentation failed',
    );
    expect(host.getActiveSurface()).toEqual({ kind: 'chat', id: 'chat' });
    expect(host.render(40)).toEqual(['chat']);
  });

  it('restores a nested feature stack when presenting the previous feature throws on close', () => {
    let failNextPresentation = false;
    const presentations: Array<{ id: string; close: ReturnType<typeof vi.fn> }> = [];
    const presenter: TuiRegularFeaturePresenter = {
      show: (feature, focus) => {
        if (failNextPresentation) {
          failNextPresentation = false;
          throw new Error('regular feature presentation failed');
        }
        const presentation = { id: feature.id, focus, close: vi.fn() };
        presentations.push(presentation);
        return presentation;
      },
    };
    const firstDispose = vi.fn();
    const secondDispose = vi.fn();
    const host = createSurfaceHost({
      chat: { component: component(['chat']), focus: component([]) },
      regularFeaturePresenter: presenter,
      setFocus: vi.fn(),
      requestRender: vi.fn(),
    });

    const first = host.pushFeature({
      screen: { ...screen('first', () => ['first']), dispose: firstDispose },
    });
    const second = host.pushFeature({
      screen: { ...screen('second', () => ['second']), dispose: secondDispose },
    });

    failNextPresentation = true;
    expect(() => second.close()).toThrow('regular feature presentation failed');
    expect(host.getActiveSurface()).toEqual({ kind: 'feature', id: 'second' });
    expect(secondDispose).not.toHaveBeenCalled();
    expect(presentations.at(-1)?.id).toBe('second');

    expect(second.close()).toBe(true);
    expect(host.getActiveSurface()).toEqual({ kind: 'feature', id: 'first' });
    expect(secondDispose).toHaveBeenCalledOnce();
    expect(first.close()).toBe(true);
    expect(firstDispose).toHaveBeenCalledOnce();
  });

  it('defers chat focus changes until the feature stack closes', () => {
    const initialChatFocus = component([]);
    const pendingDecisionFocus = component([]);
    const featureFocus = component([]);
    const setFocus = vi.fn();
    const host = createSurfaceHost({
      chat: { component: component(['chat']), focus: initialChatFocus },
      setFocus,
      requestRender: vi.fn(),
    });
    const feature = host.pushFeature({
      screen: screen('sessions', () => ['sessions']),
      focus: featureFocus,
    });

    host.setChatFocus(pendingDecisionFocus);
    expect(setFocus).toHaveBeenCalledTimes(1);
    expect(setFocus).toHaveBeenLastCalledWith(featureFocus);

    feature.close();
    expect(setFocus).toHaveBeenLastCalledWith(pendingDecisionFocus);
  });

  it('restores the highest-priority chat layer around feature navigation', () => {
    const composer = component([]);
    const interactionFocus = component([]);
    const modalFocus = component([]);
    const featureFocus = component([]);
    const setFocus = vi.fn();
    const host = createSurfaceHost({
      chat: { component: component(['chat']), focus: composer },
      setFocus,
      requestRender: vi.fn(),
    });

    const interaction = host.pushChatLayer({
      id: 'interaction',
      focus: interactionFocus,
      priority: 100,
    });
    const modal = host.pushChatLayer({
      id: 'modal',
      focus: modalFocus,
      priority: 200,
    });
    const feature = host.pushFeature({
      screen: screen('sessions', () => ['sessions']),
      focus: featureFocus,
    });

    expect(setFocus).toHaveBeenLastCalledWith(featureFocus);
    feature.close();
    expect(setFocus).toHaveBeenLastCalledWith(modalFocus);
    modal.close();
    expect(setFocus).toHaveBeenLastCalledWith(interactionFocus);
    interaction.close();
    expect(setFocus).toHaveBeenLastCalledWith(composer);
  });

  it('temporarily lets a blocking chat layer preempt a feature screen', () => {
    const composer = component([]);
    const featureFocus = component([]);
    const decisionFocus = component([]);
    const setFocus = vi.fn();
    const switchMode = vi.fn(() => true);
    const { presenter, presentations } = createRecordingPresenter();
    const host = createSurfaceHost({
      chat: { component: component(['chat decision']), focus: composer },
      regularFeaturePresenter: presenter,
      setFocus,
      requestRender: vi.fn(),
      switchMode,
    });
    host.pushFeature({
      screen: screen('transcript', () => ['transcript inspector']),
      focus: featureFocus,
    });

    const decision = host.pushChatLayer({
      id: 'interaction',
      focus: decisionFocus,
      priority: 100,
      preemptsFeatures: true,
    });

    expect(host.getActiveSurface()).toEqual({ kind: 'chat', id: 'chat' });
    expect(host.render(40)[0]).toBe('chat decision');
    expect(setFocus).toHaveBeenLastCalledWith(decisionFocus);
    expect(presentations.map(({ id }) => id)).toEqual(['transcript']);
    expect(presentations[0]?.close).toHaveBeenCalledOnce();
    expect(switchMode).not.toHaveBeenCalled();

    decision.close();
    expect(host.getActiveSurface()).toEqual({ kind: 'feature', id: 'transcript' });
    expect(host.render(40)[0]).toBe('chat decision');
    expect(setFocus).toHaveBeenLastCalledWith(featureFocus);
    expect(presentations.map(({ id }) => id)).toEqual(['transcript', 'transcript']);
    expect(switchMode).not.toHaveBeenCalled();
  });

  it('replaces an active interaction without changing the configured fullscreen renderer', () => {
    let mode: 'regular' | 'fullscreen' = 'fullscreen';
    const switchMode = vi.fn((next: typeof mode) => {
      mode = next;
      return true;
    });
    const inline = new TuiInlinePanelHost();
    const first = component(['first decision']);
    const second = component(['second decision']);
    const setFocus = vi.fn();
    const followFullscreenBottom = vi.fn();
    const host = createSurfaceHost({
      chat: { component: inline, focus: component([]) },
      chatMode: 'fullscreen',
      mode: () => mode,
      setFocus,
      requestRender: vi.fn(),
      switchMode,
    });
    host.pushFeature({ screen: screen('transcript', () => ['transcript']) });
    const interaction = new TuiInteractionSurface(
      inline,
      host,
      vi.fn(),
      undefined,
      followFullscreenBottom,
    );

    interaction.show(first);
    expect(followFullscreenBottom).toHaveBeenCalledOnce();
    expect(mode).toBe('fullscreen');
    expect(switchMode).not.toHaveBeenCalled();
    interaction.show(second);
    expect(followFullscreenBottom).toHaveBeenCalledTimes(2);

    expect(switchMode).not.toHaveBeenCalled();
    expect(inline.current()).toBe(second);
    expect(setFocus).toHaveBeenLastCalledWith(second);
  });

  it('keeps an interaction mounted when restoring its preempted regular feature throws', () => {
    let failNextPresentation = false;
    const inline = new TuiInlinePanelHost();
    const host = createSurfaceHost({
      chat: { component: inline, focus: component([]) },
      regularFeaturePresenter: {
        show: (_feature, focus) => {
          if (failNextPresentation) {
            failNextPresentation = false;
            throw new Error('feature restore failed');
          }
          return { focus, close: () => undefined };
        },
      },
      setFocus: vi.fn(),
      requestRender: vi.fn(),
    });
    host.pushFeature({ screen: screen('transcript', () => ['transcript']) });
    const interaction = new TuiInteractionSurface(inline, host, vi.fn());
    const activePanel = component(['active decision']);
    interaction.show(activePanel);
    expect(host.getActiveSurface()).toEqual({ kind: 'chat', id: 'chat' });
    failNextPresentation = true;
    expect(() => interaction.close(activePanel)).toThrow('feature restore failed');
    expect(inline.isActive(activePanel)).toBe(true);
    expect(host.getActiveSurface()).toEqual({ kind: 'chat', id: 'chat' });

    expect(interaction.close(activePanel)).toBe(true);
    expect(inline.isActive()).toBe(false);
    expect(host.getActiveSurface()).toEqual({ kind: 'feature', id: 'transcript' });
  });

  it('keeps a blocking chat layer in the configured fullscreen chat mode', () => {
    const switchMode = vi.fn(() => true);
    const host = createSurfaceHost({
      chat: { component: component(['chat']), focus: component([]) },
      chatMode: 'fullscreen',
      mode: () => 'fullscreen',
      setFocus: vi.fn(),
      requestRender: vi.fn(),
      switchMode,
    });
    host.pushFeature({ screen: screen('transcript', () => ['transcript']) });

    const interaction = host.pushChatLayer({
      id: 'interaction',
      focus: component([]),
      priority: 100,
      preemptsFeatures: true,
    });

    expect(host.getActiveSurface()).toEqual({ kind: 'chat', id: 'chat' });
    expect(switchMode).not.toHaveBeenCalled();
    expect(interaction.close()).toBe(true);
    expect(host.getActiveSurface()).toEqual({ kind: 'feature', id: 'transcript' });
    expect(switchMode).not.toHaveBeenCalled();
  });

  it('passes the complete feature document to the Pi layout tree', () => {
    const host = createSurfaceHost({
      chat: { component: component(['chat']), focus: component([]) },
      chatMode: 'fullscreen',
      mode: () => 'fullscreen',
      setFocus: vi.fn(),
      requestRender: vi.fn(),
    });
    host.pushFeature({
      screen: screen('diff', () => ['one', 'two', 'three', 'four']),
      focus: component([]),
    });

    expect(host.render(40)).toEqual(['one', 'two', 'three', 'four']);
  });

  it('disposes feature screens and distinct focus owners exactly once', () => {
    const screenDispose = vi.fn();
    const focusDispose = vi.fn();
    const feature = {
      ...screen('sessions', () => ['sessions']),
      dispose: screenDispose,
    };
    const focus = {
      ...component([]),
      dispose: focusDispose,
    };
    const host = createSurfaceHost({
      chat: { component: component(['chat']), focus: component([]) },
      setFocus: vi.fn(),
      requestRender: vi.fn(),
    });

    const handle = host.pushFeature({ screen: feature, focus });

    expect(handle.close()).toBe(true);
    expect(handle.close()).toBe(false);
    expect(screenDispose).toHaveBeenCalledOnce();
    expect(focusDispose).toHaveBeenCalledOnce();
  });

  it('disposes every feature when clearing a nested stack', () => {
    const disposals = [vi.fn(), vi.fn()];
    const host = createSurfaceHost({
      chat: { component: component(['chat']), focus: component([]) },
      setFocus: vi.fn(),
      requestRender: vi.fn(),
    });
    host.pushFeature({
      screen: { ...screen('first', () => ['first']), dispose: disposals[0] },
    });
    host.pushFeature({
      screen: { ...screen('second', () => ['second']), dispose: disposals[1] },
    });

    host.clearFeatures();

    expect(disposals[0]).toHaveBeenCalledOnce();
    expect(disposals[1]).toHaveBeenCalledOnce();
  });
});
