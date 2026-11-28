/** Persisted in wrap_up ToolResult.details; no additional transport is required. */
export const NEXT_STEP_APP_ACTIONS = [
  'commit',
  'review_changes',
  'new_session',
  'archive_session',
] as const;
export type NextStepAppAction = (typeof NEXT_STEP_APP_ACTIONS)[number];
/** Card limits, counted in code points. Producers, readers and stored answers share them. */
/** The question length the model is asked to keep to. */
export const NEXT_STEP_ASK_TARGET = 50;
/**
 * The longest question a card shows. The question often lives only on the card, so one over
 * the target is shown as written rather than dropped; past this it is not one question.
 */
export const NEXT_STEP_ASK_MAX = 200;
/** A longer recap is dropped, not retried; older history may hold up to 150. */
export const NEXT_STEP_RECAP_MAX = 96;
export const NEXT_STEP_MAX_ACTIONS = 4;
export const NEXT_STEP_LABEL_MIN = 2;
export const NEXT_STEP_LABEL_MAX = 40;
/** A reply label is sent verbatim as the user's message. */
export type NextStepAction =
  | { kind: 'reply'; label: string; recommended?: boolean }
  | { kind: 'app_action'; action: NextStepAppAction; payload?: string; recommended?: boolean };
export interface NextStepCardData {
  kind: 'wrap_up';
  schema_version: 1;
  /** Absent when the model's recap was too long to show; the card then has a question. */
  recap?: string;
  ask?: string;
  actions?: NextStepAction[];
  selectionMode?: 'single' | 'multiple';
  allowOther?: boolean;
  blocked: boolean;
  waiting_for_user: boolean;
  turn_id: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Shared validation for live events and recovered history. Returns a
 * normalized card: retired fields of older history are read without error and
 * left out of the result.
 */
export function readNextStepCard(rawResult: unknown): NextStepCardData | undefined {
  let result = rawResult;
  if (typeof result === 'string') {
    try {
      result = JSON.parse(result);
    } catch {
      return undefined;
    }
  }
  if (!record(result) || result.isError === true) return undefined;
  const data = result.details;
  if (
    !record(data) ||
    data.kind !== 'wrap_up' ||
    data.schema_version !== 1 ||
    data.suppressed === true
  )
    return undefined;
  if (
    (data.recap !== undefined &&
      (typeof data.recap !== 'string' || !data.recap.trim() || [...data.recap].length > 150)) ||
    typeof data.turn_id !== 'string' ||
    !data.turn_id
  )
    return undefined;
  if (typeof data.blocked !== 'boolean' || typeof data.waiting_for_user !== 'boolean')
    return undefined;
  if (
    data.ask !== undefined &&
    (typeof data.ask !== 'string' || !data.ask.trim() || [...data.ask].length > NEXT_STEP_ASK_MAX)
  )
    return undefined;
  if (
    data.actions !== undefined &&
    (!Array.isArray(data.actions) || data.actions.length > NEXT_STEP_MAX_ACTIONS)
  )
    return undefined;
  if (data.waiting_for_user !== data.blocked) return undefined;
  const recapOnly = {
    kind: 'wrap_up',
    schema_version: 1,
    ...(typeof data.recap === 'string' ? { recap: data.recap } : {}),
    turn_id: data.turn_id,
  } as const;
  // Retired checklist (items) and multi-question (questions) cards stay readable
  // as their recap, without restoring a decision or a waiting state.
  if (data.items !== undefined || data.questions !== undefined)
    return typeof data.recap === 'string'
      ? { ...recapOnly, blocked: false, waiting_for_user: false }
      : undefined;
  // A card shows its recap, its question or both; with neither there is nothing to show.
  if (typeof data.recap !== 'string' && typeof data.ask !== 'string') return undefined;
  if (
    (Array.isArray(data.actions) && data.actions.length > 0 && !data.ask) ||
    (data.blocked && !data.ask)
  )
    return undefined;
  if (!validSelection(data)) return undefined;
  return {
    ...recapOnly,
    ...(typeof data.ask === 'string' ? { ask: data.ask } : {}),
    // An answer this version cannot read goes alone: the recap and question stay readable.
    ...(Array.isArray(data.actions)
      ? { actions: data.actions.filter(isNextStepAction).map(normalizeNextStepAction) }
      : {}),
    ...(data.selectionMode === 'single' || data.selectionMode === 'multiple'
      ? { selectionMode: data.selectionMode }
      : {}),
    ...(typeof data.allowOther === 'boolean' ? { allowOther: data.allowOther } : {}),
    blocked: data.blocked,
    waiting_for_user: data.waiting_for_user,
  };
}

/** Older reply actions may carry a `message`; only the label is sent now, so it is dropped. */
function normalizeNextStepAction(action: NextStepAction): NextStepAction {
  const recommended = action.recommended !== undefined ? { recommended: action.recommended } : {};
  if (action.kind === 'reply') return { kind: 'reply', label: action.label, ...recommended };
  return {
    kind: 'app_action',
    action: action.action,
    ...(action.payload !== undefined ? { payload: action.payload } : {}),
    ...recommended,
  };
}

function validSelection(value: Record<string, unknown>): boolean {
  return (
    (value.selectionMode === undefined ||
      value.selectionMode === 'single' ||
      value.selectionMode === 'multiple') &&
    (value.allowOther === undefined || typeof value.allowOther === 'boolean') &&
    !breaksAppActionLimits(value)
  );
}

/**
 * A card with an App action stays a single choice of at most two buttons with no free answer.
 * Shared by the producer (a correction for the model) and the reader (an invalid card).
 */
export function breaksAppActionLimits(card: {
  readonly actions?: unknown;
  readonly selectionMode?: unknown;
  readonly allowOther?: unknown;
}): boolean {
  return (
    Array.isArray(card.actions) &&
    card.actions.some((action) => record(action) && action.kind === 'app_action') &&
    (card.selectionMode === 'multiple' || card.allowOther === true || card.actions.length > 2)
  );
}

export function isNextStepAction(value: unknown): value is NextStepAction {
  if (!record(value) || (value.recommended !== undefined && typeof value.recommended !== 'boolean'))
    return false;
  if (value.kind === 'reply')
    return (
      typeof value.label === 'string' &&
      Boolean(value.label.trim()) &&
      [...value.label].length >= NEXT_STEP_LABEL_MIN &&
      [...value.label].length <= NEXT_STEP_LABEL_MAX
    );
  return (
    value.kind === 'app_action' &&
    NEXT_STEP_APP_ACTIONS.includes(value.action as NextStepAppAction) &&
    (value.payload === undefined ||
      (typeof value.payload === 'string' && [...value.payload].length <= 500))
  );
}

export function trimNextStepActions<T extends { actions?: NextStepAction[] }>(
  card: T,
  available: readonly NextStepAppAction[],
): T {
  if (!card.actions) return card;
  // The question often lives only in the card, so keep it and drop just the unavailable
  // App actions; with no answer left the user replies in the composer.
  const actions = card.actions.filter(
    (action) => action.kind !== 'app_action' || available.includes(action.action),
  );
  if (actions.length === card.actions.length) return card;
  return { ...card, actions: actions.length ? actions : undefined };
}
