// ── TUI presentation ─────────────────────────────────────────────

/**
 * Settings for the `custom-command` status line item.
 *
 * The command only runs when `tui.statusLine` explicitly names
 * `custom-command`, so this block alone never spawns anything. The TUI feeds
 * the command a small JSON payload on stdin. By default, the first stdout line
 * is one ordinary status item; block display adds rows around the existing line.
 */
export interface TuiCustomStatusLineConfig {
  /**
   * Command line to execute. Tokenized like `externalEditorCommand` (no shell
   * pipes on POSIX); wrap paths with spaces in quotes.
   */
  command?: string;
  /** Display as one inline item (default), or a separate block. */
  display?: 'inline' | 'block';
  /** Block position relative to the original status line. Default above; ignored inline. */
  position?: 'above' | 'below';
  /** Plain muted text (default), or allow ANSI foreground/background colors and resets. */
  colorMode?: 'plain' | 'ansi';
  /** Maximum block rows. Default 3, clamped to 1–5; ignored for inline display. */
  maxLines?: number;
  /** Per-run timeout in milliseconds. The TUI clamps it to 500–30000; default 5000. */
  timeoutMs?: number;
  /**
   * Optional periodic refresh in seconds. Default 0 (event-driven only);
   * positive values are floored to a 10s minimum by the TUI.
   */
  intervalSeconds?: number;
}

export interface TuiConfig {
  /** Ordered terminal title items. Null or an empty list disables title updates. */
  terminalTitle?: readonly string[] | null;
  /** Terminal notification policy. Unknown focus falls back to notifying. */
  notifications?: {
    when?: 'unfocused' | 'always' | 'never';
    method?: 'auto' | 'osc9' | 'osc777' | 'bel';
    /** Omit to enable all supported notification events; an empty list disables them. */
    events?: readonly string[];
  };
  /** Show contextual Tips in the idle composer header. Defaults to true. */
  showTips?: boolean;
  /**
   * Status line items, in display order.
   *
   * Item ids are kebab-case, for example
   * `["model-with-reasoning", "context-remaining", "current-dir"]`.
   * The TUI owns the item catalog and ignores ids it does not recognize, so a
   * config written for a newer build still renders.
   *
   * `undefined` means "use the build default". An empty array is honoured as a
   * deliberately blank status line.
   */
  statusLine?: readonly string[];
  /** Settings for the opt-in `custom-command` status line item. */
  customStatusLine?: TuiCustomStatusLineConfig;
}

// ── TUI config parsing ──────────────────────────────────────────

/**
 * Parses TUI presentation settings.
 *
 * Item ids are validated by the TUI, not here: config only guarantees the shape
 * (array of non-empty strings). A malformed value falls back to `undefined` so
 * the TUI renders its build default rather than an empty line.
 */
export function parseTuiConfig(raw: Record<string, unknown>): TuiConfig {
  const rawTui = raw.tui;
  if (rawTui == null || typeof rawTui !== 'object' || Array.isArray(rawTui)) return {};
  const tui = rawTui as Record<string, unknown>;
  const rawNotifications = tui.notifications;
  let notifications: TuiConfig['notifications'];
  if (
    rawNotifications &&
    typeof rawNotifications === 'object' &&
    !Array.isArray(rawNotifications)
  ) {
    const { when, method, events } = rawNotifications as Record<string, unknown>;
    notifications = {
      ...(when === 'unfocused' || when === 'always' || when === 'never' ? { when } : {}),
      ...(method === 'auto' || method === 'osc9' || method === 'osc777' || method === 'bel'
        ? { method }
        : {}),
      ...(Array.isArray(events)
        ? {
            events: events.filter((event): event is string => typeof event === 'string'),
          }
        : {}),
    };
  }
  const rawStatusLine = tui.statusLine;
  const statusLine = Array.isArray(rawStatusLine)
    ? rawStatusLine
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    : undefined;
  const customStatusLine = parseTuiCustomStatusLineConfig(tui.customStatusLine);
  return {
    ...(tui.terminalTitle === null
      ? { terminalTitle: null }
      : Array.isArray(tui.terminalTitle)
        ? {
            terminalTitle: tui.terminalTitle
              .filter((item): item is string => typeof item === 'string')
              .map((item) => item.trim())
              .filter(Boolean),
          }
        : {}),
    ...(typeof tui.showTips === 'boolean' ? { showTips: tui.showTips } : {}),
    ...(notifications ? { notifications } : {}),
    ...(statusLine ? { statusLine } : {}),
    ...(customStatusLine ? { customStatusLine } : {}),
  };
}

/**
 * Parses the `custom-command` status item settings.
 *
 * A block without a usable `command` is dropped entirely: the TUI treats a
 * missing block as "item configured but inert", so partial or malformed config
 * can never spawn a process. Numeric bounds are enforced by the TUI, keeping
 * one owner for the clamping behaviour.
 */
function parseTuiCustomStatusLineConfig(value: unknown): TuiCustomStatusLineConfig | undefined {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const command = typeof raw.command === 'string' ? raw.command.trim() : '';
  if (!command) return undefined;
  return {
    command,
    ...(raw.display === 'inline' || raw.display === 'block' ? { display: raw.display } : {}),
    ...(raw.position === 'above' || raw.position === 'below' ? { position: raw.position } : {}),
    ...(raw.colorMode === 'plain' || raw.colorMode === 'ansi' ? { colorMode: raw.colorMode } : {}),
    ...(typeof raw.maxLines === 'number' && Number.isFinite(raw.maxLines)
      ? { maxLines: raw.maxLines }
      : {}),
    ...(typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs)
      ? { timeoutMs: raw.timeoutMs }
      : {}),
    ...(typeof raw.intervalSeconds === 'number' && Number.isFinite(raw.intervalSeconds)
      ? { intervalSeconds: raw.intervalSeconds }
      : {}),
  };
}
