import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Terminal } from '../engine/public.js';
import { detectTerminalCapabilities, type TerminalCapabilities } from './terminal-capabilities.js';
import { sanitizeTerminalLabel } from '../rendering/terminal-text.js';

const ESC = '\u001B';
const BEL = '\u0007';
const ST = `${ESC}\\`;
const MAX_DEDUPE_KEYS = 256;

export interface TuiNotificationSettings {
  readonly when?: 'unfocused' | 'always' | 'never';
  readonly method?: 'auto' | 'osc9' | 'osc777' | 'bel';
  readonly events?: readonly string[];
}

export type TuiTerminalNotificationKind =
  | 'turn-complete'
  | 'permission-required'
  | 'question-required'
  | 'turn-failed';

const NOTIFICATIONS: Readonly<
  Record<TuiTerminalNotificationKind, { title: string; body: string }>
> = {
  'turn-complete': { title: 'MCode', body: 'Response complete' },
  'permission-required': { title: 'MCode', body: 'Permission needs your input' },
  'question-required': { title: 'MCode', body: 'Question needs your input' },
  'turn-failed': { title: 'MCode', body: 'Response stopped with an error' },
};

type ExecuteNotificationFile = (
  file: string,
  args: readonly string[],
  callback: (error: Error | null) => void,
) => unknown;

export class TuiTerminalNotifications {
  private readonly dedupe = new Set<string>();
  private readonly dedupeOrder: string[] = [];
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly executeFile: ExecuteNotificationFile;
  private readonly capabilities: TerminalCapabilities;
  private active = false;
  private disposed = false;
  private generation = 0;

  constructor(
    private readonly terminal: Pick<Terminal, 'write' | 'focused'>,
    options: {
      readonly environment?: Readonly<Record<string, string | undefined>>;
      readonly executeFile?: ExecuteNotificationFile;
      readonly settings?: TuiNotificationSettings;
      readonly capabilities?: TerminalCapabilities;
    } = {},
  ) {
    this.environment = options.environment ?? process.env;
    this.settings = options.settings ?? {};
    this.capabilities =
      options.capabilities ??
      detectTerminalCapabilities({
        platform: process.platform,
        isTTY: Boolean(process.stdout.isTTY),
        env: this.environment,
      });
    this.executeFile =
      options.executeFile ??
      ((file, args, callback) =>
        execFile(file, [...args], { timeout: 3000, windowsHide: true, maxBuffer: 4096 }, callback));
  }

  private readonly settings: TuiNotificationSettings;

  private get method(): TuiNotificationBackend {
    return resolveNotificationBackend(
      this.settings.method ?? 'auto',
      this.capabilities,
      this.environment,
    );
  }

  setActive(active: boolean): void {
    if (this.disposed || this.active === active) return;
    this.active = active;
    this.generation += 1;
  }

  dispose(): void {
    this.setActive(false);
    this.disposed = true;
  }

  /** True means output was attempted, not that the OS displayed a notification. */
  notifyOnce(kind: TuiTerminalNotificationKind, key: string, sessionLabel?: string): boolean {
    if (this.dedupe.has(key)) return false;
    this.remember(key);
    if (!this.active || this.disposed || !this.capabilities.isTTY) return false;
    if (this.settings.when === 'never') return false;
    if (this.settings.events && !this.settings.events.includes(kind)) return false;
    // cmux owns notification suppression; its CSI focus is not a reliable surface-focus signal.
    const hostOwnsFocus = this.capabilities.terminalId === 'cmux';
    if (this.settings.when !== 'always' && !hostOwnsFocus && this.terminal.focused === true)
      return false;
    const label = sanitizeTerminalLabel(sessionLabel ?? '', 120);
    const notification = {
      ...NOTIFICATIONS[kind],
      body: label ? `${label}: ${NOTIFICATIONS[kind].body}` : NOTIFICATIONS[kind].body,
    };
    const method = this.settings.method ?? 'auto';
    try {
      if (this.method === 'windows-toast') {
        const generation = this.generation;
        this.executeFile(
          'powershell.exe',
          ['-NoProfile', '-Command', windowsToastScript(notification.title, notification.body)],
          (error) => {
            if (
              error &&
              this.active &&
              !this.disposed &&
              generation === this.generation &&
              (this.settings.when === 'always' || this.terminal.focused !== true)
            )
              this.writeBell();
          },
        );
        return true;
      }
      for (const sequence of buildTuiTerminalNotificationSequences(
        notification,
        this.environment,
        method,
        this.capabilities,
      )) {
        this.terminal.write(sequence);
      }
      return true;
    } catch {
      // Notification failures must not interrupt a Turn or permission request.
      return false;
    }
  }

  private writeBell(): void {
    try {
      this.terminal.write(BEL);
    } catch {
      // The terminal may have closed while the native notification was pending.
    }
  }

  private remember(key: string): void {
    this.dedupe.add(key);
    this.dedupeOrder.push(key);
    if (this.dedupeOrder.length <= MAX_DEDUPE_KEYS) return;
    const expired = this.dedupeOrder.shift();
    if (expired) this.dedupe.delete(expired);
  }
}

export function shouldNotifyMcodeTurnComplete(input: {
  readonly queuedCount: number;
  readonly hasActiveRun: boolean;
}): boolean {
  return input.queuedCount === 0 && !input.hasActiveRun;
}

export function buildTuiTerminalNotificationSequences(
  notification: { readonly title: string; readonly body: string },
  environment: Readonly<Record<string, string | undefined>> = process.env,
  method: NonNullable<TuiNotificationSettings['method']> = 'auto',
  capabilities = detectTerminalCapabilities({
    platform: process.platform,
    isTTY: true,
    env: environment,
  }),
): readonly string[] {
  if (!capabilities.isTTY) return [];
  const backend = resolveNotificationBackend(method, capabilities, environment);
  if (backend === 'windows-toast') return [];
  if (backend === 'bel') return [BEL];
  const title = sanitizeTerminalLabel(notification.title, 120);
  const body = sanitizeTerminalLabel(notification.body, 400);
  const id = randomUUID();
  const sequences =
    backend === 'osc99'
      ? [`${ESC}]99;i=${id}:d=0;${title}${ST}`, `${ESC}]99;i=${id}:p=body:d=1;${body}${ST}`]
      : backend === 'osc9'
        ? [`${ESC}]9;${title}: ${body}${BEL}`]
        : [`${ESC}]777;notify;${title.replaceAll(';', ',')};${body.replaceAll(';', ',')}${BEL}`];
  if (capabilities.multiplexer !== 'tmux') return sequences;
  return sequences.map(wrapForTmuxPassthrough);
}

type TuiNotificationBackend = 'osc9' | 'osc777' | 'osc99' | 'bel' | 'windows-toast';

function resolveNotificationBackend(
  method: NonNullable<TuiNotificationSettings['method']>,
  capabilities: TerminalCapabilities,
  environment: Readonly<Record<string, string | undefined>>,
): TuiNotificationBackend {
  if (method !== 'auto') return method;
  switch (capabilities.terminalId) {
    case 'cmux':
      return 'osc777';
    case 'kitty':
      return 'osc99';
    case 'ghostty':
    case 'iterm2':
    case 'wezterm':
    case 'warp':
      return 'osc9';
    case 'windows-terminal':
      return capabilities.transport === 'local' &&
        (capabilities.platform === 'win32' ||
          (capabilities.platform === 'linux' &&
            environment.WSL_DISTRO_NAME &&
            environment.WSL_INTEROP))
        ? 'windows-toast'
        : 'bel';
    default:
      return 'bel';
  }
}

function wrapForTmuxPassthrough(sequence: string): string {
  return `${ESC}Ptmux;${sequence.replaceAll(ESC, `${ESC}${ESC}`)}${ST}`;
}

function windowsToastScript(title: string, body: string): string {
  const type = 'Windows.UI.Notifications';
  const manager = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
  const template = `[${type}.ToastTemplateType]::ToastText01`;
  const toast = `[${type}.ToastNotification]::new($xml)`;
  return [
    `${manager} > $null`,
    `$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
    `$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body.replaceAll("'", "''")}')) > $null`,
    `[${type}.ToastNotificationManager]::CreateToastNotifier('${title.replaceAll("'", "''")}').Show(${toast})`,
  ].join('; ');
}
