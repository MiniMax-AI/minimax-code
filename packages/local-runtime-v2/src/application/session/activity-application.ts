import {
  SessionActivityKind,
  SessionActivityState,
  type GetSessionActivityInput as GetSessionActivityReq,
  type GetSessionActivityResult as GetSessionActivityResp,
  type SessionActivityItem,
} from '@mavis/protocol/local';

import { isSelfReminderId } from '@mavis/shared/cron-purpose';
import type { ApplicationContext } from '../context.js';
import { AppError } from '../errors.js';
import type {
  LocalRuntimeApplication,
  LocalRuntimeBackgroundTaskQuery,
  LocalRuntimeBackgroundTaskStatus,
  LocalRuntimeBackgroundTaskView,
} from './process-local-application-contract.js';
import { isTaskSession } from '../../service/session-system/index.js';

/**
 * Upper bound on sessions inspected per request; a larger tree is reported as truncated.
 * Finished subagent and verifier sessions stay in the tree for good, so the bound covers a
 * session's whole history, not just its live work. Each session costs several reads per
 * poll (including a Queue write transaction) and automation clients poll once a second,
 * so the bound also caps the per-poll load one status query puts on the runtime.
 */
const SESSION_ACTIVITY_MAX_SESSIONS = 64;

export const ACTIVE_TASK_STATUSES: readonly LocalRuntimeBackgroundTaskStatus[] = [
  'queued',
  'running',
  'stopping',
];
export const TERMINAL_TASK_STATUSES: readonly LocalRuntimeBackgroundTaskStatus[] = [
  'succeeded',
  'failed',
  'canceled',
  'lost',
];
/** The process-local task list caps a page at 100 rows. */
const TASK_PAGE_LIMIT = 100;
/**
 * `refId` of the stand-in TaskNotification item reported when a session's undelivered
 * terminal Tasks fill a whole page: the rows beyond it were not read, so a pending
 * notification among them cannot be ruled out.
 */
const TASK_PAGE_FULL_REF = 'page_full';
/**
 * Thread Goal states that still schedule continuation Turns. `budget_limited` is terminal:
 * the budget wraps up inside the Goal Turn that hit it and no summary Turn follows.
 */
export const CONTINUING_GOAL_STATUSES: Record<string, true> = { active: true };

interface SessionActivityGoal {
  readonly goalId: string;
  readonly status: string;
}

interface SessionActivityCronEntry {
  readonly cronId: string;
  /** `run`: a Run is admitted but not yet delivered. `schedule`: a future trigger exists. */
  readonly kind: 'run' | 'schedule';
  readonly nextRunAtMs?: number;
}

/** Session facts the walk needs: identity, owning agent and the child-worker shape. */
type SessionActivitySession = Parameters<typeof isTaskSession>[0] & {
  readonly sessionId: string;
  readonly agentName: string;
};

/**
 * Ports over the capabilities that can keep a session busy or wake it. None of them admits,
 * cancels or delivers work; `queue.snapshot` runs in a write transaction that also prunes
 * expired Queue items.
 */
export interface SessionActivityApplicationOptions {
  readonly sessions: {
    get(sessionId: string): Promise<SessionActivitySession | undefined>;
    listChildren(parentSessionId: string): Promise<readonly SessionActivitySession[]>;
  };
  readonly turns: {
    activeTurn(sessionId: string): Promise<
      | {
          readonly turnId: string;
          readonly busyReason: 'turn' | 'compaction';
        }
      | undefined
    >;
    /**
     * Most recently accepted Turn and whether it completed. Lets the reader see a Turn that
     * both started and ended inside its read window; without it only a Turn active at the
     * start of the window can be seen ending.
     */
    latestTurnActivity?(
      sessionId: string,
    ): Promise<{ readonly turnId: string; readonly completedAtMs?: number } | undefined>;
  };
  readonly queue: {
    snapshot(sessionId: string): Promise<{
      readonly pendingCount: number;
      readonly pause?: { readonly cause: string; readonly triggerTurnId: string };
    }>;
  };
  readonly backgroundTasks?: {
    list(
      input: LocalRuntimeBackgroundTaskQuery,
    ): Promise<readonly LocalRuntimeBackgroundTaskView[]>;
  };
  readonly questionnaires?: {
    getPending(input: {
      agentName: string;
      sessionId: string;
    }): Promise<{ readonly id: string; readonly mode?: string } | undefined>;
  };
  readonly permissions?: {
    listPending(): Promise<readonly { readonly requestId: string; readonly sessionId: string }[]>;
  };
  readonly goals?: {
    getBySession(sessionId: string): Promise<SessionActivityGoal | undefined>;
  };
  readonly cron?: {
    listDefinitions?: unknown;
    listSessionWakes?(sessionId: string): readonly SessionActivityCronEntry[];
  };
  readonly nowMs?: () => number;
}

interface RuntimeSessionActivitySessions {
  get(sessionId: string): Promise<SessionActivitySession | undefined>;
  listChildren(parentSessionId: string): Promise<readonly SessionActivitySession[]>;
}

/** Runtime owners the activity reader is composed from. */
interface RuntimeSessionActivityOwners {
  readonly sessionSystem: {
    readonly sessions: { readonly repository: RuntimeSessionActivitySessions };
    readonly queue: { readonly committed: SessionActivityApplicationOptions['queue'] };
  };
  readonly owners: {
    /** Optional on the Turn System contract; the activity route stays unmounted without it. */
    readonly turnSystem: { readonly inspection?: SessionActivityApplicationOptions['turns'] };
    readonly cron?: { readonly service: NonNullable<SessionActivityApplicationOptions['cron']> };
  };
  readonly application: Pick<
    LocalRuntimeApplication,
    'backgroundTasks' | 'questionnaires' | 'permissions'
  >;
  readonly goalPort?: SessionActivityApplicationOptions['goals'];
  readonly nowMs: () => number;
}

/** The `RuntimeServices` slice this module contributes. */
export interface SessionActivityServices {
  /** Read-only quiescence snapshot of a session tree for evaluation automation (Vela/Ludus). */
  readonly sessionActivity?: SessionActivityApplication;
}

/** Composes the activity reader from ready runtime owners; empty keeps the route fail-closed. */
export function sessionActivityFor(input: RuntimeSessionActivityOwners): SessionActivityServices {
  const turns = input.owners.turnSystem.inspection;
  if (!turns) return {};
  const sessions = input.sessionSystem.sessions.repository;
  const { backgroundTasks, questionnaires, permissions } = input.application;
  const cron = input.owners.cron?.service;
  return {
    sessionActivity: new SessionActivityApplication({
      sessions,
      turns,
      queue: input.sessionSystem.queue.committed,
      ...(backgroundTasks ? { backgroundTasks } : {}),
      ...(questionnaires ? { questionnaires } : {}),
      ...(permissions ? { permissions } : {}),
      ...(input.goalPort ? { goals: input.goalPort } : {}),
      ...(cron ? { cron } : {}),
      nowMs: input.nowMs,
    }),
  };
}

/**
 * Answers "can this session tree still advance without new user input?".
 *
 * Covers every producer that admits a Turn after the user's own Turn ends: the active or
 * admitting Turn, auto-draining Queue items, background Tasks and their pending owner
 * notifications (Task completion steers a delivery Turn into the owner), Thread Goal
 * continuations and admitted Cron Runs. It walks descendant sessions because subagent and
 * verifier children run their own Turns. Team plans are not read: the desktop toolset has
 * no `team` tool, so no desktop session is ever owned by one, and `SessionActivityKind.TeamPlan`
 * stays an IDL value this reader never emits.
 *
 * Scoped to evaluation automation (Vela/Ludus) that needs to know a session is truly
 * finished — this is not a general "what is the session doing" API. New use cases
 * building on it should re-review the semantics first: kind coverage, the descendant
 * traversal bound, and the non-transactional read.
 */
export class SessionActivityApplication {
  private readonly nowMs: () => number;

  constructor(private readonly options: SessionActivityApplicationOptions) {
    this.nowMs = options.nowMs ?? Date.now;
  }

  async getSessionActivity(
    _ctx: ApplicationContext,
    req: GetSessionActivityReq,
  ): Promise<GetSessionActivityResp> {
    const rootId = req.id.trim();
    if (!rootId) throw new AppError(400, 'INVALID_SESSION_ID', 'Session id is required.');
    const root = await this.options.sessions.get(rootId);
    if (!root) throw new AppError(404, 'SESSION_NOT_FOUND', `Session not found: ${rootId}`);

    const checkedAtMs = this.nowMs();
    const pendingPermissions = (await this.options.permissions?.listPending()) ?? [];
    let { sessions, marks, truncated } = await this.collectTree(root);
    let inspected = await Promise.all(
      sessions.map((session) => this.inspectSession(session, marks, pendingPermissions)),
    );
    // A Turn that started or ended between the producer reads and the Turn read may have
    // started background work (or a child session) those reads missed. Re-walk once from
    // fresh producer facts so the work shows up instead of the tree reading as Idle.
    if (inspected.some((result) => result.turnChangedDuringRead)) {
      ({ sessions, marks, truncated } = await this.collectTree(root));
      inspected = await Promise.all(
        sessions.map((session) => this.inspectSession(session, marks, pendingPermissions)),
      );
    }
    const items = inspected.flatMap((result) => result.items);
    // A full Task page cannot prove the rest of the session's Tasks are quiet; say so in
    // `truncated`, like a tree that outgrew the session bound. (taskItems already reports the
    // unread remainder as a running TaskNotification, so `state` is not Idle either.)
    truncated ||= inspected.some((result) => result.tasksTruncated);
    const childSessionOfTask = new Map(
      inspected.flatMap((result) => [...result.childSessionOfTask]),
    );
    // Turns still changing on the re-walk: the session is doing work right now and this
    // snapshot cannot prove anything about what it left behind. Say Running and let the
    // next poll decide rather than publish an Idle the reads did not see.
    const unstable = inspected.some((result) => result.turnChangedDuringRead);
    const state = unstable
      ? SessionActivityState.Running
      : activityState(items, childSessionOfTask);
    return {
      state,
      items,
      sessionCount: sessions.length,
      truncated,
      checkedAtMs,
    };
  }

  /**
   * BFS over the session tree. Each session's Turn mark is taken before its children are
   * listed, so a Turn that creates a child and ends while this walk runs changes the mark
   * and the caller walks again; a child created in that gap is not silently missed.
   */
  private async collectTree(root: SessionActivitySession): Promise<{
    readonly sessions: readonly SessionActivitySession[];
    /** Turn mark per session, read before that session's children were listed. */
    readonly marks: ReadonlyMap<string, string>;
    readonly truncated: boolean;
  }> {
    const seen = new Set<string>([root.sessionId]);
    const order = [root];
    const marks = new Map<string, string>();
    for (const parent of order) {
      marks.set(parent.sessionId, await this.turnMark(parent.sessionId));
      const children = await this.options.sessions.listChildren(parent.sessionId);
      for (const child of children) {
        if (seen.has(child.sessionId)) continue;
        if (order.length >= SESSION_ACTIVITY_MAX_SESSIONS) {
          return { sessions: order, marks, truncated: true };
        }
        seen.add(child.sessionId);
        order.push(child);
      }
    }
    return { sessions: order, marks, truncated: false };
  }

  private async inspectSession(
    session: SessionActivitySession,
    marks: ReadonlyMap<string, string>,
    pendingPermissions: readonly { readonly requestId: string; readonly sessionId: string }[],
  ): Promise<{
    readonly items: SessionActivityItem[];
    readonly turnChangedDuringRead: boolean;
    /** Running subagent Tasks and what each one is tied to. */
    readonly childSessionOfTask: ReadonlyMap<string, SubagentTaskLink>;
    /** A Task page came back full: rows beyond it were not read. */
    readonly tasksTruncated: boolean;
  }> {
    const { sessionId } = session;
    const before = marks.get(sessionId) ?? (await this.turnMark(sessionId));
    // Read what can admit a Turn before the Turn itself: a hand-off (Task delivery, Queue
    // drain, Cron delivery) that lands between the reads then shows up as the new Turn
    // instead of vanishing from both sides.
    const cronWakes = this.options.cron?.listSessionWakes?.(sessionId) ?? [];
    const [queue, tasks, notifications, goal, questionnaire] = await Promise.all([
      this.options.queue.snapshot(sessionId),
      this.listTasks(sessionId, ACTIVE_TASK_STATUSES, false),
      // Child workers (subagent, verifier) never get a delivery Turn (the
      // scheduler skips them); their finished Tasks are read through task_output by a
      // running child Turn, if at all.
      isTaskSession(session)
        ? []
        : this.listTasks(sessionId, TERMINAL_TASK_STATUSES, true),
      this.options.goals?.getBySession(sessionId),
      this.options.questionnaires?.getPending({ agentName: session.agentName, sessionId }),
    ]);
    const turn = await this.options.turns.activeTurn(sessionId);
    const after = await this.turnMark(sessionId);
    // Any Turn that started or ended inside the window may have done work the producer
    // reads missed; the caller re-walks once from fresh facts.
    const turnChangedDuringRead = before !== after;
    const items = sessionItems(sessionId, {
      turn,
      queue,
      tasks,
      notifications,
      goal,
      cronWakes,
      questionnaire,
      permissions: pendingPermissions.filter((request) => request.sessionId === sessionId),
    });
    return {
      items,
      turnChangedDuringRead,
      childSessionOfTask: childSessionsOf(tasks),
      tasksTruncated: tasks.length >= TASK_PAGE_LIMIT || notifications.length >= TASK_PAGE_LIMIT,
    };
  }

  /**
   * A string identifying the session's Turn state: latest accepted Turn plus whether it is
   * done, or (when the inspection cannot say) the active Turn alone.
   */
  private async turnMark(sessionId: string): Promise<string> {
    const latest = await this.options.turns.latestTurnActivity?.(sessionId);
    if (latest) return `${latest.turnId}:${latest.completedAtMs ?? 'running'}`;
    const active = await this.options.turns.activeTurn(sessionId);
    return active ? `${active.turnId}:running` : '';
  }

  private async listTasks(
    sessionId: string,
    statuses: readonly LocalRuntimeBackgroundTaskStatus[],
    terminal: boolean,
  ): Promise<readonly LocalRuntimeBackgroundTaskView[]> {
    const tasks = this.options.backgroundTasks;
    if (!tasks) return [];
    const rows = await tasks.list({
      ownerSessionId: sessionId,
      statuses,
      limit: TASK_PAGE_LIMIT,
      ...(terminal
        ? { undeliveredOnly: true, excludeDeliveryDeferred: true, includeNotification: true }
        : {}),
    });
    // A managed foreground Bash is still owned by the active Turn, which is reported separately.
    return terminal
      ? rows
      : rows.filter(
          (task) =>
            !(task.kind === 'bash' && task.metadata?.executionMode === 'managed_foreground'),
        );
  }
}

/** The facts `inspectSession` reads for one session, in the order it reads them. */
interface SessionFacts {
  readonly turn: { readonly turnId: string; readonly busyReason: string } | undefined;
  readonly queue: Parameters<typeof queueItems>[1];
  readonly tasks: readonly LocalRuntimeBackgroundTaskView[];
  readonly notifications: readonly LocalRuntimeBackgroundTaskView[];
  readonly goal: SessionActivityGoal | undefined;
  readonly cronWakes: readonly SessionActivityCronEntry[];
  readonly questionnaire: { readonly id: string; readonly mode?: string } | undefined;
  readonly permissions: readonly { readonly requestId: string }[];
}

function sessionItems(sessionId: string, facts: SessionFacts): SessionActivityItem[] {
  const items: SessionActivityItem[] = [];
  if (facts.turn) {
    items.push({
      kind: SessionActivityKind.Turn,
      sessionId,
      refId: facts.turn.turnId,
      status: facts.turn.busyReason,
    });
  }
  items.push(...queueItems(sessionId, facts.queue));
  items.push(...taskItems(sessionId, facts.tasks, facts.notifications));
  if (facts.goal && CONTINUING_GOAL_STATUSES[facts.goal.status]) {
    items.push({
      kind: SessionActivityKind.ThreadGoal,
      sessionId,
      refId: facts.goal.goalId,
      status: facts.goal.status,
    });
  }
  items.push(...cronItems(sessionId, facts.cronWakes));
  if (facts.questionnaire) {
    items.push({
      kind: SessionActivityKind.Questionnaire,
      sessionId,
      refId: facts.questionnaire.id,
      detail: facts.questionnaire.mode,
    });
  }
  for (const request of facts.permissions) {
    items.push({ kind: SessionActivityKind.Permission, sessionId, refId: request.requestId });
  }
  return items;
}

/** What a running subagent Task ties together: its child session and, in foreground mode, the parent Turn waiting on it. */
interface SubagentTaskLink {
  readonly childSessionId: string;
  /** The session whose Turn owns the task. */
  readonly ownerSessionId: string;
  /** The owner Turn that drives the task synchronously; undefined for background/append runs. */
  readonly waitingTurnId?: string;
}

function childSessionsOf(
  tasks: readonly LocalRuntimeBackgroundTaskView[],
): Map<string, SubagentTaskLink> {
  const links = new Map<string, SubagentTaskLink>();
  for (const task of tasks) {
    const child = task.metadata?.childSessionId;
    if (task.kind !== 'subagent' || typeof child !== 'string') continue;
    const parentTurn = task.metadata?.parentTurnId;
    const foreground =
      task.metadata?.executionMode === 'foreground' && typeof parentTurn === 'string';
    links.set(task.taskId, {
      childSessionId: child,
      ownerSessionId: task.ownerSessionId,
      ...(foreground ? { waitingTurnId: parentTurn } : {}),
    });
  }
  return links;
}

function queueItems(
  sessionId: string,
  queue: {
    readonly pendingCount: number;
    readonly pause?: { cause: string; triggerTurnId: string };
  },
): SessionActivityItem[] {
  if (queue.pendingCount <= 0) return [];
  const detail = String(queue.pendingCount);
  return [
    queue.pause
      ? {
          kind: SessionActivityKind.PausedQueue,
          sessionId,
          refId: queue.pause.triggerTurnId,
          status: queue.pause.cause,
          detail,
        }
      : { kind: SessionActivityKind.QueuedMessages, sessionId, detail },
  ];
}

function taskItems(
  sessionId: string,
  active: readonly LocalRuntimeBackgroundTaskView[],
  terminal: readonly LocalRuntimeBackgroundTaskView[],
): SessionActivityItem[] {
  const toItem = (task: LocalRuntimeBackgroundTaskView, kind: SessionActivityKind) => {
    const mode = task.metadata?.executionMode;
    return {
      kind,
      sessionId,
      refId: task.taskId,
      status: task.status,
      detail: typeof mode === 'string' && mode ? `${task.kind}:${mode}` : task.kind,
      ...(kind === SessionActivityKind.TaskNotification && task.endedAt !== undefined
        ? { atMs: task.endedAt }
        : {}),
    };
  };
  const items: SessionActivityItem[] = [
    ...active.map((task) => toItem(task, SessionActivityKind.BackgroundTask)),
    // Absent notification means the ledger was unreadable; readers treat it as settled.
    ...terminal
      .filter((task) => task.notification?.state === 'pending')
      .map((task) => toItem(task, SessionActivityKind.TaskNotification)),
  ];
  // `undeliveredOnly` keeps settled-but-undelivered rows (bound to a Turn, or suppressed by a
  // user stop), so a full page may hide pending notifications behind settled ones. Report
  // the unread remainder as pending work rather than publish an Idle the read cannot back.
  // Deferred rows (`deliveryDeferred`, a round the user resumed) are left out by the read
  // itself, so however many pile up they never fill the page.
  if (terminal.length >= TASK_PAGE_LIMIT) {
    items.push({
      kind: SessionActivityKind.TaskNotification,
      sessionId,
      refId: TASK_PAGE_FULL_REF,
      status: 'unknown',
      detail: `undelivered terminal tasks exceed the ${TASK_PAGE_LIMIT}-row read`,
    });
  }
  return items;
}

/** Self reminders are agent-set one-shot follow-ups; anything else is a user Cron. */
function cronPurpose(cronId: string): 'self_reminder' | 'cron' {
  return isSelfReminderId(cronId) ? 'self_reminder' : 'cron';
}

function cronItems(
  sessionId: string,
  wakes: readonly SessionActivityCronEntry[],
): SessionActivityItem[] {
  return wakes.map((entry) => {
    const detail = cronPurpose(entry.cronId);
    return entry.kind === 'run'
      ? {
          kind: SessionActivityKind.CronRun,
          sessionId,
          refId: entry.cronId,
          status: 'pending',
          detail,
        }
      : {
          kind: SessionActivityKind.CronSchedule,
          sessionId,
          refId: entry.cronId,
          detail,
          ...(entry.nextRunAtMs !== undefined ? { atMs: entry.nextRunAtMs } : {}),
        };
  });
}

/**
 * Precedence is chosen so a client polling for "nothing left to wait for" never stops early
 * and never waits on work that cannot move:
 * - a pending questionnaire or permission blocks the Turn and Goal continuation of its own
 *   session, so those items count as waiting rather than running;
 * - any other running or self-waking work keeps the tree Running;
 * - a paused Queue only resumes on a user Continue;
 * - future Cron triggers alone are Scheduled.
 */
const STATE_BY_KIND: Record<SessionActivityKind, SessionActivityState> = {
  [SessionActivityKind.Turn]: SessionActivityState.Running,
  [SessionActivityKind.QueuedMessages]: SessionActivityState.Running,
  [SessionActivityKind.BackgroundTask]: SessionActivityState.Running,
  [SessionActivityKind.TaskNotification]: SessionActivityState.Running,
  [SessionActivityKind.ThreadGoal]: SessionActivityState.Running,
  // Never emitted by this reader (see the class comment); kept so the map stays total.
  [SessionActivityKind.TeamPlan]: SessionActivityState.Running,
  [SessionActivityKind.CronRun]: SessionActivityState.Running,
  [SessionActivityKind.Questionnaire]: SessionActivityState.WaitingForUser,
  [SessionActivityKind.Permission]: SessionActivityState.WaitingForUser,
  [SessionActivityKind.PausedQueue]: SessionActivityState.WaitingForUser,
  [SessionActivityKind.CronSchedule]: SessionActivityState.Scheduled,
};

function activityState(
  items: readonly SessionActivityItem[],
  childSessionOfTask: ReadonlyMap<string, SubagentTaskLink>,
): SessionActivityState {
  const blockedSessions = new Set(
    items
      .filter(
        (item) =>
          item.kind === SessionActivityKind.Questionnaire ||
          item.kind === SessionActivityKind.Permission,
      )
      .map((item) => item.sessionId),
  );
  // A foreground subagent run makes its parent Turn wait on the child, so a blocked child
  // blocks the parent session as a whole: its Turn, its Goal and its queue (which cannot
  // drain until that Turn ends). Blocking climbs every foreground link in turn, so a
  // chain of foreground subagents blocks all the way up. Background/append runs leave the
  // parent free.
  const foregroundLinks = [...childSessionOfTask.values()].filter(
    (link) => link.waitingTurnId !== undefined,
  );
  for (let grew = true; grew; ) {
    grew = false;
    for (const link of foregroundLinks) {
      if (blockedSessions.has(link.childSessionId) && !blockedSessions.has(link.ownerSessionId)) {
        blockedSessions.add(link.ownerSessionId);
        grew = true;
      }
    }
  }
  const waitsOnUser = (item: SessionActivityItem): boolean => {
    // A session's own Turn/Goal cannot advance past its pending questionnaire or permission,
    // and its queue cannot drain until that Turn ends.
    if (
      blockedSessions.has(item.sessionId) &&
      (item.kind === SessionActivityKind.Turn ||
        item.kind === SessionActivityKind.ThreadGoal ||
        item.kind === SessionActivityKind.QueuedMessages)
    ) {
      return true;
    }
    // A running subagent Task is only as live as the child session it runs in.
    if (item.kind === SessionActivityKind.BackgroundTask && item.refId !== undefined) {
      const link = childSessionOfTask.get(item.refId);
      return link !== undefined && blockedSessions.has(link.childSessionId);
    }
    return false;
  };
  const states = items.map((item) =>
    waitsOnUser(item) ? SessionActivityState.WaitingForUser : STATE_BY_KIND[item.kind],
  );
  for (const state of [
    SessionActivityState.Running,
    SessionActivityState.WaitingForUser,
    SessionActivityState.Scheduled,
  ]) {
    if (states.includes(state)) return state;
  }
  return SessionActivityState.Idle;
}
