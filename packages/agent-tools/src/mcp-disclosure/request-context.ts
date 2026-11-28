import type {
  PiAfterLlmCallHook,
  PiBeforeLlmCallHook,
  PiBeforeLlmCallHookInput,
  PiTurnRunnerLogger,
} from '@mavis/agent-core/pi-turn-runner';
import type { RuntimeTool } from '@mavis/agent-core/tools';
import { renderCarriedToolDefinitions, renderDeferredToolCatalog } from './catalog.js';
import {
  compactionSummaryKey as summaryKey,
  compactionSummaryTimestamp as summaryTimestamp,
  findLastCompactionSummary,
} from './compaction-summary.js';
import {
  confirmToolSearchAnnouncement,
  forgetAllToolSearchSessionStates,
  forgetToolSearchSessionState,
  noteCompaction,
  noteToolSearchNoticeInHistory,
  pendingToolSearchNotice,
  plannedToolSearchWindow,
  receiveToolSearchResponse,
  type PlannedToolSearchWindow,
  toolSearchSessionState,
  toolSearchTurnWindow,
} from './session-state.js';
import { readToolSearchTurnFacts } from './turn-facts.js';
import { isAnsweredResponse, isNewestNotice, requestUserText } from './window-notice.js';

type RequestMessage = PiBeforeLlmCallHookInput['messages'][number];

/**
 * One Session's Tool Search request context: the latest Turn's insertion and
 * the markers its latest main request actually sent.
 */
interface SessionRequestContext {
  readonly project: (messages: readonly RequestMessage[]) => readonly RequestMessage[];
  /**
   * Outlives the Turn that sent it: a later Turn that compacts on its first
   * request repeats the request that wrote the prompt cache, admission
   * outcome included, while the compaction generation is the same. `dropped`
   * holds the texts of the markers a request of the generation could not fit
   * under `capacity`.
   */
  sent: SentMarkers | undefined;
  /** Insertions already logged in `generation`, across the Session's Turns. */
  logged: { readonly generation: string; readonly keys: Set<string> } | undefined;
}

interface SentMarkers {
  readonly generation: string;
  readonly markers: readonly RequestMessage[];
  readonly dropped: ReadonlySet<string>;
  /** What `dropped` was measured against (`requestCapacity`). */
  readonly capacity: string;
}

type CanAppend = (input: PiBeforeLlmCallHookInput, marker: RequestMessage) => boolean;

/** @internal Exported for focused tests. */
export const TOOL_SEARCH_CONTEXT_REASON = 'tool-search-context';

/**
 * The request context of each Session's latest Turn, repeated by a host's
 * shared-prefix compaction request (`projectToolSearchContext`; local only
 * today) and dropped with the Session (`disposeToolSearchSession`).
 * Process-local like the session state: a restarted process repeats nothing
 * until the next Turn.
 */
const MAX_SESSIONS = 512;
const sessionContexts = new Map<string, SessionRequestContext>();

/**
 * Puts Tool Search context into every provider request without touching
 * durable history or the tool list:
 * - the deferred-tool catalog (`catalog`), so the model knows exact names;
 * - after a compaction, the definitions of tools discovered before it
 *   (`carryAcrossCompaction`), so they stay callable without a new search;
 * - after a compaction, the Turn's tool-availability notice
 *   (`ToolSearchTurnFacts.availabilityNotice`) when the newest notice among the
 *   request's user messages is no longer that one: the Turn keeps declaring
 *   what the notice explains until it ends.
 *
 * All are request-only copies inserted right after the latest compaction
 * summary (the catalog, without one, at the start of the history), in that
 * order. Their text depends only on the prefix window's frozen catalog
 * (`ToolSearchTurnFacts.catalogEntries`), the compaction generation and the
 * Turn, so the request prefix is identical between compactions and the prompt
 * cache keeps hitting. A marker `canAppend` rejects once stays out until the
 * next compaction, in this Turn and later ones, while the request capacity
 * (model and limits) stays the same: near the limit the provider's count of
 * the previous request includes it, so admitting it again would make the
 * prefix alternate, a full cache miss each time. A capacity change sizes the
 * markers again: a larger limit may fit what a smaller one could not.
 *
 * The hook also makes this Turn's insertion the Session's current one, which a
 * host's shared-prefix compaction request repeats through
 * `projectToolSearchContext`. A Turn that inserts nothing (no facts, nothing
 * deferred, catalog and carry off) still records that its requests sent no
 * markers, so the next Turn's checkpoint does not add what those requests
 * never had. Shared by the local and the cloud runtime; both register it after
 * their compaction hook, so it sees the replaced history.
 *
 * Every request also confirms the Turn's pending tool-availability notice once it
 * is the newest notice among the user messages after the request's last
 * assistant message (see `commitToolSearchWindow`), notes a notice of an earlier
 * process in a Session's first request history, then reports the latest
 * compaction to the session state, which ends the prefix window (see
 * `toolSearchTurnWiring`); a Turn that inserts nothing reports the compaction
 * only while it has a window or a pending notice. All of this reads the request
 * as the runner hands it to the hook, durable history that never holds a
 * request-only copy, before this hook inserts one: a copy confirms nothing and
 * counts as no notice of an earlier process. The window the Turn planned takes
 * effect at the response (`createToolSearchResponseHook`), which hosts register
 * next to this hook.
 */
export function createToolSearchContextHook(input: {
  /** The Turn's assembled tools; the facts ride on its `tool_search`. */
  readonly tools: readonly RuntimeTool[] | undefined;
  readonly sessionId: string;
  readonly logger?: Pick<PiTurnRunnerLogger, 'info' | 'warn'> | undefined;
  readonly canAppend?: CanAppend | undefined;
}): PiBeforeLlmCallHook {
  const { sessionId, logger, canAppend } = input;
  const previous = sessionContexts.get(sessionId);
  sessionContexts.delete(sessionId);
  const facts = readToolSearchTurnFacts(input.tools);
  const planned = plannedToolSearchWindow(sessionId);
  // A notice without a window: Tool Search turned off withdraws the earlier ones.
  const watched = Boolean(toolSearchTurnWindow(sessionId) || pendingToolSearchNotice(sessionId));
  const catalogEntries = facts ? (facts.catalogEntries ?? facts.deferredEntries) : [];
  const catalog =
    facts?.catalog && catalogEntries.length > 0
      ? renderDeferredToolCatalog(catalogEntries, facts.catalog)
      : undefined;
  const notice = facts?.availabilityNotice;
  if (
    !facts ||
    (!notice &&
      ((catalogEntries.length === 0 && facts.deferredEntries.length === 0) ||
        (!catalog && !facts.carryAcrossCompaction)))
  )
    return insertNothing(sessionId, previous, watched, planned);
  // Carried definitions prefer the current ones: a deferred tool whose definition
  // changed within the window ended by the compaction is carried as it is now.
  const definitions = new Map(
    [...catalogEntries, ...facts.deferredEntries].map((entry) => [entry.tool.def.name, entry]),
  );
  const logOnce = (
    generation: string,
    key: string,
    fields: Readonly<Record<string, unknown>>,
    message: string,
  ) => {
    if (context.logged?.generation !== generation) context.logged = { generation, keys: new Set() };
    if (context.logged.keys.has(key)) return;
    context.logged.keys.add(key);
    try {
      logger?.info?.({ session_id: sessionId, ...fields }, message);
    } catch {
      // Diagnostics must not affect the request.
    }
  };

  // Definitions of tools discovered before the latest compaction, newest first, as this
  // Turn defines them. The request hook has already noted that compaction, which
  // refreshed the carried set. Rendered once per compaction of the Turn, so its
  // requests repeat the text; a later Turn repeats it while the definitions stay.
  let rendered: { generation: string; text?: string; count: number } | undefined;
  const carriedText = (generation: string): { text: string; count: number } | undefined => {
    let current = rendered;
    if (current?.generation !== generation) {
      const state = toolSearchSessionState(sessionId);
      const carried = [...state.carried].reverse().flatMap((name) => {
        const def = definitions.get(name)?.tool.def;
        return def ? [{ name, description: def.description ?? '', schema: def.schema }] : [];
      });
      const text = renderCarriedToolDefinitions(carried, facts.callForm);
      current = { generation, ...(text ? { text } : {}), count: carried.length };
      // A checkpoint can project a summary the request hook has not noted yet.
      if (generation === state.lastSummaryKey) rendered = current;
    }
    return current.text ? { text: current.text, count: current.count } : undefined;
  };

  /** What this Turn inserts into `messages` after `summary`, before any admission check. */
  const candidatesAfter = (
    messages: readonly RequestMessage[],
    summary: RequestMessage | undefined,
  ) => {
    // The summary's own time keeps every copy identical across requests.
    const timestamp = summary ? summaryTimestamp(summary) : 0;
    const carried =
      facts.carryAcrossCompaction && summary ? carriedText(summaryKey(summary)) : undefined;
    const restored =
      summary && notice && !isNewestNotice(messages, notice, NOTICE_TAG, false)
        ? notice
        : undefined;
    return [
      catalog && {
        text: catalog,
        fields: { tools: catalogEntries.length, chars: catalog.length },
        message: 'tool search catalog provided',
      },
      carried && {
        text: carried.text,
        fields: { carried: carried.count },
        message: 'tool search definitions carried across compaction',
      },
      restored && {
        text: restored,
        fields: { chars: restored.length },
        message: 'tool search availability notice restored after compaction',
      },
    ].flatMap((candidate) =>
      candidate
        ? [
            {
              ...candidate,
              marker: { role: 'user', content: candidate.text, timestamp } satisfies RequestMessage,
            },
          ]
        : [],
    );
  };

  const context = rememberContext(sessionId, previous, (messages, summary) =>
    candidatesAfter(messages, summary).map((candidate) => candidate.marker),
  );

  return (hookInput) => {
    const before = context.sent;
    context.sent = undefined;
    try {
      const messages = hookInput.messages;
      const summaryIndex = findLastCompactionSummary(messages);
      const summary = summaryIndex >= 0 ? messages[summaryIndex] : undefined;
      // Before the compaction ends the window: the notice may sit in the kept recent tail.
      noteSentNotices(sessionId, messages, planned);
      if (summary) noteCompaction(sessionId, summaryKey(summary), summaryTimestamp(summary));
      const latch = generationLatch(before, summary, hookInput);
      const { generation } = latch;
      const dropped = new Set(latch.dropped);
      const admitted = admitMarkers(
        hookInput,
        candidatesAfter(messages, summary),
        canAppend,
        dropped,
      );
      for (const candidate of admitted) {
        logOnce(
          generation,
          candidate.message,
          { ...candidate.fields, generation },
          candidate.message,
        );
      }
      const added = admitted.map((candidate) => candidate.marker);
      context.sent = { ...latch, markers: added, dropped };
      if (added.length === 0) return undefined;
      return {
        type: 'replaceRequestMessages',
        reason: TOOL_SEARCH_CONTEXT_REASON,
        messages: [
          ...messages.slice(0, summaryIndex + 1),
          ...added,
          ...messages.slice(summaryIndex + 1),
        ],
      };
    } catch (error) {
      try {
        logger?.warn?.(
          {
            session_id: sessionId,
            error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          },
          'tool search context failed',
        );
      } catch {
        // A failing logger cannot report itself.
      }
      return undefined;
    }
  };
}

/**
 * The Tool Search context the Session's latest Turn puts into its main
 * requests, applied to `messages`: the same markers at the same place, so the
 * shared-prefix checkpoint request repeats the main request's prefix. Within
 * the generation of the Session's latest main request, of this Turn or an
 * earlier one, it repeats exactly what that request sent; otherwise what the
 * Turn would send. Reads the session state but never notes a compaction: the
 * checkpoint request runs before its summary exists.
 */
export function projectToolSearchContext(
  sessionId: string,
  messages: readonly RequestMessage[],
): readonly RequestMessage[] {
  return sessionContexts.get(sessionId)?.project(messages) ?? messages;
}

/** Drops everything Tool Search keeps for a disposed Session. */
export function disposeToolSearchSession(sessionId: string): void {
  sessionContexts.delete(sessionId);
  forgetToolSearchSessionState(sessionId);
}

/** Test seam: drops what Tool Search keeps for every Session (process-wide state). */
export function __resetToolSearchSessionsForTest(): void {
  sessionContexts.clear();
  forgetAllToolSearchSessionStates();
}

/**
 * Makes `context` the Session's current one; its `project` repeats what the
 * latest main request sent in that generation, otherwise what `wouldSend` gives.
 */
function rememberContext(
  sessionId: string,
  previous: SessionRequestContext | undefined,
  wouldSend: (
    messages: readonly RequestMessage[],
    summary: RequestMessage | undefined,
  ) => readonly RequestMessage[],
): SessionRequestContext {
  const context: SessionRequestContext = {
    project: (messages) => {
      try {
        const summaryIndex = findLastCompactionSummary(messages);
        const summary = summaryIndex >= 0 ? messages[summaryIndex] : undefined;
        const generation = summary ? summaryKey(summary) : 'start';
        const markers =
          context.sent?.generation === generation
            ? context.sent.markers
            : wouldSend(messages, summary);
        if (markers.length === 0) return messages;
        return [
          ...messages.slice(0, summaryIndex + 1),
          ...markers,
          ...messages.slice(summaryIndex + 1),
        ];
      } catch {
        // The checkpoint falls back to the history as is, like a failed hook.
        return messages;
      }
    },
    sent: previous?.sent,
    logged: previous?.logged,
  };
  sessionContexts.set(sessionId, context);
  if (sessionContexts.size > MAX_SESSIONS) {
    const oldest = sessionContexts.keys().next().value;
    if (oldest !== undefined) sessionContexts.delete(oldest);
  }
  return context;
}

/**
 * The hook of a Turn that inserts nothing: it never changes the request, records
 * that each request sent no markers, notes sent notices and, while the Session
 * has a prefix window or a pending notice (`watch`), the latest compaction.
 */
function insertNothing(
  sessionId: string,
  previous: SessionRequestContext | undefined,
  watch: boolean,
  planned: PlannedToolSearchWindow | undefined,
): PiBeforeLlmCallHook {
  const context = rememberContext(sessionId, previous, () => []);
  return (hookInput) => {
    const before = context.sent;
    context.sent = undefined;
    try {
      const messages = hookInput.messages;
      const summary = messages[findLastCompactionSummary(messages)];
      noteSentNotices(sessionId, messages, planned);
      if (watch && summary) {
        noteCompaction(sessionId, summaryKey(summary), summaryTimestamp(summary));
      }
      context.sent = { ...generationLatch(before, summary, hookInput), markers: [] };
    } catch {
      // Bookkeeping must not affect the request.
    }
    return undefined;
  };
}

/**
 * The candidates the request takes, in order. Each is sized against the request
 * plus those already taken, so the catalog and carried definitions cannot each
 * fit alone and overflow together. One in `dropped` is not offered again; one
 * that does not fit joins it.
 */
function admitMarkers<T extends { readonly text: string; readonly marker: RequestMessage }>(
  hookInput: PiBeforeLlmCallHookInput,
  candidates: readonly T[],
  canAppend: CanAppend | undefined,
  dropped: Set<string>,
): T[] {
  const admitted: T[] = [];
  for (const candidate of candidates) {
    if (dropped.has(candidate.text)) continue;
    const sized =
      admitted.length > 0
        ? {
            ...hookInput,
            messages: [...hookInput.messages, ...admitted.map(({ marker }) => marker)],
          }
        : hookInput;
    if (!canAppend || canAppend(sized, candidate.marker)) admitted.push(candidate);
    else dropped.add(candidate.text);
  }
  return admitted;
}

/**
 * The request's generation and capacity, and the markers that stay out: those
 * dropped earlier in the same generation under the same capacity. Capacity is
 * what `canAppend` measures against: the model (its context window and output
 * reserve set the provider input limit) and the serialized cap.
 */
function generationLatch(
  before: SentMarkers | undefined,
  summary: RequestMessage | undefined,
  hookInput: PiBeforeLlmCallHookInput,
): Omit<SentMarkers, 'markers'> {
  const generation = summary ? summaryKey(summary) : 'start';
  const model: Partial<PiBeforeLlmCallHookInput['model']> | undefined = hookInput.model;
  const capacity = JSON.stringify([
    model?.provider ?? null,
    model?.id ?? null,
    model?.contextWindow ?? null,
    hookInput.maxTokens ?? model?.maxTokens ?? null,
    hookInput.maxSerializedInputBytes ?? null,
  ]);
  const dropped =
    before?.generation === generation && before.capacity === capacity
      ? before.dropped
      : new Set<string>();
  return { generation, capacity, dropped };
}

const NOTICE_TAG = '<tool-availability-update>';

/**
 * Marks the window the Turn planned as sent, so an answer can make it the
 * Session's. Confirms the pending notice when it is the newest notice among the
 * user messages after the request's last assistant message (what this request
 * sends anew): an older notice there, or an identical copy deeper in the history,
 * does not count. Then, once per Session, notes a notice an earlier process left
 * in the history.
 */
function noteSentNotices(
  sessionId: string,
  messages: readonly RequestMessage[],
  planned: PlannedToolSearchWindow | undefined,
): void {
  if (planned) planned.sent = true;
  const notice = pendingToolSearchNotice(sessionId);
  if (notice && isNewestNotice(messages, notice, NOTICE_TAG, true)) {
    confirmToolSearchAnnouncement(sessionId);
  }
  noteToolSearchNoticeInHistory(sessionId, () =>
    messages.some((message) => requestUserText(message)?.includes(NOTICE_TAG)),
  );
}

/**
 * The after-LLM half of `createToolSearchContextHook`, registered with it by
 * every host: once a request of the Turn is answered, the window the Turn
 * planned becomes the Session's. The provider answered, or was stopped after
 * streaming part of an answer; a request it rejected, or one stopped before the
 * first token, wrote no prompt cache, so a Turn with no answered request
 * freezes nothing and the next Turn plans afresh.
 */
export function createToolSearchResponseHook(input: {
  readonly sessionId: string;
}): PiAfterLlmCallHook {
  const { sessionId } = input;
  // Created with the Turn's request hook, after its catalog build planned the window.
  const planned = plannedToolSearchWindow(sessionId);
  return ({ message }) => {
    try {
      if (isAnsweredResponse(message)) receiveToolSearchResponse(sessionId, planned);
    } catch {
      // Bookkeeping must not affect the response.
    }
    return undefined;
  };
}
