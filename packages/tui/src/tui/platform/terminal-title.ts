import path from 'node:path';
import type { Terminal } from '../engine/public.js';
import type { TuiAgentStatus } from '../shell/status-protocol.js';
import { sanitizeTerminalLabel } from '../rendering/terminal-text.js';

const DEFAULT_ITEMS = ['status', 'session-name', 'app-name'] as const;
const STATUS_LABELS: Record<TuiAgentStatus, string> = {
  ready: 'Ready',
  run: 'Working',
  perm: 'Needs approval',
  plan: 'Needs approval',
  ask: 'Needs input',
  done: 'Done',
  fail: 'Failed',
  cancel: 'Stopped',
  error: 'Error',
};

export function tuiTerminalSessionLabel(input: {
  readonly title?: string;
  readonly sessionId?: string;
  readonly workspace: string;
}): string {
  const title = sanitizeTerminalLabel(input.title ?? '');
  if (title && title.toLowerCase() !== 'new session') return title;
  const project = sanitizeTerminalLabel(path.basename(input.workspace)) || 'Session';
  return input.sessionId ? `${project} (${sanitizeTerminalLabel(input.sessionId, 8)})` : project;
}

export function formatTuiTerminalTitle(
  input: {
    readonly title?: string;
    readonly sessionId?: string;
    readonly workspace: string;
    readonly status: TuiAgentStatus;
  },
  items: readonly string[] | null = DEFAULT_ITEMS,
): string | undefined {
  const values: Readonly<Record<string, string>> = {
    'app-name': 'MCode',
    'session-name': tuiTerminalSessionLabel(input),
    'project-name': sanitizeTerminalLabel(path.basename(input.workspace)),
    status: STATUS_LABELS[input.status],
  };
  const title = [...new Set(items ?? [])]
    .map((item) => (Object.hasOwn(values, item) ? values[item] : undefined))
    .filter(Boolean)
    .join(' | ');
  return sanitizeTerminalLabel(title) || undefined;
}

/** Owns only the title written by this TUI; the previous shell title is unknown. */
export class TuiTerminalTitle {
  private active = false;
  private disposed = false;
  private lastTitle?: string;

  constructor(
    private readonly terminal: Pick<Terminal, 'setTitle'>,
    private readonly isTTY: boolean,
  ) {}

  setActive(active: boolean): void {
    if (this.disposed || this.active === active) return;
    if (!active) this.clear();
    this.active = active;
  }

  update(title: string | undefined): void {
    if (!this.active || this.disposed || !this.isTTY) return;
    const nextTitle = title === undefined ? undefined : sanitizeTerminalLabel(title) || undefined;
    if (nextTitle === undefined) {
      this.clear();
      return;
    }
    if (nextTitle === this.lastTitle) return;
    try {
      this.terminal.setTitle(nextTitle);
      this.lastTitle = nextTitle;
    } catch {
      // Optional title output must not interrupt the conversation.
    }
  }

  dispose(): void {
    this.setActive(false);
    this.disposed = true;
  }

  private clear(): void {
    if (this.lastTitle === undefined) return;
    try {
      this.terminal.setTitle('');
    } catch {
      // Release ownership even if the terminal has already closed.
    }
    this.lastTitle = undefined;
  }
}
