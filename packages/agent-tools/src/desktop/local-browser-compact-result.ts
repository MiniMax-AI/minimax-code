import { isRecord } from './type-guards.js';
import { appendTabControlFields } from './local-browser-tab-fields.js';
import type { LocalBrowserToolAction } from './types.js';

// Projects a provider result onto the bounded result the compact Browser tool
// returns to the model.

const COMPACT_HOVER_SEMANTIC_SOURCES = new Set([
  'aria-label',
  'aria-labelledby',
  'title',
  'svg-title',
  'alt',
  'target-text',
  'aria-describedby',
  'hover-tooltip',
  'hover-overlay',
  'none',
]);
const COMPACT_HOVER_CONFIDENCE_LEVELS = new Set(['high', 'medium', 'low']);
export const COMPACT_STATUS_STRING_LIMITS = {
  url: 4_096,
  title: 1_024,
  error: 4_096,
  message: 4_096,
  code: 256,
} as const;

/**
 * A plain click that reports no navigation and an unverified effect may be
 * followed by a page that has moved by the next read, and a submit that
 * looks ineffective tends to be repeated. The result says how to follow such
 * a click up; the click itself and its retries are unchanged.
 *
 * Only a link or a form submit loads a later page, so only they are told to
 * wait for the url or network: for a control that acts on the page itself
 * that wait matches nothing or an unrelated request. Any other control, and a
 * click whose result does not say what it clicked (a coordinate click is not
 * probed), gets the page read.
 */
const CLICK_FOLLOW_UP_PAGE_LOAD =
  'No navigation seen right after the click. Check its effect before clicking again; for a submit or link whose page loads later use click_and_wait_for_navigation, or wait kind "url" or "network".';
const CLICK_FOLLOW_UP_READ_PAGE =
  'No navigation seen right after the click. Read the page (query or inspect) to check its effect before clicking again.';

function clickFollowUp(result: Record<string, unknown>): string | undefined {
  const effect = isRecord(result.effect) ? result.effect : undefined;
  const navigation = isRecord(result.navigation) ? result.navigation : undefined;
  if (
    result.success !== true ||
    effect?.dispatched !== true ||
    effect.verificationRequired !== true ||
    navigation?.detected !== false
  ) {
    return undefined;
  }
  const control = isRecord(result.target) ? result.target.control : undefined;
  return control === 'link' || control === 'submit'
    ? CLICK_FOLLOW_UP_PAGE_LOAD
    : CLICK_FOLLOW_UP_READ_PAGE;
}

export function summarizeCompactActionResult(
  action: LocalBrowserToolAction,
  result: unknown,
): unknown {
  if (!isRecord(result)) return sanitizeBrowserResult(result);

  const summary: Record<string, unknown> = {};
  if (typeof result.success === 'boolean') summary.success = result.success;
  if (typeof result.openedInNewTab === 'boolean') {
    summary.openedInNewTab = result.openedInNewTab;
  }
  // Tab ids are the handles select_tab and close_tab take.
  if (
    (action === 'open_tab' ||
      action === 'select_tab' ||
      action === 'close_tab' ||
      result.openedInNewTab === true) &&
    typeof result.tabId === 'number'
  ) {
    summary.tabId = result.tabId;
  }
  const preservedTabs = result.preservedTabs;
  if (typeof preservedTabs === 'number' && Number.isFinite(preservedTabs)) {
    summary.preservedTabs = Math.max(0, Math.floor(preservedTabs));
  }
  if (typeof result.duration === 'number' && Number.isFinite(result.duration)) {
    summary.duration = result.duration;
  }
  if (typeof result.durationMs === 'number' && Number.isFinite(result.durationMs)) {
    summary.durationMs = Math.max(0, Math.floor(result.durationMs));
  }
  for (const [key, limit] of Object.entries(COMPACT_STATUS_STRING_LIMITS)) {
    const value = result[key];
    if (typeof value === 'string') summary[key] = value.slice(0, limit);
  }
  if (action === 'drag') {
    if (result.mode === 'pointer' || result.mode === 'html5') summary.mode = result.mode;
    if (typeof result.dragStarted === 'boolean') summary.dragStarted = result.dragStarted;
    if (typeof result.dropDispatched === 'boolean') {
      summary.dropDispatched = result.dropDispatched;
    }
  }
  if (action === 'upload_files') {
    const effect = isRecord(result.effect) ? result.effect : undefined;
    const filesAttached =
      typeof result.filesAttached === 'number' && Number.isFinite(result.filesAttached)
        ? result.filesAttached
        : typeof effect?.fileCount === 'number' && Number.isFinite(effect.fileCount)
          ? effect.fileCount
          : undefined;
    if (filesAttached !== undefined) {
      summary.filesAttached = Math.max(0, Math.floor(filesAttached));
    }
    if (typeof result.chooserOpened === 'boolean') summary.chooserOpened = result.chooserOpened;
  }
  // wait kind "network": the finished request it matched, or on timeout how
  // many matching requests still load, plus the checkpoint for afterSequence.
  if (action === 'wait' && result.kind === 'network') {
    summary.kind = 'network';
    if (isRecord(result.entry)) summary.entry = sanitizeBrowserResult(result.entry);
    for (const key of ['lastSequence', 'pendingMatches', 'waitedMs'] as const) {
      const value = result[key];
      if (typeof value === 'number' && Number.isFinite(value)) summary[key] = value;
    }
  }
  // A selector wait that timed out: how many elements matched and how many
  // of them were visible at the last poll.
  if (action === 'wait') {
    for (const key of ['matched', 'visible'] as const) {
      const value = result[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        summary[key] = Math.max(0, Math.floor(value));
      }
    }
  }
  if (action === 'click' || action === 'double_click' || action === 'triple_click') {
    const download = boundedBrowserDownload(result.download);
    if (download) summary.download = download;
  }
  const target = boundedWriteTarget(result.target);
  if (target) summary.target = target;
  const effect =
    action === 'scroll'
      ? boundedScrollEffect(result.effect)
      : action === 'hover'
        ? boundedHoverEffect(result.effect)
        : boundedWriteEffect(result.effect);
  if (effect) summary.effect = effect;
  const navigation = boundedNavigation(result.navigation);
  if (navigation) summary.navigation = navigation;
  if (typeof result.retryable === 'boolean') summary.retryable = result.retryable;
  if (typeof result.recovery === 'string') summary.recovery = result.recovery.slice(0, 1_024);
  else if (action === 'click') {
    const next = clickFollowUp(result);
    if (next) summary.next = next;
  }
  // Diagnostics Browser Core attaches to failures so the model can correct the
  // call instead of re-querying (eval 761096: SELECT_OPTION_NOT_FOUND on the
  // wrong select, selector misses on a wrong ancestor chain).
  const availableOptions = boundedSelectOptions(result.availableOptions);
  if (availableOptions) {
    summary.availableOptions = availableOptions;
    if (result.availableOptionsTruncated === true) summary.availableOptionsTruncated = true;
    if (
      typeof result.availableOptionCount === 'number' &&
      Number.isFinite(result.availableOptionCount)
    ) {
      summary.availableOptionCount = Math.max(0, Math.floor(result.availableOptionCount));
    }
  }
  const selectorTail = boundedSelectorTail(result.selectorTail);
  if (selectorTail) summary.selectorTail = selectorTail;
  // A click refused by the pre-click hit test: why, what covers or hides the
  // target, and the link it belongs to.
  if (isRecord(result.interactability)) {
    summary.interactability = sanitizeBrowserResult(result.interactability);
  }
  const jsDialog = boundedJsDialogIdentity(result.dialog);
  if (jsDialog !== undefined) summary.dialog = jsDialog;
  if (typeof result.trigger === 'string') summary.trigger = result.trigger.slice(0, 64);
  if (result.awaitingUser === true) summary.awaitingUser = true;
  if (result.handled === true) {
    summary.handled = true;
    if (typeof result.type === 'string') summary.type = result.type.slice(0, 32);
    if (result.action === 'accept' || result.action === 'dismiss') summary.action = result.action;
  }
  // Browser Core write record: a write whose outcome is uncertain, and a write
  // that repeated one before the page was read again.
  if (isRecord(result.uncertainWrite)) {
    summary.uncertainWrite = sanitizeBrowserResult(result.uncertainWrite);
  }
  if (isRecord(result.writeRetryWarning)) {
    summary.writeRetryWarning = sanitizeBrowserResult(result.writeRetryWarning);
  }
  // A read that returned while a main-frame load is pending: it shows the old page.
  if (isRecord(result.pendingNavigation)) {
    summary.pendingNavigation = sanitizeBrowserResult(result.pendingNavigation);
  }
  // Browser Core ran a CSS selector sent as `ref` as that selector.
  if (result.targetInterpretedAs === 'selector' && typeof result.targetNote === 'string') {
    summary.targetInterpretedAs = 'selector';
    summary.targetNote = result.targetNote.slice(0, 1_024);
  }
  // Browser Core bound a ref to the element the page re-rendered in its place.
  if (isRecord(result.targetRebound)) {
    summary.targetRebound = sanitizeBrowserResult(result.targetRebound);
  }
  // A fill/type target that lost focus: the field that takes the input instead.
  if (isRecord(result.inputTarget)) summary.inputTarget = sanitizeBrowserResult(result.inputTarget);
  appendTabControlFields(action, summary, result);
  return summary;
}

/** Dialog identity only; dialog text reaches the model through inspect's virtual modal. */
export function boundedJsDialogIdentity(value: unknown): Record<string, string> | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.dialogId !== 'string' || typeof value.type !== 'string') {
    return undefined;
  }
  return { dialogId: value.dialogId.slice(0, 64), type: value.type.slice(0, 32) };
}

const MAX_COMPACT_SELECT_OPTIONS = 30;

function boundedSelectOptions(value: unknown): Array<Record<string, string>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const options = value
    .slice(0, MAX_COMPACT_SELECT_OPTIONS)
    .filter(isRecord)
    .map((option) => ({
      value: typeof option.value === 'string' ? option.value.slice(0, 80) : '',
      label: typeof option.label === 'string' ? option.label.slice(0, 80) : '',
    }));
  return options.length > 0 ? options : undefined;
}

function boundedSelectorTail(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || typeof value.selector !== 'string') return undefined;
  if (typeof value.matchCount !== 'number' || !Number.isFinite(value.matchCount)) return undefined;
  return {
    selector: value.selector.slice(0, 256),
    matchCount: Math.max(0, Math.floor(value.matchCount)),
  };
}

function boundedBrowserDownload(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const download: Record<string, unknown> = {};
  if (value.state === 'inProgress' || value.state === 'completed' || value.state === 'canceled') {
    download.state = value.state;
  }
  if (value.observation === 'timeout') download.observation = 'timeout';
  const suggestedFilename =
    typeof value.suggestedFilename === 'string'
      ? value.suggestedFilename
      : typeof value.fileName === 'string'
        ? value.fileName
        : '';
  if (suggestedFilename) download.suggestedFilename = suggestedFilename.slice(0, 255);
  for (const key of ['receivedBytes', 'totalBytes'] as const) {
    if (typeof value[key] === 'number' && Number.isFinite(value[key])) {
      download[key] = Math.max(0, Math.floor(value[key]));
    }
  }
  return Object.keys(download).length > 0 ? download : undefined;
}

function boundedWriteTarget(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const target: Record<string, unknown> = {};
  if (typeof value.resolved === 'boolean') target.resolved = value.resolved;
  if (typeof value.tag === 'string') target.tag = value.tag.slice(0, 80);
  if (typeof value.role === 'string') target.role = value.role.slice(0, 80);
  if (typeof value.inputType === 'string') target.inputType = value.inputType.slice(0, 40);
  // What a clicked control does (Browser Core's click hit test).
  if (value.control === 'link' || value.control === 'submit' || value.control === 'in_page') {
    target.control = value.control;
  }
  if (typeof value.name === 'string') target.name = value.name.slice(0, 80);
  if (typeof value.contentEditable === 'boolean') {
    target.contentEditable = value.contentEditable;
  }
  return Object.keys(target).length > 0 ? target : undefined;
}

function boundedWriteEffect(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const effect: Record<string, unknown> = {};
  if (typeof value.dispatched === 'boolean') effect.dispatched = value.dispatched;
  if (typeof value.verified === 'boolean') effect.verified = value.verified;
  if (typeof value.verificationRequired === 'boolean') {
    effect.verificationRequired = value.verificationRequired;
  }
  if (typeof value.focused === 'boolean') effect.focused = value.focused;
  if (typeof value.textChanged === 'boolean') effect.textChanged = value.textChanged;
  if (typeof value.textLength === 'number' && Number.isFinite(value.textLength)) {
    effect.textLength = Math.max(0, Math.floor(value.textLength));
  }
  // The live control state: on a failed check/select the model must see what
  // the page actually holds instead of re-querying (an uncheck and a select in evaluation).
  if (typeof value.checked === 'boolean') effect.checked = value.checked;
  if (Array.isArray(value.selectedValues)) {
    effect.selectedValues = value.selectedValues
      .filter((entry): entry is string => typeof entry === 'string')
      .slice(0, MAX_COMPACT_SELECT_OPTIONS)
      .map((entry) => entry.slice(0, 200));
  }
  if (value.fallback === 'element_click') effect.fallback = value.fallback;
  return Object.keys(effect).length > 0 ? effect : undefined;
}

function boundedHoverEffect(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const effect: Record<string, unknown> = {};
  // A hover refused by the pre-hover hit test moved no pointer.
  if (value.dispatched === false) effect.dispatched = false;
  if (typeof value.hovered === 'boolean') effect.hovered = value.hovered;
  if (typeof value.tooltipObserved === 'boolean') {
    effect.tooltipObserved = value.tooltipObserved;
  }
  if (isRecord(value.semantic)) {
    const semantic: Record<string, unknown> = {};
    if (typeof value.semantic.name === 'string') {
      semantic.name = value.semantic.name.slice(0, 256);
    }
    if (
      typeof value.semantic.source === 'string' &&
      COMPACT_HOVER_SEMANTIC_SOURCES.has(value.semantic.source)
    ) {
      semantic.source = value.semantic.source;
    }
    if (
      typeof value.semantic.confidence === 'string' &&
      COMPACT_HOVER_CONFIDENCE_LEVELS.has(value.semantic.confidence)
    ) {
      semantic.confidence = value.semantic.confidence;
    }
    if (typeof value.semantic.supportingText === 'string') {
      semantic.supportingText = value.semantic.supportingText.slice(0, 256);
    }
    if (Object.keys(semantic).length > 0) effect.semantic = semantic;
  }
  return Object.keys(effect).length > 0 ? effect : undefined;
}

function boundedScrollEffect(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const effect: Record<string, unknown> = {};
  if (typeof value.observed === 'boolean') effect.observed = value.observed;
  if (typeof value.moved === 'boolean') effect.moved = value.moved;
  const numericFields = ['actualDeltaX', 'actualDeltaY'] as const;
  for (const field of numericFields) {
    const numericValue = value[field];
    if (typeof numericValue === 'number' && Number.isFinite(numericValue)) {
      effect[field] = Math.round(numericValue);
    }
  }
  if (typeof value.atStart === 'boolean') effect.atStart = value.atStart;
  if (typeof value.atEnd === 'boolean') effect.atEnd = value.atEnd;
  return Object.keys(effect).length > 0 ? effect : undefined;
}

function boundedNavigation(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const navigation: Record<string, unknown> = {};
  if (typeof value.detected === 'boolean') navigation.detected = value.detected;
  if (typeof value.urlChanged === 'boolean') navigation.urlChanged = value.urlChanged;
  if (typeof value.loaded === 'boolean') navigation.loaded = value.loaded;
  // A load the action started is still running: the previous page is shown.
  if (value.pending === true) navigation.pending = true;
  if (typeof value.generation === 'number' && Number.isFinite(value.generation)) {
    navigation.generation = Math.max(0, Math.floor(value.generation));
  }
  if (typeof value.beforeHost === 'string') navigation.beforeHost = value.beforeHost.slice(0, 255);
  if (typeof value.afterHost === 'string') navigation.afterHost = value.afterHost.slice(0, 255);
  // The submitted document's HTTP answer: a POST already answered must not
  // be submitted again (in evaluation, timed-out submits were sent a second time).
  for (const key of ['httpStatus', 'redirectStatus'] as const) {
    if (typeof value[key] === 'number' && Number.isFinite(value[key])) {
      navigation[key] = Math.floor(value[key]);
    }
  }
  if (typeof value.requestMethod === 'string') {
    navigation.requestMethod = value.requestMethod.slice(0, 16);
  }
  return Object.keys(navigation).length > 0 ? navigation : undefined;
}

export function sanitizeBrowserResult(value: unknown, omittedKeys?: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeBrowserResult(item, omittedKeys));
  }
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (omittedKeys?.has(key)) continue;
    if (key === 'data' && typeof item === 'string' && item.length > 1024) {
      out[key] = `[base64 omitted: ${item.length} chars]`;
      continue;
    }
    out[key] = sanitizeBrowserResult(item, omittedKeys);
  }
  return out;
}
