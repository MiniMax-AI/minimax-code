import type { TuiGoalPort } from '../../../runtime/port.js';
import type { TuiThreadGoalEvent } from '../../../types/runtime-events.js';
import {
  parseTuiThreadGoalCommand,
  TUI_THREAD_GOAL_COMMAND_HELP,
} from '../../../application/thread-goal-command.js';
import { formatTuiActionFailure } from '../../../user-facing-failure.js';
import type { TuiComposerDraft, TuiComposerDraftSnapshot } from '../../features/composer/draft.js';
import {
  formatGoalCompletionReceipt,
  formatGoalSummary,
  type TuiGoalBanner,
} from '../../features/goal/banner.js';
import type { TuiSurfaceHost } from '../../shell/surface-host.js';
import type { Editor } from '../../widgets/editor/editor.js';

export type TuiGoalCommandDisposition = 'consumed' | 'retained';

export interface TuiGoalFlowOptions {
  readonly runtime: TuiGoalPort;
  readonly currentSessionId: () => string | undefined;
  readonly ensureSessionId?: () => Promise<string | undefined>;
  readonly banner: TuiGoalBanner;
  readonly composerDraft: TuiComposerDraft;
  readonly editor: Editor;
  readonly surfaceHost: TuiSurfaceHost;
  readonly append: (content: string, kind?: 'warning' | 'error') => void;
  readonly setHint: (message: string | undefined) => void;
  readonly onChanged: () => void;
  /**
   * Whether a response is still in flight for the active Session. Clearing or
   * pausing a Goal only stops future continuations, so the hint says how to
   * stop the current response instead of implying it already stopped.
   */
  readonly hasLiveRun?: () => boolean;
}

/** Suffix for Goal hints issued while a response is still running. */
export const TUI_GOAL_LIVE_RUN_HINT_SUFFIX =
  'The current response keeps running; press Esc to interrupt it.';

export class TuiGoalFlow {
  private refreshSequence = 0;
  private readonly announcedCompletedGoalIds = new Set<string>();

  constructor(private readonly options: TuiGoalFlowOptions) {}

  async execute(rawArgs: string): Promise<TuiGoalCommandDisposition> {
    const intent = parseTuiThreadGoalCommand(rawArgs);
    if (intent.kind === 'help') {
      this.options.append(TUI_THREAD_GOAL_COMMAND_HELP);
      return 'consumed';
    }
    if (intent.kind === 'error') {
      this.options.append(intent.message, 'warning');
      return 'retained';
    }
    const captured = this.options.composerDraft.capture();

    try {
      let sessionId = this.options.currentSessionId();
      if (!sessionId && intent.kind === 'create') {
        sessionId = await this.options.ensureSessionId?.();
      }
      if (!sessionId) {
        this.options.append(
          intent.kind === 'create'
            ? "Couldn't create a Session for this Goal. Retry after the Runtime recovers."
            : 'Start or resume a Session before managing its Goal.',
          'warning',
        );
        return 'retained';
      }
      const operationSequence = ++this.refreshSequence;
      if (!this.options.runtime.isGoalEnabled()) {
        this.options.append('Thread Goal is disabled in the current Runtime.', 'warning');
        return 'retained';
      }
      const existing = await this.options.runtime.getGoal(sessionId);
      if (!this.canProjectOperation(sessionId, operationSequence)) return 'consumed';
      if (intent.kind === 'create') {
        return await this.setObjective(
          sessionId,
          intent.objective,
          intent.tokenBudget,
          existing,
          operationSequence,
          captured,
        );
      }
      if (!existing) {
        this.options.append('No Goal exists for the active Session.', 'warning');
        return 'consumed';
      }
      if (intent.kind === 'view') {
        this.options.append(formatGoalSummary(existing));
        return 'consumed';
      }
      if (intent.kind === 'budget') {
        const updated = await this.options.runtime.patchGoal(sessionId, {
          tokenBudget: intent.tokenBudget,
        });
        if (this.canProjectOperation(sessionId, operationSequence)) {
          this.options.banner.setGoal(updated);
          this.options.setHint(
            intent.tokenBudget === null ? 'Goal budget cleared.' : 'Goal budget updated.',
          );
          this.options.onChanged();
        }
        return 'consumed';
      }
      if (intent.kind === 'edit') {
        this.options.editor.setText(`/goal ${existing.objective}`);
        this.options.surfaceHost.setChatFocus(this.options.editor);
        this.options.setHint('Edit the Goal objective, then press Enter.');
        this.options.onChanged();
        return 'consumed';
      }
      if (intent.kind === 'clear') {
        await this.options.runtime.clearGoal(sessionId);
        if (this.canProjectOperation(sessionId, operationSequence)) {
          this.options.banner.setGoal(undefined);
          this.options.setHint(this.withLiveRunNotice('Goal cleared.'));
          this.options.onChanged();
        }
        return 'consumed';
      }
      if (intent.kind === 'resume' && existing.status === 'budget_limited') {
        this.options.append(
          'This Goal exhausted its execution budget. Clear it, then start a new Goal.',
          'warning',
        );
        return 'consumed';
      }
      const status = intent.kind === 'pause' ? 'paused' : 'active';
      const updated = await this.options.runtime.patchGoal(sessionId, { status });
      if (this.canProjectOperation(sessionId, operationSequence)) {
        this.options.banner.setGoal(updated);
        this.options.setHint(
          status === 'paused' ? this.withLiveRunNotice('Goal paused.') : 'Goal resumed.',
        );
        this.options.onChanged();
      }
      return 'consumed';
    } catch (error) {
      this.appendFailure(error);
      return 'retained';
    }
  }

  private withLiveRunNotice(message: string): string {
    return this.options.hasLiveRun?.() ? `${message} ${TUI_GOAL_LIVE_RUN_HINT_SUFFIX}` : message;
  }

  async resumeBlocked(): Promise<'not-blocked' | 'resumed' | 'failed'> {
    const goal = this.options.banner.getGoal();
    const sessionId = this.options.currentSessionId();
    if (!goal || goal.status !== 'blocked' || !sessionId || goal.sessionId !== sessionId) {
      return 'not-blocked';
    }
    try {
      const updated = await this.options.runtime.patchGoal(sessionId, { status: 'active' });
      if (this.options.currentSessionId() === sessionId) {
        this.options.banner.setGoal(updated);
        this.options.setHint('Goal resumed.');
        this.options.onChanged();
      }
      return 'resumed';
    } catch (error) {
      this.appendFailure(error);
      return 'failed';
    }
  }

  async refresh(sessionId = this.options.currentSessionId()): Promise<void> {
    const sequence = ++this.refreshSequence;
    if (!sessionId) {
      this.options.banner.setGoal(undefined);
      return;
    }
    try {
      if (!this.options.runtime.isGoalEnabled()) {
        if (sequence === this.refreshSequence) this.options.banner.setGoal(undefined);
        return;
      }
      const goal = await this.options.runtime.getGoal(sessionId);
      if (sequence === this.refreshSequence && this.options.currentSessionId() === sessionId) {
        this.options.banner.setGoal(goal?.status === 'complete' ? undefined : goal);
        this.options.onChanged();
      }
    } catch {
      if (sequence === this.refreshSequence && this.options.currentSessionId() === sessionId) {
        this.options.banner.setGoal(undefined);
      }
    }
  }

  reset(): void {
    this.refreshSequence += 1;
    this.options.banner.setGoal(undefined);
  }

  project(event: TuiThreadGoalEvent): void {
    if (event.sessionId !== this.options.currentSessionId()) return;
    this.refreshSequence += 1;
    if (event.type === 'thread_goal.updated') {
      if (event.goal.status === 'complete') {
        this.options.banner.setGoal(undefined);
        if (!this.announcedCompletedGoalIds.has(event.goal.goalId)) {
          this.announcedCompletedGoalIds.add(event.goal.goalId);
          this.options.append(formatGoalCompletionReceipt(event.goal));
        }
      } else {
        this.options.banner.setGoal(event.goal);
      }
    } else if (
      !this.options.banner.getGoal() ||
      this.options.banner.getGoal()?.goalId === event.goalId
    ) {
      this.options.banner.setGoal(undefined);
    }
    this.options.onChanged();
  }

  private async setObjective(
    sessionId: string,
    objective: string,
    tokenBudget: number | null | undefined,
    existing: Awaited<ReturnType<TuiGoalPort['getGoal']>>,
    operationSequence: number,
    captured: TuiComposerDraftSnapshot,
  ): Promise<TuiGoalCommandDisposition> {
    if (existing && existing.status !== 'complete') {
      if (captured.attachments.length > 0) {
        this.options.append(
          'Goal kickoff attachments are immutable. Remove the attachments to edit this Goal, or clear it and start a new Goal.',
          'warning',
        );
        return 'retained';
      }
      const updated = await this.options.runtime.patchGoal(sessionId, {
        objective,
        ...(tokenBudget !== undefined ? { tokenBudget } : {}),
      });
      if (this.canProjectOperation(sessionId, operationSequence)) {
        this.options.banner.setGoal(updated);
        this.options.setHint('Goal objective updated.');
        this.options.onChanged();
      }
      return 'consumed';
    }

    let reserved: TuiComposerDraftSnapshot | undefined;
    try {
      reserved = captured;
      this.options.composerDraft.reserveSubmission(captured);
      const created = await this.options.runtime.createGoal({
        sessionId,
        objective,
        ...(tokenBudget !== undefined ? { tokenBudget } : {}),
        ...(captured.attachments.length > 0 ? { attachments: captured.attachments } : {}),
      });
      if (this.canProjectOperation(sessionId, operationSequence)) {
        this.options.banner.setGoal(created);
        this.options.setHint('Goal started.');
        this.options.onChanged();
      }
      await this.options.composerDraft.completeSubmission(reserved).catch((error: unknown) => {
        this.options.append(
          formatTuiActionFailure(error, {
            summary: "Couldn't clean up the submitted Goal attachments.",
            nextStep: 'The Goal was still created.',
          }),
          'warning',
        );
      });
      return 'consumed';
    } catch (error) {
      if (reserved) this.options.composerDraft.restoreSubmission(reserved);
      throw error;
    }
  }

  private canProjectOperation(sessionId: string, sequence: number): boolean {
    return sequence === this.refreshSequence && this.options.currentSessionId() === sessionId;
  }

  private appendFailure(error: unknown): void {
    this.options.append(
      formatTuiActionFailure(error, {
        summary: "Couldn't update the Goal.",
        nextStep: 'Retry /goal after the Runtime recovers.',
        preservation: 'Your draft is preserved.',
      }),
      'error',
    );
  }
}
