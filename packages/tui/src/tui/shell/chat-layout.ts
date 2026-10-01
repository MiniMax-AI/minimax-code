import {
  LAYOUT_NODE,
  ScrollView,
  type Terminal,
  type TuiMouseEvent,
  VStack,
} from '../engine/public.js';
import type { Component } from '../rendering/component.js';
import { stripAnsi } from '../rendering/text.js';
import { resolveTuiLayoutPolicy } from './layout-policy.js';

const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;

export type TuiSurface = 'welcome' | 'conversation';
export type TuiViewportPolicy = 'document' | 'fixed';

export interface TuiChatLayoutParts {
  surface: () => TuiSurface;
  welcome: Component;
  notice?: Component;
  transcript: Component;
  interaction: Component;
  activity: Component;
  goal?: Component;
  followUp: Component;
  tasks?: Component;
  composer: Component;
  status: Component;
}

interface HeightAwareComponent extends Component {
  renderViewport(width: number, height: number): string[];
}

interface ActiveAwareComponent extends Component {
  isActive(): boolean;
}

interface MouseAwareComponent extends Component {
  handleMouse(event: TuiMouseEvent): boolean;
}

export class TuiChatLayout implements Component {
  private viewportLayoutKey: string | undefined;

  getViewportLayoutKey(): string | undefined {
    return this.viewportLayoutKey;
  }
  readonly fullscreenLayoutRoot: Component;
  private readonly fullscreenBodyViewport: ScrollView;
  private pendingFullscreenFrame:
    | { readonly width: number; readonly frame: FullscreenChatFrame }
    | undefined;
  private fullscreenFooterFrame:
    | { readonly width: number; readonly frame: FullscreenChatFrame }
    | undefined;
  private fullscreenBodyMouseTarget: Component | undefined;
  private fullscreenBodyHorizontalPadding = 0;
  private fullscreenBodyMouseRange: ChatFrameRange | undefined;

  constructor(
    private readonly terminal: Terminal,
    private readonly parts: TuiChatLayoutParts,
    private readonly viewport: () => TuiViewportPolicy = () => 'document',
  ) {
    const body: MouseAwareComponent = {
      render: (width) => this.renderFullscreenBody(width),
      handleMouse: (event) => this.handleFullscreenBodyMouse(event),
      invalidate: () => {
        this.pendingFullscreenFrame = undefined;
        this.fullscreenBodyMouseTarget = undefined;
        this.fullscreenBodyMouseRange = undefined;
      },
    };
    const goalSection = this.createFullscreenFooterSection(0);
    const followUpSection = this.createFullscreenFooterSection(1);
    const tasksSection = this.createFullscreenFooterSection(2);
    const activitySection = this.createFullscreenFooterSection(3);
    const composerSection = this.createFullscreenFooterSection(4);
    const statusSection = this.createFullscreenFooterSection(5);
    const footerLayout = new VStack([
      {
        component: goalSection,
        basis: 'auto',
        shrink: 1,
        minSize: 0,
      },
      {
        component: followUpSection,
        basis: 'auto',
        shrink: 1,
        minSize: 0,
      },
      {
        component: tasksSection,
        basis: 'auto',
        shrink: 1,
        minSize: 0,
      },
      {
        component: activitySection,
        basis: 'auto',
        shrink: 1,
        minSize: 0,
      },
      {
        component: composerSection,
        basis: 'auto',
        shrink: 1,
        minSize: isActiveAwareComponent(this.parts.interaction) ? 1 : 0,
        visible: () => !this.isActiveInteraction(),
      },
      {
        component: statusSection,
        basis: 'auto',
        shrink: 1,
        minSize: 1,
      },
    ]);
    const footer = {
      render: (width: number) => this.renderFullscreenFooter(width),
      invalidate: () => {
        this.pendingFullscreenFrame = undefined;
        this.fullscreenFooterFrame = undefined;
      },
      [LAYOUT_NODE]: () => footerLayout[LAYOUT_NODE](),
    };
    this.fullscreenBodyViewport = new ScrollView(body, {
      follow: 'end',
      primary: true,
      overscroll: 'contain',
      scrollbar: 'always',
      scrollbarGutter: 3,
    });
    this.fullscreenLayoutRoot = new VStack([
      {
        component: this.fullscreenBodyViewport,
        basis: 0,
        grow: 1,
        shrink: 1,
        minSize: 1,
      },
      { component: footer, basis: 'auto', shrink: 1, minSize: 1 },
    ]);
  }

  followBottom(): void {
    if (this.fullscreenBodyViewport.isFollowingEnd) {
      this.fullscreenBodyViewport.scrollToEnd();
    }
  }

  forceFollowBottom(): void {
    this.fullscreenBodyViewport.scrollToEnd();
  }

  invalidate(): void {
    this.parts.welcome.invalidate();
    this.parts.notice?.invalidate();
    this.parts.transcript.invalidate();
    this.parts.interaction.invalidate();
    this.parts.activity.invalidate();
    this.parts.goal?.invalidate();
    this.parts.followUp.invalidate();
    this.parts.tasks?.invalidate();
    this.parts.composer.invalidate();
    this.parts.status.invalidate();
    this.pendingFullscreenFrame = undefined;
    this.fullscreenFooterFrame = undefined;
    this.fullscreenBodyMouseTarget = undefined;
    this.fullscreenBodyMouseRange = undefined;
  }

  getSurface(): TuiSurface {
    return this.parts.surface();
  }

  render(width: number): string[] {
    const frame = resolveChatFrame(width, this.terminal.rows);
    const surface = this.getSurface();
    const renderPart = (component: Component): readonly string[] =>
      insetLines(component.render(frame.contentWidth), frame.horizontalPadding);
    // Match Pi's editorContainer replacement: the mounted selector owns visibility even when a
    // transition frame is empty; rendered row count is only a fallback for legacy components.
    const interactionMounted = isActiveAwareComponent(this.parts.interaction)
      ? this.parts.interaction.isActive()
      : undefined;
    const viewportInteractionActive =
      isHeightAwareComponent(this.parts.interaction) && interactionMounted === true;
    const fullInteraction =
      interactionMounted === false || viewportInteractionActive
        ? []
        : renderPart(this.parts.interaction);
    const interactionActive = interactionMounted ?? fullInteraction.length > 0;
    const activity = renderPart(this.parts.activity);
    const composer = interactionActive ? [] : renderPart(this.parts.composer);
    const followUp = interactionActive ? [] : renderPart(this.parts.followUp);
    const goal = !interactionActive && this.parts.goal ? renderPart(this.parts.goal) : [];
    const notice = surface === 'welcome' && this.parts.notice ? renderPart(this.parts.notice) : [];
    const status = this.renderStatus(
      frame,
      activity.length +
        composer.length +
        followUp.length +
        goal.length +
        notice.length +
        (interactionActive
          ? Math.max(
              'fullscreenViewport' in this.parts.interaction &&
                this.parts.interaction.fullscreenViewport === true
                ? 4
                : 1,
              fullInteraction.length,
            )
          : 0) +
        2,
    );
    const interaction =
      interactionActive && isHeightAwareComponent(this.parts.interaction)
        ? insetLines(
            this.parts.interaction.renderViewport(
              frame.contentWidth,
              Math.max(
                1,
                (this.terminal.rows || 24) -
                  activity.length -
                  status.length -
                  (surface === 'conversation' ? 2 : 0),
              ),
            ),
            frame.horizontalPadding,
          )
        : fullInteraction;
    const tasks = interactionActive
      ? []
      : this.renderTasks(
          frame,
          goal.length + followUp.length + activity.length + composer.length + status.length,
          surface === 'conversation' ? 2 : Math.max(1, notice.length + 1),
        );
    // Activity/transcript updates may preserve host scrolling. Every transient
    // section participates here so new controls cannot silently leave blank rows.
    const viewportLayout = [
      surface, interactionActive, interaction.length, composer.length, followUp.length,
      goal.length, notice.length, tasks.length, status.length,
    ];
    if (surface === 'welcome') {
      if (interactionActive) {
        this.viewportLayoutKey = JSON.stringify([...viewportLayout, 0]);
        return this.fitDocumentFrame(
          this.viewport() === 'fixed'
            ? [interaction, activity, composer, status]
            : [interaction, goal, followUp, tasks, activity, composer, status],
        );
      }
      const tailEntries = [
        ...(notice.length > 0 ? [notice] : []),
        goal,
        followUp,
        tasks,
        activity,
        composer,
        status,
      ];
      const tailRows = tailEntries.reduce((total, lines) => total + lines.length, 0);
      const availableWelcomeRows = Math.max(1, this.terminal.rows - tailRows);
      const welcome =
        this.viewport() === 'fixed' && isHeightAwareComponent(this.parts.welcome)
          ? insetLines(
              this.parts.welcome.renderViewport(frame.contentWidth, availableWelcomeRows),
              frame.horizontalPadding,
            )
          : renderPart(this.parts.welcome);
      this.viewportLayoutKey = JSON.stringify([...viewportLayout, welcome.length]);
      return this.fitDocumentFrame([welcome, ...tailEntries]);
    }

    const footerEntries =
      interactionActive && this.viewport() === 'fixed'
        ? [interaction, activity, composer, status]
        : [
            interaction,
            goal,
            followUp,
            tasks,
            // The activity line carries the composer's draft label while a run is live, so it sits
            // directly above the editor it describes rather than above the waiting list.
            activity,
            composer,
            status,
          ];
    const transcript = renderPart(this.parts.transcript);
    const welcome = renderPart(this.parts.welcome);
    this.viewportLayoutKey = JSON.stringify([...viewportLayout, welcome.length]);
    const prelude = joinWelcomeAndTranscript(welcome, transcript);
    const bodyEntries = [prelude, transcript.length > 0 ? [''] : []];
    return this.fitDocumentFrame([...bodyEntries, ...footerEntries]);
  }

  private renderFullscreenBody(width: number): string[] {
    const frame = this.resolveFullscreenFrame(width);
    this.pendingFullscreenFrame = undefined;
    this.fullscreenBodyMouseTarget = frame.bodyMouseTarget;
    this.fullscreenBodyHorizontalPadding = frame.horizontalPadding;
    this.fullscreenBodyMouseRange = frame.bodyMouseRange;
    return [...frame.body];
  }

  private handleFullscreenBodyMouse(event: TuiMouseEvent): boolean {
    const target = this.fullscreenBodyMouseTarget;
    const range = this.fullscreenBodyMouseRange;
    if (!target || !range || !isMouseAwareComponent(target)) return false;
    if (event.y < range.start || event.y >= range.end) return false;
    return target.handleMouse({
      ...event,
      x: Math.max(0, event.x - this.fullscreenBodyHorizontalPadding),
      y: event.y - range.start,
    });
  }

  private createFullscreenFooterSection(index: number): Component {
    return {
      render: (width) => {
        const frame =
          this.fullscreenFooterFrame?.width === width
            ? this.fullscreenFooterFrame.frame
            : this.resolveFullscreenFrame(width);
        return [...(frame.footerSections[index] ?? [])];
      },
      invalidate: () => {
        this.pendingFullscreenFrame = undefined;
        this.fullscreenFooterFrame = undefined;
      },
    };
  }

  private resolveFullscreenFrame(width: number): FullscreenChatFrame {
    const pending = this.pendingFullscreenFrame;
    if (pending?.width === width) return pending.frame;
    const footerFrame = this.fullscreenFooterFrame;
    if (footerFrame?.width === width) return footerFrame.frame;
    const frame = this.composeFullscreenFrame(width);
    this.pendingFullscreenFrame = { width, frame };
    this.fullscreenFooterFrame = { width, frame };
    return frame;
  }

  private renderFullscreenFooter(width: number): string[] {
    const frame = this.composeFullscreenFrame(width);
    this.pendingFullscreenFrame = { width, frame };
    this.fullscreenFooterFrame = { width, frame };
    return frame.footerSections.flatMap((section) => section);
  }

  private isActiveInteraction(): boolean {
    return isActiveAwareComponent(this.parts.interaction) && this.parts.interaction.isActive();
  }

  private composeFullscreenFrame(width: number): FullscreenChatFrame {
    const frame = resolveChatFrame(width, this.terminal.rows);
    const surface = this.getSurface();
    const renderPart = (component: Component): string[] => [
      ...insetLines(component.render(frame.contentWidth), frame.horizontalPadding),
    ];
    const activity = renderPart(this.parts.activity);
    const interactionMounted = isActiveAwareComponent(this.parts.interaction)
      ? this.parts.interaction.isActive()
      : undefined;
    const viewportInteraction =
      isHeightAwareComponent(this.parts.interaction) &&
      'fullscreenViewport' in this.parts.interaction &&
      this.parts.interaction.fullscreenViewport === true
        ? this.parts.interaction
        : undefined;
    const fullInteraction =
      interactionMounted === false || viewportInteraction ? [] : renderPart(this.parts.interaction);
    const interactionActive = interactionMounted ?? fullInteraction.length > 0;
    if (interactionActive) {
      const status = this.renderStatus(
        frame,
        // Keep search, selection, preview/error and actions ahead of custom status blocks.
        activity.length + (viewportInteraction ? 4 : Math.max(1, fullInteraction.length)),
      );
      const interaction = viewportInteraction
        ? insetLines(
            viewportInteraction.renderViewport(
              frame.contentWidth,
              Math.max(1, (this.terminal.rows || 24) - activity.length - status.length),
            ),
            frame.horizontalPadding,
          )
        : fullInteraction;
      const welcome = renderPart(this.parts.welcome);
      const transcript = renderPart(this.parts.transcript);
      const welcomeAndTranscript = joinWelcomeAndTranscript(welcome, transcript);
      const prelude = [
        ...welcomeAndTranscript,
        ...(transcript.length > 0 && interaction.length > 0 ? [''] : []),
      ];
      return {
        body: [...prelude, ...interaction],
        footerSections: [[], [], [], activity, [], status],
        bodyMouseTarget: this.parts.interaction,
        bodyMouseRange: { start: prelude.length, end: prelude.length + interaction.length },
        horizontalPadding: frame.horizontalPadding,
      };
    }

    const goal = this.parts.goal ? renderPart(this.parts.goal) : [];
    const followUp = renderPart(this.parts.followUp);
    const composer = renderPart(this.parts.composer);
    const notice = surface === 'welcome' && this.parts.notice ? renderPart(this.parts.notice) : [];
    const status = this.renderStatus(
      frame,
      goal.length + followUp.length + activity.length + composer.length + notice.length + 1,
    );
    const tasks = this.renderTasks(
      frame,
      goal.length + followUp.length + activity.length + composer.length + status.length,
      surface === 'conversation' ? 1 : Math.max(1, notice.length + 1),
    );
    if (surface === 'welcome') {
      const availableRows = Math.max(
        1,
        (this.terminal.rows || 24) -
          goal.length -
          followUp.length -
          tasks.length -
          activity.length -
          composer.length -
          status.length,
      );
      const welcome = isHeightAwareComponent(this.parts.welcome)
        ? insetLines(
            this.parts.welcome.renderViewport(frame.contentWidth, availableRows),
            frame.horizontalPadding,
          )
        : renderPart(this.parts.welcome);
      return {
        body: [...welcome, ...notice],
        footerSections: [goal, followUp, tasks, activity, composer, status],
        horizontalPadding: frame.horizontalPadding,
      };
    }

    const welcome = renderPart(this.parts.welcome);
    const transcript = renderPart(this.parts.transcript);
    return {
      body: [
        ...joinWelcomeAndTranscript(welcome, transcript),
        ...(transcript.length > 0 ? [''] : []),
      ],
      footerSections: [goal, followUp, tasks, activity, composer, status],
      horizontalPadding: frame.horizontalPadding,
    };
  }

  private renderStatus(frame: ChatFrameLayout, reservedRows: number): string[] {
    const status = this.parts.status;
    const lines = isHeightAwareComponent(status)
      ? status.renderViewport(
          frame.contentWidth,
          Math.max(0, (this.terminal.rows || 24) - reservedRows),
        )
      : status.render(frame.contentWidth);
    return [...insetLines(lines, frame.horizontalPadding)];
  }

  private renderTasks(
    frame: ChatFrameLayout,
    reservedRows: number,
    minimumBodyRows: number,
  ): string[] {
    const tasks = this.parts.tasks;
    if (!tasks) return [];
    const lines =
      this.viewport() === 'fixed' && isHeightAwareComponent(tasks)
        ? tasks.renderViewport(
            frame.contentWidth,
            Math.max(0, (this.terminal.rows || 24) - reservedRows - minimumBodyRows),
          )
        : tasks.render(frame.contentWidth);
    return [...insetLines(lines, frame.horizontalPadding)];
  }

  private fitDocumentFrame(entries: readonly (readonly string[])[]): string[] {
    const lines = entries.flatMap((sectionLines) => sectionLines);
    const maxRows =
      this.viewport() === 'fixed'
        ? Math.max(1, this.terminal.rows || 24)
        : Number.POSITIVE_INFINITY;
    const trimmedRows = Math.max(0, lines.length - maxRows);
    return trimmedRows > 0 ? lines.slice(trimmedRows) : lines;
  }
}

interface ChatFrameRange {
  readonly start: number;
  readonly end: number;
}

interface FullscreenChatFrame {
  readonly body: readonly string[];
  readonly footerSections: readonly (readonly string[])[];
  readonly bodyMouseTarget?: Component;
  readonly bodyMouseRange?: ChatFrameRange;
  readonly horizontalPadding: number;
}

interface ChatFrameLayout {
  readonly contentWidth: number;
  readonly horizontalPadding: number;
}

function isHeightAwareComponent(component: Component): component is HeightAwareComponent {
  return 'renderViewport' in component && typeof component.renderViewport === 'function';
}

function isActiveAwareComponent(component: Component): component is ActiveAwareComponent {
  return 'isActive' in component && typeof component.isActive === 'function';
}

function isMouseAwareComponent(component: Component): component is MouseAwareComponent {
  return 'handleMouse' in component && typeof component.handleMouse === 'function';
}

function joinWelcomeAndTranscript(
  welcome: readonly string[],
  transcript: readonly string[],
): string[] {
  if (welcome.length === 0) return [...transcript];
  if (transcript.length === 0) return [...welcome];

  const compactWelcome = [...welcome];
  while (compactWelcome.length > 0 && isVisuallyBlank(compactWelcome.at(-1) ?? '')) {
    compactWelcome.pop();
  }
  return [...compactWelcome, ...(isVisuallyBlank(transcript[0] ?? '') ? [] : ['']), ...transcript];
}

function isVisuallyBlank(line: string): boolean {
  return stripAnsi(line).trim().length === 0;
}

function resolveChatFrame(width: number, rows: number): ChatFrameLayout {
  const policy = resolveTuiLayoutPolicy(width, rows || 24);
  const horizontalPadding = Math.min(
    policy.horizontalPadding,
    Math.max(0, Math.floor((policy.columns - 1) / 2)),
  );
  return {
    contentWidth: Math.max(1, policy.columns - horizontalPadding * 2),
    horizontalPadding,
  };
}

function insetLines(lines: readonly string[], horizontalPadding: number): readonly string[] {
  if (horizontalPadding === 0) return lines;
  const prefix = ' '.repeat(horizontalPadding);
  return lines.map((line) => {
    if (line.length === 0) return line;
    const semanticPrefix = line.match(OSC133_ZONE_PREFIX)?.[0];
    return semanticPrefix
      ? `${semanticPrefix}${prefix}${line.slice(semanticPrefix.length)}`
      : `${prefix}${line}`;
  });
}
