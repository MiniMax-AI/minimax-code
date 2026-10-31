import { getKeybindings, Markdown } from '../../engine/public.js';
import type { ActiveTuiQuestionnaire } from '../../interaction/questionnaire.js';
import type { Component } from '../../rendering/component.js';
import { truncateToWidth } from '../../rendering/text.js';
import { renderTuiActionHint, tuiMarkdownTheme } from '../../theme/runtime.js';
import { questionnaireFrameContentWidth, renderQuestionnaireFrame } from './decision-frame.js';
import { renderPlanPathRows } from './plan-path.js';

export interface TuiPlanViewerOptions {
  readonly title?: string;
  readonly footer?: () => string;
}

export class TuiPlanViewerPanel implements Component {
  private readonly markdown: Markdown;
  private readonly path: string | undefined;
  private viewportOffset = 0;
  private viewportRows = 0;
  private viewportLineCount = 0;

  constructor(
    state: ActiveTuiQuestionnaire,
    private readonly onClose: () => void,
    private readonly requestRender: () => void = () => undefined,
    private readonly options: TuiPlanViewerOptions = {},
  ) {
    const planReview = state.request.modePayload?.planReview;
    this.markdown = new Markdown(planReview?.markdown ?? '', 0, 0, tuiMarkdownTheme);
    this.path = planReview?.path;
  }

  handleInput(data: string): void {
    if (getKeybindings().matches(data, 'tui.select.cancel')) this.onClose();
  }

  invalidate(): void {
    this.markdown.invalidate();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth === 0) return [];
    const contentWidth = questionnaireFrameContentWidth(safeWidth);
    const rendered = this.markdown
      .render(contentWidth)
      .map((line) => truncateToWidth(line, contentWidth));
    return this.renderFrame(safeWidth, rendered);
  }

  renderViewport(width: number, rawHeight: number): readonly string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    const height = Math.max(1, Math.floor(rawHeight));
    if (safeWidth === 0) return [];
    const contentWidth = questionnaireFrameContentWidth(safeWidth);
    const planLines = this.markdown
      .render(contentWidth)
      .map((line) => truncateToWidth(line, contentWidth));
    const full = this.renderFrame(safeWidth, planLines);
    if (full.length <= height) {
      this.viewportOffset = 0;
      this.viewportRows = planLines.length;
      this.viewportLineCount = planLines.length;
      return full;
    }

    const fixedRows = this.renderFrame(safeWidth, [], ['Lines 1-1 of 1 · PgUp/PgDn scroll']).length;
    if (fixedRows >= height) {
      if (height === 1) return [full[0] ?? ''];
      return [...full.slice(0, height - 1), full.at(-1) ?? ''];
    }
    this.viewportRows = height - fixedRows;
    this.viewportLineCount = planLines.length;
    this.viewportOffset = clamp(
      this.viewportOffset,
      0,
      Math.max(0, planLines.length - this.viewportRows),
    );
    const end = Math.min(planLines.length, this.viewportOffset + this.viewportRows);
    return this.renderFrame(safeWidth, planLines.slice(this.viewportOffset, end), [
      `Lines ${String(this.viewportOffset + 1)}-${String(end)} of ${String(planLines.length)} · PgUp/PgDn scroll`,
    ]).slice(0, height);
  }

  scrollByRows(delta: number): number {
    if (this.viewportRows === 0) return 0;
    const maximum = Math.max(0, this.viewportLineCount - this.viewportRows);
    const next = clamp(this.viewportOffset + Math.trunc(delta), 0, maximum);
    const scrolled = next - this.viewportOffset;
    if (scrolled === 0) return 0;
    this.viewportOffset = next;
    this.requestRender();
    return scrolled;
  }

  scrollByPage(direction: -1 | 1): number {
    return this.scrollByRows(direction * Math.max(1, this.viewportRows - 1));
  }

  private renderFrame(
    width: number,
    body: readonly string[],
    navigation: readonly string[] = [],
  ): string[] {
    const contentWidth = questionnaireFrameContentWidth(width);
    return renderQuestionnaireFrame(
      {
        title: this.options.title ?? 'Latest Plan',
        navigation: [
          ...renderPlanPathRows(this.path, contentWidth),
          ...navigation.map(renderTuiActionHint),
        ],
        body,
        footer: this.options.footer?.() ?? 'Esc close',
      },
      width,
      'signal',
    );
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
