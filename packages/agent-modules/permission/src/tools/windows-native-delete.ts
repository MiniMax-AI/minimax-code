export type WindowsNativeDeleteCommand = {
  command: 'del' | 'erase' | 'rd' | 'rmdir' | 'remove-item' | 'ri' | 'rm';
  shell: 'cmd' | 'powershell';
  targets: string[];
  targetTokens: WindowsToken[];
  recursive?: boolean;
  force?: boolean;
};

export type WindowsShellFamily = 'cmd' | 'powershell';

type WindowsToken = {
  value: string;
  quoted: boolean;
};

const CMD_FILE_DELETE = new Set(['del', 'erase']);
const CMD_DIRECTORY_DELETE = new Set(['rd', 'rmdir']);
// Built-in PowerShell aliases that resolve to Remove-Item on Windows.
const POWERSHELL_DELETE = new Set(['remove-item', 'ri', 'rm', 'del', 'erase', 'rd', 'rmdir']);
const CMD_FILE_FLAGS = new Set(['/f', '/q']);
const CMD_DIRECTORY_FLAGS = new Set(['/s', '/q']);
const POWERSHELL_FLAGS = new Set(['-recurse', '-force']);

/**
 * Parse only the Windows native-delete subset whose argv can be translated to
 * the local runtime's recoverable trash launcher without evaluating shell
 * syntax. Anything dynamic, wrapped, compound, provider-backed, wildcarded or
 * dependent on named PowerShell path parameters is deliberately rejected.
 */
export function parseWindowsNativeDelete(
  command: string,
  shell: WindowsShellFamily | undefined,
): WindowsNativeDeleteCommand | undefined {
  if (!shell) return undefined;
  const tokens = tokenizeWindowsLiteralCommand(command);
  if (!tokens || tokens.length < 2) return undefined;

  const executable = tokens[0]!.value.toLowerCase();
  if (shell === 'cmd') {
    if (CMD_FILE_DELETE.has(executable))
      return parseCmdDelete(executable as 'del' | 'erase', tokens.slice(1), false);
    if (CMD_DIRECTORY_DELETE.has(executable))
      return parseCmdDelete(executable as 'rd' | 'rmdir', tokens.slice(1), true);
    return undefined;
  }
  if (POWERSHELL_DELETE.has(executable))
    return parsePowerShellDelete(
      executable as WindowsNativeDeleteCommand['command'],
      tokens.slice(1),
    );
  return undefined;
}

function parseCmdDelete(
  command: 'del' | 'erase' | 'rd' | 'rmdir',
  operands: WindowsToken[],
  directoryDelete: boolean,
): WindowsNativeDeleteCommand | undefined {
  const acceptedFlags = directoryDelete ? CMD_DIRECTORY_FLAGS : CMD_FILE_FLAGS;
  const targetTokens: WindowsToken[] = [];
  let recursive = false;
  let force = false;

  for (const token of operands) {
    const lower = token.value.toLowerCase();
    if (!token.quoted && lower.startsWith('/')) {
      if (!acceptedFlags.has(lower)) return undefined;
      if (lower === '/s') recursive = true;
      if (lower === '/f') force = true;
      continue;
    }
    // A leading `-` is PowerShell-style option syntax. CMD does not
    // interpret it as a flag; rejecting it keeps cross-shell commands
    // fail-closed instead of treating a flag as a deletion target.
    if (!token.quoted && lower.startsWith('-')) return undefined;
    if (!isLiteralWindowsTarget(token.value)) return undefined;
    targetTokens.push(token);
  }

  if (targetTokens.length === 0 || (directoryDelete && !recursive)) return undefined;
  return {
    command,
    shell: 'cmd',
    targets: targetTokens.map((token) => token.value),
    targetTokens,
    ...(recursive ? { recursive: true } : {}),
    ...(force ? { force: true } : {}),
  };
}

function parsePowerShellDelete(
  command: WindowsNativeDeleteCommand['command'],
  operands: WindowsToken[],
): WindowsNativeDeleteCommand | undefined {
  const targetTokens: WindowsToken[] = [];
  let recursive = false;
  let force = false;

  for (const token of operands) {
    const lower = token.value.toLowerCase();
    if (!token.quoted && lower.startsWith('-')) {
      if (!POWERSHELL_FLAGS.has(lower)) return undefined;
      if (lower === '-recurse') recursive = true;
      if (lower === '-force') force = true;
      continue;
    }
    // CMD-style switches (`del /q`, `rd /s`) are drive-relative paths to
    // Remove-Item. Refuse them rather than deleting something like `\s`.
    if (!token.quoted && /^\/[a-z?](?::|$)/.test(lower)) return undefined;
    if (!isLiteralWindowsTarget(token.value) || token.value.includes(',')) return undefined;
    targetTokens.push(token);
  }

  if (targetTokens.length === 0) return undefined;
  return {
    command,
    shell: 'powershell',
    targets: targetTokens.map((token) => token.value),
    targetTokens,
    ...(recursive ? { recursive: true } : {}),
    ...(force ? { force: true } : {}),
  };
}

function isLiteralWindowsTarget(target: string): boolean {
  if (!target || /[%!$`*?[\]^]/.test(target)) return false;
  if (/^[A-Za-z][A-Za-z0-9_-]*:\\/.test(target) && !/^[A-Za-z]:[\\/]/.test(target)) return false;
  return true;
}

function tokenizeWindowsLiteralCommand(command: string): WindowsToken[] | undefined {
  const tokens: WindowsToken[] = [];
  let current = '';
  let quoted = false;
  let quote: '"' | "'" | undefined;

  const flush = (): void => {
    if (current.length === 0) return;
    tokens.push({ value: current, quoted });
    current = '';
    quoted = false;
  };

  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (quote) {
      if (char === quote) {
        quote = undefined;
        quoted = true;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      quoted = true;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    if ('&|<>;()'.includes(char)) return undefined;
    current += char;
  }

  if (quote) return undefined;
  flush();
  return tokens;
}
