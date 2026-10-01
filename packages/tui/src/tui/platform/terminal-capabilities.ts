export type TerminalId =
  | 'apple-terminal'
  | 'cmux'
  | 'ghostty'
  | 'iterm2'
  | 'kitty'
  | 'vscode'
  | 'warp'
  | 'wezterm'
  | 'windows-terminal'
  | 'unknown';

export type TerminalMultiplexer = 'none' | 'tmux' | 'screen';
export type TerminalTransport = 'local' | 'ssh';
export type TerminalColorLevel = 0 | 1 | 2 | 3;

export interface TerminalCapabilities {
  readonly terminalId: TerminalId;
  readonly platform: NodeJS.Platform;
  readonly isTTY: boolean;
  readonly transport: TerminalTransport;
  readonly multiplexer: TerminalMultiplexer;
  readonly color: boolean;
  readonly colorLevel: TerminalColorLevel;
}

export interface DetectTerminalCapabilitiesInput {
  readonly platform: NodeJS.Platform;
  readonly isTTY: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly colorDepth?: number;
}

export function detectTerminalCapabilities(
  input: DetectTerminalCapabilitiesInput,
): TerminalCapabilities {
  const terminalId = detectTerminalId(input.env);
  const multiplexer = detectTerminalMultiplexer(input.env);
  const transport = detectTransport(input.env);
  const interactive = input.isTTY && input.env.TERM !== 'dumb';
  const colorLevel = detectColorLevel(input, interactive);
  return Object.freeze({
    terminalId,
    platform: input.platform,
    isTTY: input.isTTY,
    transport,
    multiplexer,
    color: colorLevel > 0,
    colorLevel,
  });
}

function detectTransport(env: Readonly<Record<string, string | undefined>>): TerminalTransport {
  return isSshSession(env) ? 'ssh' : 'local';
}

export function detectProcessTerminalCapabilities(): TerminalCapabilities {
  return detectTerminalCapabilities({
    platform: process.platform,
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    env: process.env,
    colorDepth: process.stdout.getColorDepth?.(process.env),
  });
}

function detectColorLevel(
  input: DetectTerminalCapabilitiesInput,
  interactive: boolean,
): TerminalColorLevel {
  if (!interactive || input.env.NO_COLOR !== undefined || input.env.FORCE_COLOR === '0') return 0;
  if (input.env.FORCE_COLOR !== undefined) {
    const forced = Number.parseInt(input.env.FORCE_COLOR, 10);
    if (Number.isInteger(forced)) return Math.max(1, Math.min(3, forced)) as TerminalColorLevel;
    return 1;
  }
  if ((input.colorDepth ?? 0) >= 24) return 3;
  if ((input.colorDepth ?? 0) >= 8) return 2;
  if ((input.colorDepth ?? 0) >= 4) return 1;
  const colorTerm = input.env.COLORTERM?.toLocaleLowerCase();
  if (colorTerm === 'truecolor' || colorTerm === '24bit') return 3;
  const term = input.env.TERM?.toLocaleLowerCase() ?? '';
  if (term.includes('truecolor') || term.includes('24bit')) return 3;
  if (term.includes('256color')) return 2;
  return 1;
}

function detectTerminalId(env: Readonly<Record<string, string | undefined>>): TerminalId {
  if (env.CMUX_SOCKET_PATH || env.TERM_PROGRAM?.toLowerCase() === 'cmux') return 'cmux';
  if (env.WT_SESSION && !isSshSession(env)) return 'windows-terminal';
  const program = env.TERM_PROGRAM?.toLocaleLowerCase();
  if (program === 'apple_terminal') return 'apple-terminal';
  if (program === 'ghostty') return 'ghostty';
  if (program === 'iterm.app') return 'iterm2';
  if (program === 'vscode') return 'vscode';
  if (program === 'wezterm') return 'wezterm';
  if (program === 'warpterminal') return 'warp';

  const term = env.TERM?.toLocaleLowerCase() ?? '';
  if (term.includes('ghostty')) return 'ghostty';
  if (term.includes('kitty') || env.KITTY_WINDOW_ID) return 'kitty';
  if (term.includes('wezterm')) return 'wezterm';
  return 'unknown';
}

export function detectTerminalMultiplexer(
  env: Readonly<Record<string, string | undefined>>,
): TerminalMultiplexer {
  if (env.TMUX) return 'tmux';
  const term = env.TERM?.toLocaleLowerCase() ?? '';
  if (term.startsWith('tmux')) return 'tmux';
  return term.startsWith('screen') ? 'screen' : 'none';
}

function isSshSession(env: Readonly<Record<string, string | undefined>>): boolean {
  return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY);
}
