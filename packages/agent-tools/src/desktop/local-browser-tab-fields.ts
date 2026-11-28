import type { LocalBrowserToolAction } from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const MAX_COMPACT_TAB_LIST = 30;
/** Actions whose own result names a tab; other results keep `tabId` as provider bookkeeping. */
const TAB_ACTIONS: ReadonlySet<LocalBrowserToolAction> = new Set([
  'open_tab',
  'list_tabs',
  'select_tab',
  'close_tab',
  'mark_tab',
  'show_tab',
  'release_tab',
]);
const TAB_CONTROL_ID_KEYS = [
  'previousTabId',
  'controlledTabId',
  'visibleTabId',
  'leaseReturnedTo',
] as const;
const TAB_CONTROL_FLAG_KEYS = [
  'reused',
  'woken',
  'stoppedApp',
  'otherSessionsAffected',
  'takenOverLastTurn',
  'releasedControl',
  'panelVisible',
  'shown',
  'pending',
] as const;

/**
 * Tab-control fields the model needs to select, close or mark tabs. Compact
 * results otherwise drop `tabId` as provider bookkeeping.
 */
export function appendTabControlFields(
  action: LocalBrowserToolAction,
  summary: Record<string, unknown>,
  result: Record<string, unknown>,
) {
  if (TAB_ACTIONS.has(action) && typeof result.tabId === 'number') summary.tabId = result.tabId;
  for (const key of TAB_CONTROL_ID_KEYS) {
    const value = result[key];
    if (value === null || (typeof value === 'number' && Number.isSafeInteger(value))) {
      summary[key] = value;
    }
  }
  for (const key of TAB_CONTROL_FLAG_KEYS) {
    if (typeof result[key] === 'boolean') summary[key] = result[key];
  }
  if (typeof result.owner === 'string') summary.owner = result.owner.slice(0, 16);
  if (typeof result.retention === 'string') summary.retention = result.retention.slice(0, 16);
  if (typeof result.surfaceKind === 'string') summary.surfaceKind = result.surfaceKind.slice(0, 16);
  if (typeof result.notice === 'string') summary.notice = result.notice.slice(0, 1_024);
  if (Array.isArray(result.closedTabIds)) {
    summary.closedTabIds = result.closedTabIds
      .filter((value): value is number => typeof value === 'number' && Number.isSafeInteger(value))
      .slice(0, MAX_COMPACT_TAB_LIST);
  }
  if (isRecord(result.openedTab)) {
    const opened = boundedTabListEntry(result.openedTab);
    if (opened) summary.openedTab = opened;
  }
  if (isRecord(result.miniApp)) {
    const miniApp: Record<string, string> = {};
    if (typeof result.miniApp.pluginId === 'string') {
      miniApp.pluginId = result.miniApp.pluginId.slice(0, 256);
    }
    if (typeof result.miniApp.displayName === 'string') {
      miniApp.displayName = result.miniApp.displayName.slice(0, 256);
    }
    summary.miniApp = miniApp;
  }
  if (Array.isArray(result.tabs)) {
    summary.tabs = result.tabs
      .slice(0, MAX_COMPACT_TAB_LIST)
      .map(boundedTabListEntry)
      .filter((entry): entry is Record<string, unknown> => entry !== undefined);
  }
}

function boundedTabListEntry(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || typeof value.tabId !== 'number') return undefined;
  const entry: Record<string, unknown> = { tabId: value.tabId };
  if (typeof value.url === 'string') entry.url = value.url.slice(0, 2_048);
  if (typeof value.title === 'string') entry.title = value.title.slice(0, 256);
  for (const key of ['owner', 'retention', 'surfaceKind'] as const) {
    if (typeof value[key] === 'string') entry[key] = (value[key] as string).slice(0, 16);
  }
  for (const key of ['controlled', 'visible', 'asleep', 'takenOverLastTurn'] as const) {
    if (value[key] === true) entry[key] = true;
  }
  return entry;
}
