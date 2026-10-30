import { matchesKey, type TuiMouseEvent } from '../../engine/public.js';
import type { Component, Focusable } from '../../rendering/component.js';
import {
  renderTuiActionHint,
  tuiChalk as chalk,
  tuiColors as colors,
} from '../../theme/runtime.js';
import { Input } from '../../widgets/input.js';
import type { ActiveTuiQuestionnaire } from '../../interaction/questionnaire.js';
import { selectInteractionViewportRows } from '../../shell/inline-panel.js';
import { questionnaireFrameContentWidth, renderQuestionnaireFrame } from './decision-frame.js';
import { renderPlanPathRows } from './plan-path.js';
import { TuiPlanViewerPanel } from './plan-viewer-panel.js';

export type TuiPlanReviewAction =
  | { readonly kind: 'approve' }
  | { readonly kind: 'feedback'; readonly text: string }
  | { readonly kind: 'skip' };

const PLAN_REVIEW_OPTIONS = [
  'Agree and start implementation',
  'Skip for now',
  'Add context to revise',
] as const;

export interface TuiPlanReviewPanelOptions {
  /** Current label of the full-view shortcut, or undefined when it is unbound. */
  readonly fullViewShortcut?: () => string | undefined;
}

/**
 * Compact decision surface for Plan Review.
 *
 * The frozen plan is also projected into the Transcript, but regular mode can
 * only show its tail while the review is pending. The panel therefore names the
 * Plan File and opens a read-only full view of the snapshot on demand; closing
 * it returns to the same selection and feedback draft.
 */
export class TuiPlanReviewPanel implements Component, Focusable {
  private readonly reviewDescription: string | undefined;
  private readonly planPath: string | undefined;
  private readonly input = new Input();
  private _focused = false;
  private mode: 'review' | 'feedback' = 'review';
  private selectedIndex = 0;
  private submittingLabel: string | undefined;
  private optionRows: readonly number[] = [];
  /** Rendered row shown at each viewport row when the decision was clipped to fit. */
  private viewportRows: readonly number[] | undefined;
  private fullView: TuiPlanViewerPanel | undefined;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.syncInputFocus();
  }

  constructor(
    private readonly state: ActiveTuiQuestionnaire,
    private readonly onAction: (action: TuiPlanReviewAction) => void,
    private readonly requestRender: () => void,
    private readonly options: TuiPlanReviewPanelOptions = {},
  ) {
    this.reviewDescription = state.request.steps
      .find((step) => step.id === 'plan-review')
      ?.description?.trim();
    this.planPath = state.request.modePayload?.planReview?.path;
    this.input.onSubmit = (value) => {
      const text = value.trim();
      if (!text || this.submittingLabel) return;
      this.beginSubmitting('Sending feedback…');
      this.onAction({ kind: 'feedback', text });
    };
    this.input.onEscape = () => {
      this.mode = 'review';
      this.syncInputFocus();
      this.requestRender();
    };
  }

  handleInput(data: string): void {
    if (this.fullView) {
      this.fullView.handleInput(data);
      return;
    }
    if (this.submittingLabel) return;
    if (this.mode === 'feedback') {
      this.input.handleInput(data);
      return;
    }
    if (matchesKey(data, 'up')) {
      this.selectedIndex =
        this.selectedIndex === 0 ? PLAN_REVIEW_OPTIONS.length - 1 : this.selectedIndex - 1;
      this.requestRender();
      return;
    }
    if (matchesKey(data, 'down')) {
      this.selectedIndex = (this.selectedIndex + 1) % PLAN_REVIEW_OPTIONS.length;
      this.requestRender();
      return;
    }
    if (matchesKey(data, 'enter')) {
      this.confirmSelection();
      return;
    }
    if (matchesKey(data, 'escape')) {
      this.beginSubmitting('Skipping review…');
      this.onAction({ kind: 'skip' });
    }
  }

  private confirmSelection(): void {
    if (this.selectedIndex === 0) {
      this.beginSubmitting('Starting implementation…');
      this.onAction({ kind: 'approve' });
      return;
    }
    if (this.selectedIndex === 1) {
      this.beginSubmitting('Skipping review…');
      this.onAction({ kind: 'skip' });
      return;
    }
    this.mode = 'feedback';
    this.syncInputFocus();
    this.requestRender();
  }

  beginSubmitting(label: string): void {
    this.submittingLabel = label;
    this.syncInputFocus();
    this.requestRender();
  }

  restore(): void {
    this.submittingLabel = undefined;
    this.syncInputFocus();
    this.requestRender();
  }

  /** Opens or closes the read-only full view; returns false while a decision is being sent. */
  toggleFullView(): boolean {
    if (this.fullView) {
      this.closeFullView();
      return true;
    }
    if (this.submittingLabel) return false;
    this.fullView = new TuiPlanViewerPanel(
      this.state,
      () => this.closeFullView(),
      this.requestRender,
      {
        title: 'Plan · pending review',
        footer: () => {
          const shortcut = this.fullViewShortcut();
          return `${shortcut ? `${shortcut} / ` : ''}Esc back to review`;
        },
      },
    );
    this.syncInputFocus();
    this.requestRender();
    return true;
  }

  heldRowsHint(): string | undefined {
    const shortcut = this.fullViewShortcut();
    return shortcut ? `${shortcut} view full plan` : undefined;
  }

  renderViewport(width: number, height: number): readonly string[] {
    if (this.fullView) return this.fullView.renderViewport(width, height);
    const lines = this.render(width);
    const rows = selectInteractionViewportRows(lines, height);
    this.viewportRows = rows.length < lines.length ? rows : undefined;
    return rows.map((index) => lines[index] ?? '');
  }

  scrollByRows(delta: number): number {
    return this.fullView?.scrollByRows(delta) ?? 0;
  }

  scrollByPage(direction: -1 | 1): number {
    return this.fullView?.scrollByPage(direction) ?? 0;
  }

  invalidate(): void {
    this.input.invalidate();
    this.fullView?.invalidate();
  }

  render(width: number): string[] {
    this.viewportRows = undefined;
    const safeWidth = Math.max(0, width);
    if (safeWidth === 0) return [];
    if (this.fullView) return this.fullView.render(safeWidth);
    const contentWidth = questionnaireFrameContentWidth(safeWidth);
    if (this.submittingLabel) {
      this.optionRows = [];
      return renderQuestionnaireFrame(
        {
          title: 'Plan Review',
          body: [
            chalk.bold.hex(colors.text)(this.submittingLabel),
            chalk.hex(colors.muted)('Waiting for Runtime to commit the decision.'),
          ],
        },
        safeWidth,
        'signal',
      );
    }
    if (this.mode === 'feedback') {
      this.optionRows = [];
      const shortcut = this.fullViewShortcut();
      return renderQuestionnaireFrame(
        {
          title: 'Add context',
          body: [
            renderTuiActionHint('Tell MiniMax Code what to adjust, then press Enter.'),
            ...this.input.render(contentWidth),
          ],
          footer: [
            'Enter send',
            ...(shortcut ? [`${shortcut} view full plan`] : []),
            'Esc back',
          ].join(' · '),
        },
        safeWidth,
        'signal',
      );
    }

    return [...this.renderReviewFrame(safeWidth)];
  }

  handleMouse(event: TuiMouseEvent): boolean {
    const isPrimaryAction =
      event.button === 'primary' || (event.action === 'release' && event.button === 'none');
    if (this.fullView || this.mode !== 'review' || this.submittingLabel || !isPrimaryAction) {
      return false;
    }
    const row = this.viewportRows ? this.viewportRows[event.y] : event.y;
    const index = row === undefined ? -1 : this.optionRows.indexOf(row);
    if (index < 0) return false;
    this.selectedIndex = index;
    if (event.action === 'release') this.confirmSelection();
    else this.requestRender();
    return true;
  }

  private closeFullView(): void {
    if (!this.fullView) return;
    this.fullView = undefined;
    this.syncInputFocus();
    this.requestRender();
  }

  private fullViewShortcut(): string | undefined {
    const shortcut = this.options.fullViewShortcut?.();
    return shortcut && shortcut !== 'Unbound' ? shortcut : undefined;
  }

  private syncInputFocus(): void {
    this.input.focused =
      this._focused &&
      this.mode === 'feedback' &&
      this.submittingLabel === undefined &&
      this.fullView === undefined;
  }

  private renderReviewFrame(safeWidth: number): readonly string[] {
    const descriptionLines = this.reviewDescription
      ? [chalk.hex(colors.warning)(this.reviewDescription), '']
      : [];
    const pathRows = renderPlanPathRows(this.planPath, questionnaireFrameContentWidth(safeWidth));
    const pathLines = pathRows.length > 0 ? [...pathRows, ''] : [];
    const shortcut = this.fullViewShortcut();
    const body = [
      ...descriptionLines,
      ...pathLines,
      chalk.bold.hex(colors.text)('Plan complete. What would you like to do?'),
      ...PLAN_REVIEW_OPTIONS.map((label, index) =>
        renderPlanReviewOption(label, index === this.selectedIndex),
      ),
    ];
    const headerRows = safeWidth < 12 ? 0 : 1;
    const firstOptionRow = headerRows + descriptionLines.length + pathLines.length + 1;
    this.optionRows = PLAN_REVIEW_OPTIONS.map((_, index) => firstOptionRow + index);
    return renderQuestionnaireFrame(
      {
        title: 'Plan Review',
        meta: chalk.hex(colors.muted)('frozen snapshot'),
        body,
        footer: [
          '↑/↓ select',
          'Enter confirm',
          ...(shortcut ? [`${shortcut} view full plan`] : []),
          'Esc skip',
        ].join(' · '),
      },
      safeWidth,
      'signal',
    );
  }
}

export function isTuiPlanReview(state: ActiveTuiQuestionnaire): boolean {
  return state.request.mode === 'plan' && Boolean(state.request.modePayload?.planReview);
}

function renderPlanReviewOption(label: string, selected: boolean): string {
  if (selected)
    return `${chalk.bold.hex(colors.signal)('›')} ${chalk.bold.hex(colors.text)(label)}`;
  return `  ${chalk.hex(colors.muted)(label)}`;
}
