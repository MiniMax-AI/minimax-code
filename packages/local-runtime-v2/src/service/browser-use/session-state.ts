import { createHash } from 'node:crypto';

import type { LocalBrowserSkillSessionStore } from '@mavis/agent-tools/desktop';

import type {
  BrowserTurnContextCapability,
  BrowserTurnContextRecordInput,
  InAppBrowserSurfaceState,
  InAppBrowserTabState,
} from './contracts.js';

export class BrowserSkillSessionStore implements LocalBrowserSkillSessionStore {
  private readonly loadedContentDigests = new Map<string, string | undefined>();

  hasLoaded(sessionId: string, expectedContent?: string): boolean {
    return (
      this.loadedContentDigests.has(sessionId) &&
      (expectedContent === undefined ||
        this.loadedContentDigests.get(sessionId) === contentDigest(expectedContent))
    );
  }

  markLoaded(sessionId: string, content?: string): void {
    this.loadedContentDigests.set(
      sessionId,
      content === undefined ? undefined : contentDigest(content),
    );
  }

  clearSession(sessionId: string): void {
    this.loadedContentDigests.delete(sessionId);
  }

  clear(): void {
    this.loadedContentDigests.clear();
  }
}

function contentDigest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

interface StoredBrowserTurnContext {
  readonly turnId: string;
  readonly inAppBrowser: InAppBrowserSurfaceState;
}

export class BrowserTurnContextStore implements BrowserTurnContextCapability {
  private readonly records = new Map<string, StoredBrowserTurnContext>();

  record(input: BrowserTurnContextRecordInput): void {
    if (!input.sessionId.trim()) throw new TypeError('sessionId must be a non-empty string');
    if (!input.turnId.trim()) throw new TypeError('turnId must be a non-empty string');
    assertInAppBrowserSurfaceState(input.inAppBrowser);
    const listed = listInAppBrowserTabs(input.inAppBrowser.tabs);
    const omitted = (listed?.omitted ?? 0) + readTabsOmitted(input.inAppBrowser.tabsOmitted);
    this.records.set(input.sessionId, {
      turnId: input.turnId,
      inAppBrowser: {
        visible: input.inAppBrowser.visible,
        selectedTab: input.inAppBrowser.selectedTab,
        ...(listed ? { tabs: listed.tabs } : {}),
        ...(omitted > 0 ? { tabsOmitted: omitted } : {}),
      },
    });
  }

  read(sessionId: string, turnId: string | undefined): InAppBrowserSurfaceState | undefined {
    if (!turnId) return undefined;
    const record = this.records.get(sessionId);
    if (!record || record.turnId !== turnId) return undefined;
    return { ...record.inAppBrowser };
  }

  clearSession(sessionId: string): void {
    this.records.delete(sessionId);
  }

  clear(): void {
    this.records.clear();
  }
}

function assertInAppBrowserSurfaceState(value: unknown): asserts value is InAppBrowserSurfaceState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('inAppBrowser must be an object');
  }
  const state = value as Record<string, unknown>;
  if (typeof state.visible !== 'boolean') {
    throw new TypeError('inAppBrowser.visible must be a boolean');
  }
  if (typeof state.selectedTab !== 'boolean') {
    throw new TypeError('inAppBrowser.selectedTab must be a boolean');
  }
}

/** At most this many tabs reach the turn context; the model lists the rest with list_tabs. */
const IN_APP_BROWSER_CONTEXT_MAX_TABS = 12;
const MAX_TAB_TITLE_LENGTH = 120;
const MAX_TAB_URL_LENGTH = 300;

const TAB_OWNERS: ReadonlySet<unknown> = new Set(['user', 'agent']);
const TAB_RETENTIONS: ReadonlySet<unknown> = new Set(['temporary', 'carryover', 'deliverable']);
const TAB_SURFACES: ReadonlySet<unknown> = new Set(['web', 'miniapp']);

/**
 * Tabs reported by the desktop shell for the turn context. Entries that are
 * not well formed are dropped rather than failing the whole turn context.
 */
export function normalizeInAppBrowserTabs(value: unknown): InAppBrowserTabState[] | undefined {
  return listInAppBrowserTabs(value)?.tabs;
}

/**
 * The tabs the turn context lists, at most {@link IN_APP_BROWSER_CONTEXT_MAX_TABS},
 * and how many it leaves out. The page the user is viewing always stays; the
 * rest are the most recently opened ones (the shell reports tabs oldest first).
 * List order is kept.
 */
export function listInAppBrowserTabs(
  value: unknown,
): { tabs: InAppBrowserTabState[]; omitted: number } | undefined {
  if (!Array.isArray(value)) return undefined;
  const all = value.map(normalizeTab).filter((tab): tab is InAppBrowserTabState => !!tab);
  if (all.length <= IN_APP_BROWSER_CONTEXT_MAX_TABS) return { tabs: all, omitted: 0 };
  const visible = all.find((tab) => tab.visible);
  const recent = all.filter((tab) => tab !== visible);
  const kept = new Set(recent.slice(-(IN_APP_BROWSER_CONTEXT_MAX_TABS - (visible ? 1 : 0))));
  if (visible) kept.add(visible);
  return { tabs: all.filter((tab) => kept.has(tab)), omitted: all.length - kept.size };
}

/** A tab count left out upstream (the route already capped the list). */
function readTabsOmitted(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function normalizeTab(item: unknown): InAppBrowserTabState | undefined {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
  const raw = item as Record<string, unknown>;
  const tabId = raw.tabId;
  if (typeof tabId !== 'number' || !Number.isSafeInteger(tabId) || tabId < 0) return undefined;
  return {
    tabId,
    ...pickText(raw, 'title', MAX_TAB_TITLE_LENGTH),
    ...pickText(raw, 'url', MAX_TAB_URL_LENGTH),
    ...pickEnum(raw, 'owner', TAB_OWNERS),
    ...pickEnum(raw, 'retention', TAB_RETENTIONS),
    ...pickEnum(raw, 'surfaceKind', TAB_SURFACES),
    ...pickTrue(raw, 'visible'),
    ...pickTrue(raw, 'asleep'),
  } as InAppBrowserTabState;
}

function pickText(raw: Record<string, unknown>, key: string, maxLength: number) {
  const text = boundedText(raw[key], maxLength);
  return text ? { [key]: text } : {};
}

function pickEnum(raw: Record<string, unknown>, key: string, allowed: ReadonlySet<unknown>) {
  return allowed.has(raw[key]) ? { [key]: raw[key] } : {};
}

function pickTrue(raw: Record<string, unknown>, key: string) {
  return raw[key] === true ? { [key]: true } : {};
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : undefined;
}
