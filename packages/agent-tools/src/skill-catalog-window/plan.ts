import {
  createDefaultTokenEstimator,
  renderLocalSkillsCatalogResult,
  resolveSkillCatalogBudgetTokens,
  type LocalSkillCatalogTokenEstimator,
  type LocalSkillsCatalogEntry,
  type LocalSkillsCatalogRenderResult,
  type SkillCatalogUsageMap,
} from '@mavis/context-manager';
import {
  skillAvailability,
  skillDeviation,
  skillSnapshot,
  type SkillAvailability,
  type SkillDeviations,
  type SkillSnapshot,
} from './deviation.js';
import { renderSkillAvailabilityNotice } from './notice.js';
import {
  commitSkillCatalogTurn,
  noteSkillCatalogNoticeInHistory,
  peekSkillCatalogSessionState,
  skillCatalogSessionState,
  skillToldState,
  type FrozenSkillCatalog,
  type SkillCatalogSessionState,
  type TurnSkillView,
} from './state.js';

export interface SkillCatalogWindowPlanInput {
  readonly sessionId: string;
  /** The live, already filtered Skills the catalog would show. */
  readonly entries: readonly LocalSkillsCatalogEntry[];
  readonly contextWindowTokens?: number;
  /** Hash of the system-prompt text before the catalog; constant for coordinator Sessions. */
  readonly upstreamFingerprint: string;
  /** Called only when a window starts or resyncs (or a read-only call finds none). */
  readonly readUsage: (
    entries: readonly LocalSkillsCatalogEntry[],
  ) => SkillCatalogUsageMap | Promise<SkillCatalogUsageMap>;
  /**
   * False: read-only (manual compaction, advisor, title, goal verifier...): reuse
   * the frozen catalog if any and never change the Session's state.
   */
  readonly commit: boolean;
  /**
   * False: shadow mode. The catalog is a fresh render every Turn and there is no
   * update, but the outcome is still computed against a shadow window.
   */
  readonly freeze: boolean;
  readonly nowMs: number;
  readonly tokenEstimator?: LocalSkillCatalogTokenEstimator;
  /**
   * Whether this is the Session's first Turn; the host knows it. A window start
   * on a later Turn had state to recover (process restart, eviction), which is
   * `no-state`, not `first`. Absent: the state alone decides.
   */
  readonly firstTurn?: boolean;
  /**
   * Whether the Session's stored history carries a skill-availability update.
   * Checked once per Session (and again after a rewind) before this process told
   * anything: an update left by an earlier process, or copied into a side chat or
   * fork, is then superseded by this very Turn instead of the next one.
   */
  readonly historyHasNotice?: () => boolean;
}

export interface SkillCatalogWindowOutcome {
  readonly event: 'started' | 'continued' | 'resynced';
  readonly reason?:
    | 'first'
    | 'compaction'
    | 'context-window'
    | 'upstream-changed'
    | 'no-state'
    | 'error';
  /** Deviation from the frozen catalog (0 when a window starts). */
  readonly added: number;
  readonly removed: number;
  readonly changed: number;
  /**
   * How the live Skills changed since the Session's previous committed Turn on a
   * continued window: each nonzero count is a catalog change the freeze kept out
   * of the prompt prefix (in shadow mode, one it would have kept out). Zero when a
   * window starts or resyncs (the prefix changes then anyway) and on read-only plans.
   */
  readonly sinceLastTurn: {
    readonly added: number;
    readonly removed: number;
    readonly changed: number;
  };
  readonly shadow: boolean;
}

export interface SkillCatalogWindowPlan {
  /** Text for the system prompt: the frozen catalog, or a fresh render. */
  readonly catalog: string;
  /** The `<system-reminder>` skill-availability update to append to the current user message; absent when nothing new is due. */
  readonly notice?: string;
  /** Render result of `catalog`. */
  readonly render: LocalSkillsCatalogRenderResult;
  readonly outcome: SkillCatalogWindowOutcome;
}

type RestartReason = NonNullable<SkillCatalogWindowOutcome['reason']>;

/** Metric label of each window start or resync reason, as both runtimes report it. */
export const SKILL_CATALOG_WINDOW_REASON_LABELS = {
  first: 'first',
  compaction: 'compaction',
  'context-window': 'context_window',
  'upstream-changed': 'upstream_changed',
  'no-state': 'no_state',
  error: 'error',
} as const satisfies Record<RestartReason, string>;

export type SkillCatalogWindowReasonLabel =
  (typeof SKILL_CATALOG_WINDOW_REASON_LABELS)[RestartReason];

const DEFAULT_TOKEN_ESTIMATOR = createDefaultTokenEstimator();
const NO_DEVIATION: SkillDeviations = new Map();
const NO_ADDED: ReadonlyMap<string, string> = new Map();

/**
 * The catalog a Turn's system prompt carries and the update its user message
 * appends. A window starts on the Session's first Turn, after a compaction, or
 * when the context window or the prompt before the catalog changed (the prefix
 * cache is lost then anyway); otherwise the Turn repeats the frozen catalog and
 * states the complete deviation in a skill-availability update when it differs
 * from what the model was last told. Usage is read only when a window starts.
 */
export async function planSkillCatalogWindow(
  input: SkillCatalogWindowPlanInput,
): Promise<SkillCatalogWindowPlan> {
  const live = skillSnapshot(input.entries);
  if (!input.commit) return planReadOnly(input, live);

  const state = skillCatalogSessionState(input.sessionId);
  if (input.historyHasNotice)
    noteSkillCatalogNoticeInHistory(input.sessionId, input.historyHasNotice);
  const turnChange = { previous: state.turn?.live, live };
  const current = state.window;
  let reason: RestartReason | undefined;
  if (!current) reason = startReason(state, input.firstTurn);
  // The prompt showed fresh renders, not this window's catalog.
  else if (input.freeze && state.turn?.shadow) reason = 'no-state';
  // Only the budget the window derives from it shapes the catalog.
  else if (
    resolveSkillCatalogBudgetTokens(current.contextWindowTokens) !==
    resolveSkillCatalogBudgetTokens(input.contextWindowTokens)
  ) {
    reason = 'context-window';
  } else if (current.upstreamFingerprint !== input.upstreamFingerprint) reason = 'upstream-changed';
  // Turning the freeze off (the rollback switch) shows the live catalog from now
  // on, but the newest update may still say a Skill is unavailable: one all-clear
  // update supersedes it, then shadow Turns send none.
  const leavingFreeze = !input.freeze && state.turn !== undefined && !state.turn.shadow;

  let continued:
    | {
        deviation: SkillDeviations;
        /** What the update states against the catalog the prompt shows. */
        noticeDeviation: SkillDeviations;
        render: LocalSkillsCatalogRenderResult;
        view: TurnSkillView;
        notice?: string;
      }
    | undefined;
  if (current && !reason) {
    try {
      const deviation = skillDeviation(current.entries, live, state.addedInWindow);
      const availability = input.freeze
        ? skillAvailability(skillToldState(state), deviation, live, state.changedInWindow)
        : leavingFreeze
          ? skillAvailability(skillToldState(state), NO_DEVIATION, live)
          : undefined;
      const render = input.freeze ? current.render : freshRender(input, current);
      continued = {
        deviation,
        noticeDeviation: input.freeze ? deviation : NO_DEVIATION,
        render,
        view: viewOf(input, live, render, current),
        ...noticeFor(input, availability),
      };
    } catch {
      reason = 'error';
    }
  }

  if (continued) {
    commitSkillCatalogTurn(state, {
      window: undefined,
      notice: continued.notice
        ? { text: continued.notice, deviation: continued.noticeDeviation }
        : undefined,
      view: continued.view,
    });
    return {
      catalog: continued.render.catalog,
      ...(continued.notice ? { notice: continued.notice } : {}),
      render: continued.render,
      outcome: outcomeOf('continued', undefined, continued.deviation, input, turnChange),
    };
  }

  const window = await startWindow(input, live);
  // A new window shows every Skill as it is; an update still supersedes earlier ones.
  const notice =
    input.freeze || leavingFreeze
      ? noticeFor(input, skillAvailability(skillToldState(state), NO_DEVIATION, live)).notice
      : undefined;
  commitSkillCatalogTurn(state, {
    window,
    notice: notice ? { text: notice, deviation: NO_DEVIATION } : undefined,
    view: viewOf(input, live, window.render, window),
  });
  const restart = reason ?? 'error';
  return {
    catalog: window.render.catalog,
    ...(notice ? { notice } : {}),
    render: window.render,
    outcome: outcomeOf(
      restart === 'first' || restart === 'compaction' || restart === 'no-state'
        ? 'started'
        : 'resynced',
      restart,
      NO_DEVIATION,
      input,
      undefined,
    ),
  };
}

/** A read-only build: the frozen catalog (fresh in shadow mode), never an update or a state change. */
async function planReadOnly(
  input: SkillCatalogWindowPlanInput,
  live: SkillSnapshot,
): Promise<SkillCatalogWindowPlan> {
  const state = peekSkillCatalogSessionState(input.sessionId);
  if (state?.window) {
    const current = state.window;
    const render = input.freeze ? current.render : freshRender(input, current);
    const deviation = skillDeviation(current.entries, live, state.addedInWindow);
    return {
      catalog: render.catalog,
      render,
      outcome: outcomeOf('continued', undefined, deviation, input, undefined),
    };
  }
  const { render } = await startWindow(input, live);
  return {
    catalog: render.catalog,
    render,
    outcome: outcomeOf(
      'started',
      startReason(state, input.firstTurn),
      NO_DEVIATION,
      input,
      undefined,
    ),
  };
}

/** Why a Session without a window in effect starts one. */
function startReason(
  state: Readonly<SkillCatalogSessionState> | undefined,
  firstTurn: boolean | undefined,
): RestartReason {
  if (state?.endedByCompaction) return 'compaction';
  if (state?.everEffective) return 'no-state';
  // A later Turn whose Session had a window no process remembers: restart or eviction.
  return firstTurn === false ? 'no-state' : 'first';
}

async function startWindow(
  input: SkillCatalogWindowPlanInput,
  live: SkillSnapshot,
): Promise<FrozenSkillCatalog> {
  let usage: SkillCatalogUsageMap = new Map();
  try {
    usage = await input.readUsage(input.entries);
  } catch {
    // Without usage (and so without first sight), descriptions keep by tier and name.
  }
  const render = renderLocalSkillsCatalogResult(input.entries, {
    ...(input.contextWindowTokens !== undefined
      ? { contextWindowTokens: input.contextWindowTokens }
      : {}),
    ...(input.tokenEstimator ? { tokenEstimator: input.tokenEstimator } : {}),
    usage,
    nowMs: input.nowMs,
  });
  return {
    entries: live,
    usage,
    render,
    listing: listingOf(render, live),
    contextWindowTokens: input.contextWindowTokens,
    upstreamFingerprint: input.upstreamFingerprint,
    startedAtMs: input.nowMs,
  };
}

/** Shadow mode's catalog: the live Skills, ranked by the window's usage as of its start. */
function freshRender(
  input: SkillCatalogWindowPlanInput,
  window: FrozenSkillCatalog,
): LocalSkillsCatalogRenderResult {
  return renderLocalSkillsCatalogResult(input.entries, {
    ...(input.contextWindowTokens !== undefined
      ? { contextWindowTokens: input.contextWindowTokens }
      : {}),
    ...(input.tokenEstimator ? { tokenEstimator: input.tokenEstimator } : {}),
    usage: window.usage,
    nowMs: window.startedAtMs,
  });
}

function noticeFor(
  input: SkillCatalogWindowPlanInput,
  availability: SkillAvailability | undefined,
): { notice?: string } {
  if (!availability) return {};
  return {
    notice: renderSkillAvailabilityNotice(availability, {
      budgetTokens: resolveSkillCatalogBudgetTokens(input.contextWindowTokens),
      estimator: input.tokenEstimator ?? DEFAULT_TOKEN_ESTIMATOR,
    }),
  };
}

/** How the catalog lists each Skill: a name-only line, or one with its description. */
function listingOf(
  render: LocalSkillsCatalogRenderResult,
  live: SkillSnapshot,
): ReadonlyMap<string, 'described' | 'name_only'> {
  return new Map(
    [...live].map(([key, { entry }]) => [
      key,
      render.nameOnly.has(entry.name) ? 'name_only' : 'described',
    ]),
  );
}

/** What the Turn's prompt shows: the frozen listing, or in shadow mode the fresh render's. */
function viewOf(
  input: SkillCatalogWindowPlanInput,
  live: SkillSnapshot,
  render: LocalSkillsCatalogRenderResult,
  window: FrozenSkillCatalog,
): TurnSkillView {
  return {
    listing: render === window.render ? window.listing : listingOf(render, live),
    live,
    shadow: !input.freeze,
  };
}

function outcomeOf(
  event: SkillCatalogWindowOutcome['event'],
  reason: RestartReason | undefined,
  deviation: SkillDeviations,
  input: Pick<SkillCatalogWindowPlanInput, 'freeze'>,
  turnChange:
    | { readonly previous: SkillSnapshot | undefined; readonly live: SkillSnapshot }
    | undefined,
): SkillCatalogWindowOutcome {
  const counts = (of: SkillDeviations) => {
    const count = (status: string) =>
      [...of.values()].filter((entry) => entry.status === status).length;
    return { added: count('added'), removed: count('removed'), changed: count('changed') };
  };
  const sinceLastTurn = turnChange?.previous
    ? counts(skillDeviation(turnChange.previous, turnChange.live, NO_ADDED))
    : { added: 0, removed: 0, changed: 0 };
  return {
    event,
    ...(reason ? { reason } : {}),
    ...counts(deviation),
    sinceLastTurn,
    shadow: !input.freeze,
  };
}
