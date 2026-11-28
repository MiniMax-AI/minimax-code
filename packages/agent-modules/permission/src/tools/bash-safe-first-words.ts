/**
 * Bash fast-allow first-word set + SIGKILL detection.
 *
 * Two pieces:
 *
 *   1. `SAFE_BASH_FIRST_WORDS` — curated set of first-word commands the
 *      bash-permission pipeline (`tools/bash-permission.ts`) treats as
 *      fast-allow once the SOFT pre-scan + path-write gates are clean.
 *   2. `isDestructiveKillCommand` — detects `kill -9 / -KILL / -SIGKILL` and
 *      `kill` aimed at a process group or every process (`0`, `-1`, `-<pgid>`)
 *      so the fast-allow path can demote `kill` back to ASK.
 *
 * Pure data + helpers. No orchestration, no LLM, no host-port dependencies.
 * Sibling to `bash-fast-allow.ts` (which handles first-word EXTRACTION) —
 * this module owns the WHITELIST plus the kill-signal demotion.
 */

import { shellTokenize } from './shell-tokenize.js';

export const SAFE_BASH_FIRST_WORDS: ReadonlySet<string> = new Set([
  // Read-only / stream / informational
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'sort',
  'uniq',
  'diff',
  'file',
  'stat',
  'du',
  'df',
  'tree',
  'which',
  'type',
  'whereis',
  // `where` is where.exe on Windows (zsh builtin elsewhere); PowerShell's
  // Where-Object alias is normalised away by pureReadFirstWord.
  'where',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'date',
  'whoami',
  'hostname',
  'uname',
  'echo',
  'printf',
  'pwd',
  'printenv',
  'find',
  'fd',
  'rg',
  'ag',
  'ack',
  'grep',
  'nl',
  'less',
  'more',
  // Shell builtins / test
  'cd',
  'test',
  '[',
  'true',
  'false',
  'exit',
  // Stream / data shaping
  'jq',
  'yq',
  'tr',
  'cut',
  'sed',
  // Archive
  'tar',
  'zip',
  'unzip',
  'gzip',
  'gunzip',
  // Document conversion
  'pdftotext',
  'pandoc',
  // Filesystem creators (no delete surface)
  'mkdir',
  'touch',
  // SQLite CLI — destructive SQL gated separately
  'sqlite3',
  // POSIX shells — `bash script.sh` allowed via SOFT relaxation
  'bash',
  'sh',
  'zsh',
  'dash',
  // Package managers / build tools
  'npm',
  'npx',
  'yarn',
  'pnpm',
  'bun',
  'pip',
  'pip3',
  'uv',
  'poetry',
  'cargo',
  'rustc',
  'go',
  'gcc',
  'g++',
  'make',
  'cmake',
  // Test / lint tooling
  'jest',
  'vitest',
  'pytest',
  'mocha',
  'eslint',
  'prettier',
  'tsc',
  // VCS tools
  'git',
  'glab',
  'gh',
  // Process inspection / control
  'ps',
  'kill',
  // `pkill` matches by name and can end unrelated processes (including this app's
  // own helpers), so it goes to the LLM gate instead of fast-allow.
  'lsof',
  'strings',
  // Binary / object-file inspection
  'hexdump',
  'xxd',
  'otool',
  'nm',
  'objdump',
  'readelf',
  'sleep',
  'wait',
  'disown',
  // Hashing / checksum
  'md5',
  'md5sum',
  'sha1sum',
  'sha224sum',
  'sha256sum',
  'sha384sum',
  'sha512sum',
  'shasum',
  'cksum',
  // Project / IM tools
  'lark-cli',
  'matrix-cli',
  'archon',
  'mavis',
  'mavis-trash',
  // Trash-cli entries
  'trash-put',
  'trash',
  // POSIX env-var builtins
  'export',
  'unset',
  // POSIX shell control-flow keywords
  'for',
  'while',
  'until',
  'select',
  'do',
  'done',
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'case',
  'esac',
  'in',
]);

// ---------------------------------------------------------------------------
// SIGKILL detection
// ---------------------------------------------------------------------------

const SIGKILL_SHORT_TOKEN = /^-(?:9|KILL|SIGKILL)$/i;
const SIGKILL_LONG_EQ_TOKEN = /^--signal=(?:9|KILL|SIGKILL)$/i;
const SIGKILL_NAME_TOKEN = /^(?:9|KILL|SIGKILL)$/i;

function extractKillCommandWordFromTokens(tokens: string[]): string {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? '')) i++;
  if (tokens[i] === 'env') {
    let j = i + 1;
    if (tokens[j] === '-i') j++;
    while (j < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[j] ?? '')) j++;
    if (j < tokens.length) i = j;
  }
  const first = tokens[i] ?? '';
  const exe = /^\//.test(first) ? (first.split('/').pop() ?? first) : first;
  return exe.toLowerCase();
}

/**
 * True when a `kill` operand after the optional single signal spec is `0` (own
 * process group), `-1` (every process the user owns) or `-<pgid>` (a group).
 */
function killTargetsProcessGroup(tokens: string[]): boolean {
  const start = tokens.findIndex((t) => (t.split('/').pop() ?? t).toLowerCase() === 'kill');
  if (start < 0) return false;
  let i = start + 1;
  const first = tokens[i] ?? '';
  if (first === '-s' || first === '-n' || first === '--signal') i += 2;
  else if (first.startsWith('-') && first !== '--') i += 1;
  if (tokens[i] === '--') i += 1;
  return tokens.slice(i).some((t) => t === '0' || /^-\d+$/.test(t));
}

/**
 * Return true when the bash command is a `kill` / `pkill` invocation using
 * a SIGKILL-class signal, or a `kill` aimed at a process group / every process.
 * Default SIGTERM forms on explicit PIDs return false.
 */
export function isDestructiveKillCommand(command: string, normalizedFirstWord?: string): boolean {
  const tokens = shellTokenize(command.trim());
  const cmdWord = (normalizedFirstWord ?? extractKillCommandWordFromTokens(tokens)).toLowerCase();
  if (cmdWord !== 'kill' && cmdWord !== 'pkill') return false;
  if (cmdWord === 'kill' && killTargetsProcessGroup(tokens)) return true;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] ?? '';
    if (SIGKILL_SHORT_TOKEN.test(t)) return true;
    if (SIGKILL_LONG_EQ_TOKEN.test(t)) return true;
    if ((t === '-s' || t === '--signal') && i + 1 < tokens.length) {
      if (SIGKILL_NAME_TOKEN.test(tokens[i + 1] ?? '')) return true;
    }
  }
  return false;
}
