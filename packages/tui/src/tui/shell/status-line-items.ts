/**
 * Status line item catalog.
 *
 * The status line renders a configurable, ordered list of items. Each item id
 * maps to one renderer that produces progressively shorter variants, so the
 * existing shrink/drop fitting logic keeps working unchanged.
 *
 * Item ids are kebab-case and stable: they are user-facing configuration values
 * (`tui.statusLine`), so renaming one is a breaking change. Legacy aliases keep
 * older configuration working.
 *
 * `cache-read-ratio`, `context-remaining`, `context-meter` and `review-link` are conditional
 * items. They only render when the Runtime surfaces their matching projection
 * into the shell state, so unsupported or not-yet-recorded metrics stay silent.
 *
 * `custom-command` is opt-in like `build-mode`: it renders the first stdout
 * line of the user-configured `tui.customStatusLine.command` and stays silent
 * until a run has succeeded. It never joins the default order because it
 * spawns a user process.
 */

export const TUI_STATUS_LINE_ITEMS = [
  'build-mode',
  'current-dir',
  'session-title',
  'git-branch',
  'review-link',
  'plan-mode',
  'approval-mode',
  'model-with-reasoning',
  'model',
  'context-window',
  'subagent',
  'token-quota',
  'cache-read-ratio',
  'context-remaining',
  'context-meter',
  'custom-command',
] as const;

export type TuiStatusLineItem = (typeof TUI_STATUS_LINE_ITEMS)[number];

/**
 * Accepted aliases for item ids, mapped to their canonical id. Keeping these
 * separate from the canonical list means a config written against an older
 * build keeps rendering instead of silently dropping the item.
 */
const TUI_STATUS_LINE_ITEM_ALIASES: Readonly<Record<string, TuiStatusLineItem>> = {
  'status-protocol': 'build-mode',
  vela: 'build-mode',
  workspace: 'current-dir',
  cwd: 'current-dir',
  'project-dir': 'current-dir',
  git: 'git-branch',
  branch: 'git-branch',
  pr: 'review-link',
  mr: 'review-link',
  'pull-request': 'review-link',
  'merge-request': 'review-link',
  review: 'review-link',
  permissions: 'approval-mode',
  'permission-mode': 'approval-mode',
  'model-with-thinking': 'model-with-reasoning',
  identity: 'model-with-reasoning',
  'sub-agent': 'subagent',
  quota: 'token-quota',
  'token-plan': 'token-quota',
  'cache-read': 'cache-read-ratio',
  context: 'context-remaining',
  'context-left': 'context-remaining',
  'context-bar': 'context-meter',
  'context-gauge': 'context-meter',
  custom: 'custom-command',
};

const CANONICAL_ITEMS: ReadonlySet<string> = new Set<string>(TUI_STATUS_LINE_ITEMS);

/**
 * Resolves one configured value to a canonical item id.
 *
 * Returns `undefined` for unknown ids so callers can ignore them: an unknown
 * item must never break the status line, because config may come from a newer
 * or hand-edited file.
 */
export function parseTuiStatusLineItem(value: string): TuiStatusLineItem | undefined {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (CANONICAL_ITEMS.has(normalized)) return normalized as TuiStatusLineItem;
  return TUI_STATUS_LINE_ITEM_ALIASES[normalized];
}

/**
 * Resolves a configured list to canonical item ids, preserving the configured
 * order and dropping unknown ids and duplicates.
 */
export function parseTuiStatusLineItems(values: readonly string[]): readonly TuiStatusLineItem[] {
  const seen = new Set<TuiStatusLineItem>();
  const items: TuiStatusLineItem[] = [];
  for (const value of values) {
    const item = parseTuiStatusLineItem(value);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    items.push(item);
  }
  return items;
}

/**
 * Default item order.
 *
 * `build-mode` stays opt-in. The default context items are resolved adaptively:
 * capacity is shown before usage exists, then remaining headroom replaces it.
 * The machine-readable status protocol only renders when `tui.statusLine`
 * names `build-mode` explicitly.
 */
export const TUI_STATUS_LINE_DEFAULT_ITEMS: readonly TuiStatusLineItem[] = [
  'current-dir',
  'session-title',
  'git-branch',
  'review-link',
  'plan-mode',
  'approval-mode',
  'model-with-reasoning',
  'context-window',
  'subagent',
  'token-quota',
  'context-remaining',
];
