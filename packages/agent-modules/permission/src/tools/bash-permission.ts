/**
 * Bash tool permission implementation.
 *
 * Handles command splitting, multi-type rule matching (exact / prefix / wildcard),
 * safety verification, and sandbox assessment.
 *
 * Reference: permission_design.md §5.1
 */

import path from 'node:path';
import os from 'node:os';
import { logger } from '../host-utils.js';
import type { PermissionDecision, PermissionRule, SubcommandResult } from '../types.js';
import {
  DESTRUCTIVE_STANDALONE_COMMANDS,
  LOCAL_SCRIPT_INTERPRETERS_RE,
  PIPE_TO_SHELL_PATTERN,
  SUBCOMMAND_DANGEROUS_PATTERNS,
  allPipeToShellAreInlineLiteralC,
  hardBlockedCategoryIsFinalDeny,
  matchHardBlockedBash,
  matchSecretReadForm,
} from '../classifier/dangerous-patterns.js';
import { SAFE_BASH_FIRST_WORDS, isDestructiveKillCommand } from './bash-safe-first-words.js';
import { shellTokenize, shellTokenizeWithMetadata } from './shell-tokenize.js';
import { isTempDirectory, pathInAllowedWorkingPath, pathInWorkingPath } from './fs-permission.js';
import { hasWritten } from '../written-files-registry.js';
import type { BashCheckContext } from './bash-context.js';
import {
  parseShellRule,
  compileShellRule,
  matchShellRule,
  matchWildcardPattern,
  type CompiledShellPermissionRule,
} from './bash-rule-match.js';
import {
  bashCommandIsSafe,
  checkDangerousPatterns,
  commandHasExecutedHeredocBody,
  getShellPermissionCheckSurface,
} from './bash-safety-scan.js';
import { commandHasIoRedirect, evaluateWriteTarget } from './bash-write-target.js';
import { pureReadFirstWord, formatHardBlockedBashReason } from './bash-fast-allow.js';
import { detectSlowCommand } from './slow-command-scan.js';
import { parseWindowsNativeDelete } from './windows-native-delete.js';
import { resolvePermissionPath, type PermissionPathResolutionContext } from '../path-resolver.js';
import type { PathValue, ShellFamily } from '../permission-core.js';

// ---------------------------------------------------------------------------
// Rule parsing
// ---------------------------------------------------------------------------
// Command splitting
//
// `splitCommand` and `stripLeadingShellKeyword` live in `bash-split.ts` —
// extracted to keep this module under the 2000-line pre-commit block.
// Re-exported here so existing callers (and unit tests) keep importing
// from `bash-permission.ts` without churn. New code should import from
// `bash-split.ts` directly to make the dependency explicit.
// ---------------------------------------------------------------------------

import { splitCommand } from './bash-split.js';
import {
  consumeShellWrapperPrefix,
  stripTransparentWrappersForRuleMatch,
  unwrapCommandWrappers,
} from './bash-wrapper-unwrap.js';

/**
 * Whole-command separator-to-script matcher used by the SOFT remote-execution
 * pre-scan in {@link evaluateBashStatic}. Compiled once at module load instead
 * of per-call to avoid pinning the regex hot path inside the per-subcommand
 * loop.
 *
 * Uses {@link LOCAL_SCRIPT_INTERPRETERS_RE} so the pre-scan recognises
 * scripting interpreters (`; node ./build.mjs`, `&& python script.py`)
 * symmetrically with the shells (`; bash <script>`). The local-script
 * relaxation downstream uses {@link extractLocalScriptArg} +
 * {@link isAllowableLocalScript} on whatever script-token follows the
 * interpreter, so the gate stays interpreter-agnostic. PIPE_TO_SHELL_PATTERN
 * covers the `<curl> | <interpreter>` shape; this one covers the separator
 * shape (`<sep> <interpreter> <script>`).
 */
const SEPARATOR_TO_SCRIPT_RE = new RegExp(
  `[;&|]\\s*(?:sudo\\s+)?(?:${LOCAL_SCRIPT_INTERPRETERS_RE})\\s+(?!-)(\\S[^;&|]*)`,
  'i',
);

/**
 * Bypass-mode delete-verb sniff.
 *
 * A QUOTE-BLIND matcher for anything that looks like a destructive
 * delete command at a shell command position. In bypass mode, HARD
 * final-deny already catches the shapes we can positively identify
 * with row-anchored regex (rmdir/rd with drive-letter or /s,
 * del/erase/Remove-Item after a separator) plus what wrapper unwrap
 * exposes. The residual attack surface — PS aliases, .NET direct call,
 * mid-compound delete verbs — cannot be reliably classified without a
 * shell-parser-level quote-aware analyser.
 *
 * Position-aware anchoring: `(?:^|[;&|]\s*)` matches delete verbs only
 * at string start or after a shell separator (`;`, `&`, `|`). This
 * eliminates false positives from branch names (`feat/rm-old-api`),
 * paths (`/tmp/rm-test/`), word-internal matches (`terraform`,
 * `model`), git subcommand arguments (`git worktree remove`), and
 * string literals (`git commit -m "remove foo"`). The `\b` right-side
 * anchor prevents partial-word suffix matches (`alarm`, `preload`).
 *
 * Accepted gaps: patterns that rely on `unwrapCommandWrappers` to
 * expose the inner verb (positional PS -Command without flag, deeply
 * nested escaped quotes) may miss when the unwrapper can't parse them.
 * HARD patterns cover the most dangerous shapes upstream.
 *
 * Only triggers under `mode === 'bypass'` in `checkBashPermissionCommand`;
 * default / auto modes are unaffected.
 */
const BYPASS_DELETE_VERB_SNIFF =
  /(?:^|[;&|`]\s*|[$]\(\s*)(?:rm|ri|rmdir|rd|del|erase|remove-item|remove)\b|\[(?:System\.)?IO\.(?:File|Directory(?:Info)?)\]::Delete\b/i;

/**
 * Tokens that, when they appear after the first word and are the ONLY
 * remaining tokens, mark a bash invocation as a pure help/version request.
 * Case-sensitive: `--HELP` is not GNU/POSIX and we don't extend the
 * carve-out to it.
 *
 * `help` (no dashes) covers subcommand-style help dispatchers
 * (`cargo help`, `git help log`). The latter has TWO trailing tokens
 * (`help log`) and is intentionally NOT covered by the gate — the gate
 * only matches when EVERY post-first token is in this set.
 */
const HELP_FLAG_TOKENS: ReadonlySet<string> = new Set([
  '--help',
  '-h',
  '--version',
  '-V',
  '-v',
  '-?',
  'help',
]);

/**
 * Return true when the whole command is a literal `<cli> [<help-flag>...]`
 * shape with no IO redirect, no command substitution, and no shell
 * separator that could smuggle a side command. See {@link evaluateBashStatic}
 * step 0d for the full rationale.
 *
 * Exported only via the module's internal step 0d caller — kept as a
 * pure-function helper so the unit tests can exercise the boundary
 * directly without spinning up the full {@link evaluateBashStatic}
 * pipeline.
 */
function isHelpFlagOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;

  // Defense-in-depth: reject any shell metacharacter shape that could
  // chain a second command past the fast-allow. splitCommand already
  // shreds these into separate subcommands, but we check the raw text
  // here so the whole-command gate only fires on the literal shape.
  if (
    trimmed.includes('$(') ||
    trimmed.includes('`') ||
    trimmed.includes('&&') ||
    trimmed.includes('||') ||
    trimmed.includes(';') ||
    trimmed.includes('|')
  ) {
    return false;
  }

  // Reject IO redirect on the whole command (`cmd --help > /etc/passwd`).
  // The fast-allow path does not consult `ctx`, so any redirect — even one
  // targeting a write-authorized location — bails out of the carve-out and
  // lets the per-subcommand evaluator make the decision.
  if (commandHasIoRedirect(trimmed)) return false;

  const tokens = shellTokenize(trimmed);
  if (tokens.length < 2) return false;

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i] ?? '';
    if (!HELP_FLAG_TOKENS.has(tok)) return false;
  }
  return true;
}

// Re-export so existing consumers (tests, classifier) keep their imports.
export { splitCommand, stripLeadingShellKeyword } from './bash-split.js';
export { parseShellRule, matchShellRule, matchWildcardPattern };

// Re-export safety scan helpers — moved to ./bash-safety-scan.ts.
export { bashCommandIsSafe, checkDangerousPatterns, getShellPermissionCheckSurface };

// ---------------------------------------------------------------------------
// Shell quoting / tokenization helpers
// ---------------------------------------------------------------------------

// Re-export so existing consumers (which import shellTokenize from this
// module — e.g. unit tests) keep working without churn. New consumers
// should import from './shell-tokenize.js' directly.
export { shellTokenize };

/**
 * Safely quote a string for shell usage.
 * Uses single quotes (which prevent all interpretation except `'` itself).
 * Safe characters are left unquoted for readability.
 */
export function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9_./:@=,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// rm command detection helpers
// ---------------------------------------------------------------------------

/**
 * Check if a command is an `rm` command (first word is `rm`, optionally
 * prefixed by transparent wrappers like `nohup` / `setsid -f` / `timeout 30`).
 * Returns false for `rmdir`, `grep rm`, etc. Also false for privilege
 * wrappers (`sudo rm`, `bash -c "rm..."`) — those route through the
 * dangerous-pattern sweep instead of the safe rewrite path.
 *
 * Also returns false for LEGACY_DELETE_BYPASS shapes that intentionally
 * smuggle past the safe rewrite by relying on shell-level alias / path
 * tricks (`\rm`, `/bin/rm`, `busybox rm`). shellTokenize transparently
 * un-escapes `\rm` → `rm`, so a source-level pre-check is required
 * BEFORE the tokenizer.
 */
export function isRmCommand(command: string): boolean {
  const trimmed = command.trim();
  // Source-level bypass detection — must run before shellTokenize since
  // the tokenizer un-escapes backslash and would mask the bypass.
  if (RM_BYPASS_SOURCE_PATTERN.test(trimmed)) return false;
  return findRmTokenIndex(shellTokenize(trimmed)) !== -1;
}

// Matches the LEGACY_DELETE_BYPASS shapes the dangerous-pattern sweep
// catches: backslash escape (`\rm`), absolute-path forms (`/bin/rm`,
// `/sbin/rm`, `/usr/bin/rm`, `/usr/sbin/rm`, `/usr/local/bin/rm`,
// `/usr/local/sbin/rm`), and wrapper-smuggle aliases (`busybox rm`,
// `command rm`, `env [...] rm`). Tokenization mask these — keep the
// scan on the raw source string.
const RM_BYPASS_SOURCE_PATTERN =
  /(?:^|\s)(?:\\rm\b|\/(?:bin|sbin|usr\/bin|usr\/sbin|usr\/local\/bin|usr\/local\/sbin)\/rm\b|busybox(?:\s+--)?\s+rm\b|command(?:\s+--)?\s+rm\b|env(?:\s+-\w+)*\s+rm\b)/;

/**
 * Return the token index of `rm` after stripping leading transparent
 * wrappers, or -1 when the command doesn't have `rm` as its effective
 * first word. Used by both {@link isRmCommand} and {@link parseRmTargets}
 * so they agree on where the rm invocation starts.
 *
 * Strictly matches LITERAL `rm` — not `/bin/rm`, not `\rm`, not `rmdir`.
 * Absolute-path and escape-prefixed forms are intentional LEGACY_DELETE_BYPASS
 * attempts and must keep falling through to the dangerous-pattern sweep
 * (which routes them to ask) instead of going through the safe rewrite.
 */
function findRmTokenIndex(tokens: readonly string[]): number {
  if (tokens.length === 0) return -1;
  const innerIdx = consumeShellWrapperPrefix(tokens, 0);
  return tokens[innerIdx] === 'rm' ? innerIdx : -1;
}

const RM_TARGET_STOP_TOKENS: ReadonlySet<string> = new Set([
  '&&',
  '||',
  ';',
  '|',
  '<',
  '>',
  '<<',
  '<<-',
  '>>',
  '&>',
  '&>>',
]);

function tokenStopsRmTargetScan(token: string): boolean {
  return RM_TARGET_STOP_TOKENS.has(token) || /^(?:\d+)?[<>]/.test(token);
}

/**
 * Parse file/directory targets from an `rm` command, skipping flags.
 * Handles quoted paths correctly (e.g. `rm "my file.txt"` → `['my file.txt']`).
 * Also skips any leading transparent wrappers (`nohup`, `setsid -f`,
 * `timeout 30`, ...) so `setsid rm -rf X` resolves the targets the same
 * way as bare `rm -rf X`.
 */
export function parseRmTargets(
  command: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  return parseRmTargetsWithMetadata(command, platform).map((t) => t.value);
}

/**
 * Metadata-preserving variant of {@link parseRmTargets}: returns each
 * target with a `quoted` flag indicating whether the original token was
 * wrapped in single quotes, double quotes, OR contained a backslash
 * escape anywhere.
 *
 * The extra flag is needed by callers that want to make shell-aware
 * decisions downstream — most notably `buildTrashCommand`, which needs
 * to know whether a leading `~` / `$HOME` should be HOME-expanded
 * (unquoted → expand; quoted → literal, matching bash semantics).
 *
 * NB: any quote layer flips `quoted` to true. Bash's actual expansion
 * rules distinguish single from double quotes for `$` — `"$HOME"`
 * expands, `'$HOME'` does not — but we conservatively refuse to expand
 * for either. Cost: a rare `rm "$HOME/x"` invocation ends up passing
 * literal `$HOME/x` to the trash script (which will emit the "cannot
 * resolve" error instead of silently doing the right thing). Benefit:
 * a `rm '~/legit-literal-file'` never gets wrongly rerouted to the
 * user's home. Conservative-and-correct beats liberal-and-wrong.
 */
export function parseRmTargetsWithMetadata(
  command: string,
  platform: NodeJS.Platform = process.platform,
): Array<{ value: string; quoted: boolean }> {
  return parseRmCommand(command, platform).targets;
}

/** Preserve force and literal FD redirects without evaluating shell expressions. */
export function parseRmCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): {
  targets: Array<{ value: string; quoted: boolean }>;
  force: boolean;
  redirects: string[];
} {
  const shellTokens = shellTokenizeWithMetadata(command);
  const tokens = shellTokens.map((token) => token.value);
  const rmIdx = findRmTokenIndex(tokens);
  if (rmIdx === -1) return { targets: [], force: false, redirects: [] };
  const targets: Array<{ value: string; quoted: boolean }> = [];
  let pastDoubleDash = false;
  let force = false;
  const redirects: string[] = [];

  // Start AFTER the rm token (wrappers + rm itself are already stripped).
  for (let i = rmIdx + 1; i < tokens.length; i++) {
    const token = tokens[i] ?? '';
    const tokenMeta = shellTokens[i];
    const quoted = tokenMeta?.quoted ?? false;
    // -- ends option parsing, not shell redirection parsing. Only copy literal
    // descriptor redirects; this does not re-enable variable/command expansion.
    if (!quoted && /^(?:\d+)?[<>]&(?:\d+|-)$/.test(token)) {
      redirects.push(token);
      continue;
    }
    if (!pastDoubleDash && !quoted && tokenStopsRmTargetScan(token)) break;
    if (token === '--') {
      pastDoubleDash = true;
      continue;
    }
    if (!pastDoubleDash && token.startsWith('-')) {
      if (token === '--force') force = true;
      else if (token === '--interactive' || token.startsWith('--interactive=')) force = false;
      else if (!token.startsWith('--')) {
        for (const flag of token.slice(1)) {
          if (flag === 'f') force = true;
          else if (flag === 'i' || flag === 'I') force = false;
        }
      }
      continue; // skip flags
    }
    let value = token;
    if (tokenMeta) {
      let rawToken = command.slice(tokenMeta.start, tokenMeta.end);
      if (rawToken.length >= 2) {
        const first = rawToken[0];
        const last = rawToken[rawToken.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
          rawToken = rawToken.slice(1, -1);
        }
      }
      // shellTokenize follows POSIX escape rules and therefore turns
      // `C:\Users\me` into `C:Usersme`. Windows PowerShell/CMD treat those
      // backslashes as path separators, so preserve the raw token for a
      // drive/UNC-shaped target before building the mavis-trash rewrite.
      if (
        /^(?:[A-Za-z]:[\\/]|\\\\(?:\?\\)?)/.test(rawToken) ||
        (platform === 'win32' && rawToken.includes('\\'))
      ) {
        value = rawToken;
      }
    }
    targets.push({ value, quoted });
  }

  // Dynamic operands still use the existing literal-quoting rewrite. Passing
  // -f for them would hide failed expansion as a successful deletion.
  const staticTargets =
    targets.length > 0 &&
    targets.every(
      ({ value }) => !/[$`*?[\]{}]/.test(value) && !value.includes('<(') && !value.includes('>('),
    );
  return { targets, force: force && staticTargets, redirects };
}


/**
 * Resolve a shell-level HOME reference in an rm target to the runtime's
 * supplied home directory (defaults to `os.homedir()`). Handles the three common forms an agent
 * may emit — `~/foo`, bare `~`, and `$HOME/foo` / `${HOME}/foo` — before
 * the target gets single-quoted by `buildTrashCommand`.
 *
 * **Why here, not in the trash script**: `buildTrashCommand` wraps each
 * target in single quotes so paths with spaces / special characters
 * survive shell parsing. Single quotes disable ALL shell expansion,
 * including `~` and `$HOME`. Both POSIX bash and Windows PowerShell /
 * Git Bash single-quote a literal `~`; the trash script then either
 * silently fabricates a wrong absolute path (bash `cd` fallback) or
 * reports a bogus missing-file (Node `path.resolve` on Windows). The
 * fix has to happen BEFORE quoting — in the permission-layer rewrite —
 * so downstream sees an absolute path it can trust.
 *
 * **Cross-platform**: `os.homedir()` returns `/Users/x` on POSIX and
 * `C:\Users\x` on Windows. Absolute paths in either form survive
 * single-quoting under bash, Git Bash and PowerShell (the three shells
 * the bash tool spawns; see coding-agent's shell resolver).
 *
 * **Not covered** (intentional, out of MR scope):
 * - `~user/` (other-user home) — requires reading `/etc/passwd`; rare.
 * - Windows-native `%USERPROFILE%\...` — agent rarely emits it, and
 *   POSIX-style `$HOME` is already covered which is what LLMs typically
 *   generate.
 */
export function resolveHomeInTarget(target: string, homeDir = os.homedir()): string {
  const pathApi = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(homeDir) ? path.win32 : path;
  if (target === '~') return homeDir;
  if (target.startsWith('~/')) {
    return pathApi.join(homeDir, target.slice(2));
  }
  // NB: these string literals contain a literal `${...}` — the eslint
  // `no-template-curly-in-string` rule assumes any `${...}` inside a
  // regular quote is a typo for a template literal, but here we are
  // matching the shell's own `${HOME}` syntax, which really is a plain
  // string on the JS side.
  // eslint-disable-next-line no-template-curly-in-string
  if (target === '$HOME' || target === '${HOME}') return homeDir;
  if (target.startsWith('$HOME/')) {
    return pathApi.join(homeDir, target.slice('$HOME/'.length));
  }
  // eslint-disable-next-line no-template-curly-in-string
  if (target.startsWith('${HOME}/')) {
    // eslint-disable-next-line no-template-curly-in-string
    return pathApi.join(homeDir, target.slice('${HOME}/'.length));
  }
  return target;
}

/** Resolve each rm operand using quote metadata from the parser that accepted it. */
export function resolveRmCommandPaths(
  command: string,
  context: PermissionPathResolutionContext = {},
  shell: ShellFamily = 'unknown',
): PathValue[] {
  const native = shell === 'powershell' ? parseWindowsNativeDelete(command, shell) : undefined;
  const targets =
    native?.targetTokens ??
    parseRmTargetsWithMetadata(
      command,
      shell === 'cmd' || shell === 'powershell' ? 'win32' : undefined,
    );
  return targets.map((target) => resolveRmTargetPath(target, context, shell));
}

/** Resolve an rm operand without losing the parser's quote/escape contract. */
export function resolveRmTargetPath(
  target: { value: string; quoted: boolean },
  context: PermissionPathResolutionContext = {},
  shell: ShellFamily = 'unknown',
): PathValue {
  const expanded =
    !target.quoted && context.homeDir
      ? resolveHomeInTarget(target.value, context.homeDir)
      : target.value;
  // Prefix a shell-protected tilde with ./ so the generic path resolver sees
  // a literal cwd-relative name. Quoted $HOME retains its conservative dynamic
  // classification; do not evaluate it or reinterpret the parser's metadata.
  const literal =
    target.quoted && (expanded === '~' || expanded.startsWith('~/')) ? `./${expanded}` : expanded;
  return {
    ...resolvePermissionPath(literal, context, shell),
    raw: target.value,
    ...(expanded !== target.value ? { resolution: 'home' as const } : {}),
  };
}

/**
 * Build a mavis-trash command that replaces an `rm` invocation.
 *
 * Accepts either a bare `string[]` of targets (legacy signature; each
 * target is treated as UNQUOTED and eligible for HOME expansion — this
 * preserves the pre-quote-aware behavior for existing callers) OR the
 * richer `Array<{ value, quoted }>` from
 * {@link parseRmTargetsWithMetadata}, where the `quoted` flag prevents
 * HOME expansion for shell-protected literals.
 *
 * The quote-aware overload is the one production code should reach for
 * — it fixes the codex-flagged bug where `rm '~/foo'` would wrongly
 * expand `~` to the user's home despite the single quotes marking `~`
 * as a literal in bash.
 */
export function buildTrashCommand(
  trashBinPath: string,
  targets: string[] | Array<{ value: string; quoted: boolean }>,
  force = false,
): string {
  if (targets.length === 0) return trashBinPath;
  // Normalise: string[] input is treated as all-unquoted (preserves the
  // pre-metadata call behaviour of always attempting HOME expansion).
  const normalised: Array<{ value: string; quoted: boolean }> = targets.map((t) =>
    typeof t === 'string' ? { value: t, quoted: false } : t,
  );
  const resolved = normalised.map(({ value, quoted }) =>
    quoted ? value : resolveHomeInTarget(value),
  );
  const shellQuoted = resolved.map((t) => shellQuote(t));
  // Always insert `--` so filenames starting with `-` are not mistaken for flags.
  return `${trashBinPath}${force ? ' -f' : ''} -- ${shellQuoted.join(' ')}`;
}

// ---------------------------------------------------------------------------
// Main permission check
// ---------------------------------------------------------------------------

/**
 * Re-export {@link BashCheckContext} so consumers (unit tests,
 * external callers) keep importing it from `bash-permission.ts`. New
 * code should import directly from `./bash-context.js`.
 */
export type { BashCheckContext } from './bash-context.js';

// Tokens we hard-bail on when scanning for a local script argument.
// `-` opens a bash flag (`-c`, `--rcfile`), `://` opens a URL,
// `<(` opens a process substitution. All three break the "we know what
// the script is" guarantee that local-script relaxation depends on.
const BASH_SCRIPT_TOKEN_HARD_BAIL_RE = /^(?:-|<\(|[a-z][a-z0-9+.-]*:\/\/)/i;

/**
 * Return true when a path token holds shell metacharacters that prevent
 * static resolution at permission-check time. Mirrors the dynamic-shape
 * bail used by `isWriteAuthorizedTarget` but limited to what `source` /
 * `.` arguments can legitimately contain — variables, command/process
 * substitution, and globs all evade resolution and MUST disable the
 * deterministic local-allow gate, falling back to SOFT pre-scan ask.
 */
function sourcePathHasDynamicShape(token: string): boolean {
  if (token.includes('$')) return true; // $VAR, ${VAR}, $(...)
  if (token.includes('`')) return true; // backtick command substitution
  if (/[*?[\]]/.test(token)) return true; // glob metachars
  if (token.includes('<(') || token.includes('>(')) return true; // process subst
  return false;
}

/**
 * Extract the literal target path of a `source <path>` / `. <path>`
 * subcommand, but ONLY when the path is statically resolvable (no shell
 * expansion). Returns undefined otherwise so the caller can fall back
 * through SOFT pre-scan instead of taking the deterministic-allow path.
 *
 * Returns undefined when:
 *   - The first token is not `source` or `.`
 *   - There is no second token (path argument missing)
 *   - The first character after `.` is non-whitespace (e.g. `./script` is
 *     a relative-path executable, NOT a dot-source — the POSIX rule is
 *     `.` MUST be followed by whitespace before its argument)
 *   - The path token contains `$VAR` / `${VAR}` / `$(...)`, backticks,
 *     glob metachars `*?[]`, or process substitution `<(` / `>(` —
 *     all of which evade static path resolution
 *
 * The returned token is the unquoted literal (`shellTokenize` strips
 * outer quotes). Resolution against the workspace + writtenFiles
 * registry happens in {@link isAllowableLocalScript}; this extractor
 * stays pure to keep the dynamic-shape rejection list reviewable in one
 * place.
 */
export function extractSourceTarget(command: string): string | undefined {
  const trimmed = command.trim();
  if (trimmed.length === 0) return undefined;

  // Disambiguate `./script` (relative-path exec) from `. <path>` (dot-
  // source). POSIX requires whitespace between `.` and its argument; the
  // check has to run on the raw text BEFORE tokenisation because
  // shellTokenize collapses adjacent runs of non-whitespace into one
  // token (so `./script` vs `. script` already differ in token shape but
  // the first char of the trimmed input is the cleanest disambiguator).
  if (trimmed.startsWith('.') && trimmed.length > 1) {
    const afterDot = trimmed[1]!;
    if (!/\s/.test(afterDot)) return undefined;
  }

  const tokens = shellTokenize(trimmed);
  if (tokens.length < 2) return undefined;
  const head = tokens[0];
  if (head !== 'source' && head !== '.') return undefined;
  const target = tokens[1]!;
  if (sourcePathHasDynamicShape(target)) return undefined;
  return target;
}

/**
 * Given a bash invocation like `bash /tmp/foo.sh some-arg` or
 * `bash ./build.sh`, extract the script path token (the first non-flag,
 * non-URL, non-process-substitution argument). Returns `undefined` when
 * the bash call is interactive (`bash`), uses `-c`, points at a URL, etc.
 *
 * Note: this returns the **raw token** — it can be an absolute path
 * (`/tmp/foo.sh`), a relative path (`./build.sh` / `scripts/setup.sh`),
 * or a bare basename (`build.sh`). Resolution against the working
 * directory and the on-disk existence check happen inside
 * {@link isAllowableLocalScript} so this extractor stays pure.
 */
function extractLocalScriptArg(rest: string): string | undefined {
  const tokens = shellTokenize(rest.trim());
  for (const token of tokens) {
    if (!token) continue;
    if (BASH_SCRIPT_TOKEN_HARD_BAIL_RE.test(token)) return undefined;
    return token;
  }
  return undefined;
}

/**
 * Return true when `<separator> bash <script>` should be treated as a
 * local-script invocation instead of remote execution.
 *
 * Conditions (all required):
 *   1. The script token resolves (absolute, or relative to the working
 *      directory) to a real on-disk file
 *   2. The resolved path is either inside a temp dir, inside the working
 *      dir / allowed working dirs, or already in the session's
 *      written-files registry
 *
 * Relative paths (`./build.sh`, `scripts/setup.sh`, bare `build.sh`) are
 * resolved against `bashCtx.workingDirectory` — we know the agent's cwd,
 * so there's no reason to force the agent to spell out absolute paths.
 */
function isAllowableLocalScript(
  scriptToken: string,
  bashCtx: BashCheckContext | undefined,
): boolean {
  if (!bashCtx) return false;
  let resolved: string;
  try {
    resolved = path.isAbsolute(scriptToken)
      ? path.resolve(scriptToken)
      : path.resolve(bashCtx.workingDirectory ?? process.cwd(), scriptToken);
  } catch {
    return false;
  }

  if (!bashCtx.isFile?.(resolved)) return false;

  if (isTempDirectory(resolved)) return true;
  if (bashCtx.workingDirectory && pathInWorkingPath(resolved, bashCtx.workingDirectory)) {
    return true;
  }
  if (
    bashCtx.allowedWorkingPaths &&
    bashCtx.allowedWorkingPaths.length > 0 &&
    pathInAllowedWorkingPath(resolved, bashCtx.allowedWorkingPaths)
  ) {
    return true;
  }
  if (hasWritten(bashCtx.sessionId, resolved)) return true;
  return false;
}

type CompiledBashPermissionRule = {
  rule: PermissionRule;
  parsedRule?: CompiledShellPermissionRule;
};

function compileBashPermissionRules(bashRules: PermissionRule[]): CompiledBashPermissionRule[] {
  return bashRules.map((rule) => {
    const content = rule.ruleValue.ruleContent;
    return content ? { rule, parsedRule: compileShellRule(content) } : { rule };
  });
}

/**
 * Return true when EVERY subcommand of the pipeline (`splitCommand`) is
 * independently covered by a user `allow` rule. Used by Step 0c to skip
 * the SOFT pipe-to-shell pre-scan when the user has already authorised
 * both sides of the pipe individually — e.g. `glab api:*` + `python3:*`
 * already cover `glab api ... | python3 -c "..."` and the redundant
 * ASK is pure friction.
 *
 * Matching mirrors Step 5 of {@link evaluateSingleSubcommand}:
 *   - Bare `bash` allow rule (no `ruleContent`) matches every subcommand.
 *   - Otherwise we try the literal subcommand AND the wrapper-stripped
 *     form (`stripTransparentWrappersForRuleMatch`) so `pnpm:*` covers
 *     `nohup pnpm install` on either side of the pipe.
 *
 * Returns false when:
 *   - there are no `allow` rules,
 *   - `splitCommand` produced zero subcommands (defensive — shouldn't
 *     happen for a command that already matched the pipe-to-shell or
 *     separator-to-script regex, but we bail safely if it does), OR
 *   - any subcommand has no matching `allow` rule.
 *
 * Safety floor: the exemption ONLY short-circuits the whole-command
 * SOFT pre-scan. The per-subcommand evaluator downstream still runs
 * HARD final-deny (step 3), HARD sensitive-read (step 4), user-allow
 * (step 5), SUBCOMMAND_DANGEROUS (step 6), and the per-subcommand SOFT
 * pre-scan (step 7). HARD final-deny across the WHOLE command is also
 * already checked by step 0b BEFORE us, so a `wget ... | sh` whose
 * shape is HARD final-deny (LEGACY_ENCODING_BYPASS etc.) is denied
 * before this exemption can run. The exemption can therefore never
 * relax a category stronger than SOFT pipe-to-shell.
 */
function allSubcommandsMatchUserAllowRule(command: string, bashRules: PermissionRule[]): boolean {
  const allowRules = bashRules.filter((r) => r.ruleBehavior === 'allow');
  if (allowRules.length === 0) return false;
  const subcommands = splitCommand(command);
  if (subcommands.length === 0) return false;

  for (const subcmd of subcommands) {
    const wrapperStripped = stripTransparentWrappersForRuleMatch(subcmd);
    let matched = false;
    for (const rule of allowRules) {
      // Bare bash allow rule (no ruleContent) — matches every subcommand.
      // Mirrors Step 5's bare-rule semantics so the exemption stays
      // consistent with what the per-subcommand evaluator would decide.
      if (!rule.ruleValue.ruleContent) {
        matched = true;
        break;
      }
      const parsed = parseShellRule(rule.ruleValue.ruleContent);
      if (
        matchShellRule(subcmd, parsed) ||
        (wrapperStripped && matchShellRule(wrapperStripped, parsed))
      ) {
        matched = true;
        break;
      }
    }
    if (!matched) return false;
  }
  return true;
}

/**
 * Permission evaluation mode for {@link evaluateBashStatic}.
 *
 *   - `default`: classical user-prompt mode. Ambiguous / unclassified
 *     commands return `ask` so the user is asked to confirm.
 *   - `auto`: YOLO mode. Ambiguous / unclassified commands return
 *     `undecided`, signalling the caller to
 *     fall through to the cloud LLM gate.
 *   - `bypass`: bypass-permissions mode. Common-layer gates (user deny,
 *     user ask, HARD final-deny) still fire; everything else is allowed.
 *     The HARD sensitive-read gate is intentionally skipped — bypass is
 *     an explicit user decision and the user accepts that risk.
 */
export type EvaluationMode = 'default' | 'auto' | 'bypass';

/**
 * Result returned by {@link evaluateBashStatic}.
 *
 * `verdict`:
 *   - `allow`: command is allowed (final).
 *   - `ask`: command requires user confirmation (final, both default + auto).
 *   - `deny`: command is blocked (final).
 *   - `undecided`: only emitted in `auto` mode. The caller (the
 *     cloud LLM gate) treats this as "fall through to the cloud LLM gate".
 *     `checkBashPermission` (default mode) normalises `undecided` → `ask`.
 *
 * `reason` mirrors {@link PermissionDecision.reason} so callers can
 * propagate structured rationale to engine / UI / telemetry.
 */
export interface BashEvaluationResult {
  verdict: 'allow' | 'ask' | 'deny' | 'undecided';
  reason: PermissionDecision['reason'];
}

/**
 * Unified per-command static bash permission evaluator. Single source of
 * truth for default / auto / bypass mode evaluation. Layered policy:
 *
 *   COMMON (every mode):  1. user deny → deny  2. user ask → ask  3. HARD final-deny → deny
 *   BYPASS EARLY-EXIT:    common did not match → allow
 *   DEFAULT / AUTO (per subcommand):
 *     4. HARD sensitive-read  → ask (default) / undecided (auto → LLM)
 *     5. user allow           → allow
 *     6. SUBCOMMAND_DANGEROUS → ask (default) / undecided (auto → LLM)
 *     6.5 source-local-allow  → allow when target literal path is in
 *                                temp / workspace / writtenFiles
 *     7. SOFT pre-scan        → ask (default) / undecided (auto → LLM)
 *     8. rm rewrite           → allow (rewrites to mavis-trash even with
 *                                $() / backticks / brace expansion — trash
 *                                is recoverable, nothing is destroyed)
 *     9. fast-allow first word → allow
 *   TAIL: default → ask;  auto → undecided (→ cloud LLM gate)
 *
 * Whole-command pre-checks (DESTRUCTIVE_STANDALONE_COMMANDS, HARD final-deny,
 * SOFT pipe-to-shell) run BEFORE per-subcommand evaluation because they
 * span shell separators.
 */
export function evaluateBashStatic(
  command: string,
  rules: PermissionRule[],
  bashCtx: BashCheckContext | undefined,
  mode: EvaluationMode,
): BashEvaluationResult {
  const bashRules = rules.filter((r) => r.ruleValue.toolName === 'bash');
  const compiledBashRules = compileBashPermissionRules(bashRules);
  let splitCommandCache: string[] | undefined;
  const getSubcommands = (): string[] => {
    splitCommandCache ??= splitCommand(command);
    return splitCommandCache;
  };
  let unwrappedCommandCache: string[] | undefined;
  const getUnwrappedCommandCandidates = (): string[] => {
    unwrappedCommandCache ??= unwrapCommandWrappers(command);
    return unwrappedCommandCache;
  };

  // Auto-enrich bashCtx with `writeAllowRules` derived from the same rules
  // list when the caller didn't pre-populate (tests / the classifier).
  const derivedWriteAllowRules = rules.filter(
    (r) => r.ruleValue.toolName === 'write' && r.ruleBehavior === 'allow',
  );
  const enrichedCtx: BashCheckContext = {
    ...(bashCtx ?? {}),
    writeAllowRules: bashCtx?.writeAllowRules ?? derivedWriteAllowRules,
    topLevelSegmentCount: getSubcommands().length,
  };

  // Whole-command logging helper (per-subcommand evaluator has its own).
  // Emits structured fields so consumers can grep by layer / mode / verdict.
  const cmdPreview =
    command.length > 200 ? `${command.slice(0, 200)}…(+${command.length - 200})` : command;
  const logWholeLayer = (
    layer: string,
    verdict: 'allow' | 'ask' | 'deny' | 'undecided',
    category: string | undefined,
    extras: Record<string, unknown> = {},
  ): void => {
    logger.info(
      {
        permLayer: layer,
        permMode: mode,
        permVerdict: verdict,
        permCategory: category,
        permScope: 'whole-command',
        cmdPreview,
        sessionId: bashCtx?.sessionId,
        ...extras,
      },
      `[permission] whole-command layer=${layer} mode=${mode} verdict=${verdict}`,
    );
  };

  // ===================================================================
  // STEP 0 (whole-command): catastrophic standalone commands
  //
  // Catastrophic standalone commands (rm -rf /, rm -rf ~, rm -rf *, and
  // the fork-bomb glyph `:(){ :|:& };:`) MUST be DENIED outright —
  // they are deterministic safety boundaries
  // and have no legitimate use. Check BEFORE splitCommand because some
  // of these (notably the fork bomb) contain shell separators (`;` and
  // `|`) that would shred them into meaningless subcommand fragments.
  //
  // These are unbypassable: even bypass mode cannot allow them, because
  // the user opted into bypass for productivity, not to nuke their disk.
  // ===================================================================
  const trimmedLower = command.trim().toLowerCase();
  if (DESTRUCTIVE_STANDALONE_COMMANDS.has(trimmedLower)) {
    logWholeLayer('catastrophic-standalone', 'deny', 'catastrophic-standalone');
    const reasons = new Map<string, SubcommandResult>();
    reasons.set(trimmedLower, {
      behavior: 'deny',
      reason: {
        type: 'safetyCheck',
        description: `Blocked: catastrophic command has no recoverable safe use case. Command: ${trimmedLower}`,
        category: 'catastrophic-standalone',
      },
    });
    return { verdict: 'deny', reason: { type: 'subcommandResults', reasons } };
  }

  // ===================================================================
  // STEP 0b (whole-command): HARD final-deny pre-scan
  //
  // `encoding-bypass` (base64-decode piped to shell, source /dev/stdin)
  // spans shell separators or pipes and would be hidden from
  // per-subcommand HARD checks if we split the command first. Run it
  // BEFORE splitCommand so the full pipeline form is matched verbatim.
  //
  // Non-final HARD categories (sensitive-read, irrecoverable-delete with
  // ASK semantics, ...) are still handled per-subcommand below so
  // compound commands attribute the verdict to the right subcommand.
  // ===================================================================
  const recoverableWindowsDelete =
    !bashCtx?.nativeDelete &&
    bashCtx?.platform === 'win32' &&
    (bashCtx.shellFamily === 'cmd' || bashCtx.shellFamily === 'powershell')
      ? parseWindowsNativeDelete(command, bashCtx.shellFamily)
      : undefined;
  for (const candidate of getUnwrappedCommandCandidates()) {
    const hardHit = matchHardBlockedBash(getShellPermissionCheckSurface(candidate), {
      nativeDelete: bashCtx?.nativeDelete,
      recoverableWindowsDelete: Boolean(recoverableWindowsDelete),
    });
    if (!hardHit) continue;
    if (!hardBlockedCategoryIsFinalDeny(hardHit.category)) continue;
    logWholeLayer('hard-final-deny-prescan', 'deny', hardHit.category);
    const wholeCommandKey = command.trim();
    const reasons = new Map<string, SubcommandResult>();
    reasons.set(wholeCommandKey, {
      behavior: 'deny',
      reason: {
        type: 'safetyCheck',
        description: formatHardBlockedBashReason(
          command.trim(),
          hardHit.category,
          hardHit.description,
        ),
        category: hardHit.category,
      },
    });
    return { verdict: 'deny', reason: { type: 'subcommandResults', reasons } };
  }

  // ===================================================================
  // STEP 0c (whole-command): SOFT remote-execution pre-scan
  //
  // pipe-to-shell shapes (`curl|bash`, `wget|sh`, env/sudo/command/exec
  // wrappers) span shell separators or pipes. splitCommand would shred
  // them into safe-looking subcommands (`curl https://...` + `bash`),
  // hiding the dangerous combination. Pre-scan the unwrapped whole
  // command so:
  //   - default mode prompts the user with an accurate "pipe to shell"
  //     reason (instead of generic "no matching rule")
  //   - auto mode routes the same shape through the cloud LLM gate
  //
  // Local-script exception: when the matched shape is `<sep> bash <script>`
  // (no pipe) AND `<script>` is an existing file inside a temp directory,
  // the working directory, or the session's writtenFiles registry, fall
  // through to per-subcommand handling. True remote-execution still ASKs.
  //
  // User-allow exemption: when EVERY subcommand of the pipeline is
  // independently covered by a user `allow` rule, also fall through —
  // the user explicitly authorised both sides and the per-subcommand
  // evaluator will issue the corresponding `allow` verdicts downstream.
  // Hard policy (catastrophic-standalone, HARD final-deny) and per-
  // subcommand HARD sensitive-read / SUBCOMMAND_DANGEROUS still apply,
  // so this can never relax a category stronger than SOFT pipe-to-shell.
  //
  // Skipped in bypass mode: the user explicitly opted in.
  // ===================================================================
  if (mode !== 'bypass') {
    // Compute the user-allow exemption ONCE before the candidate loop.
    // It depends on `command` (we split the original, not the unwrapped
    // candidates) and matches the per-subcommand evaluator's view of
    // the pipeline, so the result is constant across candidates.
    const userAllowExempt = allSubcommandsMatchUserAllowRule(command, bashRules);

    for (const candidate of getUnwrappedCommandCandidates()) {
      const permissionSurface = getShellPermissionCheckSurface(candidate);
      const pipeMatch = PIPE_TO_SHELL_PATTERN.test(permissionSurface);
      const sepMatch = pipeMatch ? null : permissionSurface.match(SEPARATOR_TO_SCRIPT_RE);

      if (!pipeMatch && !sepMatch) continue;

      if (!pipeMatch && sepMatch) {
        const rest = sepMatch[1] ?? '';
        const scriptToken = extractLocalScriptArg(rest);
        if (scriptToken && isAllowableLocalScript(scriptToken, bashCtx)) {
          logger.info(
            {
              permLayer: 'soft-prescan-relaxed',
              permMode: mode,
              permScope: 'whole-command',
              scriptToken,
              cmdPreview,
              sessionId: bashCtx?.sessionId,
            },
            `[permission] SOFT pre-scan relaxed: local script ${scriptToken} (temp/workspace/written)`,
          );
          continue;
        }
      }

      // Inline `-c <quoted-literal>` relaxation: when every pipe-to-interp
      // match is `... | <interp> -c '<literal>'` (or `"..."` containing no
      // `$`/backtick), stdin is data and the program is a fixed argv
      // string. This is the safe shape for `glab api ... | python3 -c ...`
      // and `... | jq` style pipelines. Raw `... | bash` / `... | python`
      // still ASK (stdin IS the program).
      if (pipeMatch && allPipeToShellAreInlineLiteralC(permissionSurface)) {
        logger.info(
          {
            permLayer: 'soft-prescan-relaxed',
            permMode: mode,
            permScope: 'whole-command',
            relaxation: 'pipe-to-inline-interpreter-c',
            cmdPreview,
            sessionId: bashCtx?.sessionId,
          },
          `[permission] SOFT pre-scan relaxed: inline -c literal (stdin is data, not code)`,
        );
        continue;
      }

      // User-allow exemption: when splitCommand(command) yields subcommands
      // each individually covered by a `bash` user-allow rule (mirrors Step 5
      // matching: matchShellRule + stripTransparentWrappersForRuleMatch +
      // bare bash allow), fall through to the per-subcommand evaluator.
      // Do not apply it when a heredoc body is piped to a shell: after
      // splitting, the heredoc owner no longer carries the `| bash` context
      // that tells safety scans the body is executable code.
      if (userAllowExempt && !(pipeMatch && commandHasExecutedHeredocBody(candidate))) {
        logger.info(
          {
            permLayer: 'soft-prescan-relaxed-user-allow',
            permMode: mode,
            permScope: 'whole-command',
            pipeMatch,
            sepMatch: !!sepMatch,
            cmdPreview,
            sessionId: bashCtx?.sessionId,
          },
          '[permission] SOFT pipe-to-shell pre-scan relaxed: every subcommand matches a user allow rule',
        );
        continue;
      }

      const verdict = mode === 'auto' ? 'undecided' : 'ask';
      logWholeLayer('soft-prescan-pipe-to-shell', verdict, 'pipe-to-shell', {
        pipeMatch,
        sepMatch: !!sepMatch,
      });
      const wholeCommandKey = command.trim();
      const reasons = new Map<string, SubcommandResult>();
      reasons.set(wholeCommandKey, {
        behavior: 'ask',
        reason: { type: 'safetyCheck', description: 'pipe to shell' },
      });
      return {
        verdict,
        reason: { type: 'subcommandResults', reasons },
      };
    }
  }

  // ===================================================================
  // STEP 0d (whole-command): bare `<cli> [--help|--version|...]` fast-allow
  //
  // GNU/POSIX convention: any binary's `--help` / `-h` / `--version` / `-V`
  // / `-v` / `-?` / `help` subcommand prints info to stdout and exits with
  // no side effects. Routing every unknown-first-word help/version request
  // through the cloud LLM gate burns tokens on a class of commands that have no
  // legitimate destructive interpretation.
  //
  // Conditions (whole command must satisfy all):
  //   1. Tokenises to ≥ 2 tokens.
  //   2. Every token after the first is in the help-flag set
  //      ({--help, -h, --version, -V, -v, -?, help}).
  //   3. No IO redirect on the whole command — `cmd --help > /etc/passwd`
  //      still asks because the redirect is the destructive surface.
  //   4. No shell metacharacters that smuggle an additional command:
  //      `$(`, backtick, `&&`, `||`, `;`, `|`. splitCommand already
  //      handles `&&` / `||` / `;` / `|` by routing them to the per-
  //      subcommand loop, but we check here as defense-in-depth so the
  //      whole-command fast-allow only fires on a literal `<cli>
  //      <help-flag>` shape.
  //
  // Threat-model note: we deliberately do NOT check whether the first
  // word is a known CLI. `--help` on an unrecognised binary is the same
  // shape as `--help` on a known one; if a malicious CLI implements its
  // `--help` flag to delete the disk, the threat lives in "the binary
  // exists on PATH at all", not in our gate. Subcommand-graded danger
  // (`git push --force --help`) is still caught downstream because step 6
  // SUBCOMMAND_DANGEROUS runs before any first-word fast-allow.
  //
  // Skipped in bypass mode: the user explicitly opted in.
  // ===================================================================
  if (mode !== 'bypass') {
    if (isHelpFlagOnlyCommand(command)) {
      const trimmed = command.trim();
      const firstWord = trimmed.split(/\s+/)[0] ?? '';
      logWholeLayer('fast-allow-help-flag', 'allow', 'helpFlagFastAllow', { firstWord });
      const reasons = new Map<string, SubcommandResult>();
      reasons.set(trimmed, {
        behavior: 'allow',
        reason: {
          type: 'safetyCheck',
          description: `Help/version flag fast-allow: \`${firstWord} <help-flag>\` has no side effects.`,
          category: 'helpFlagFastAllow',
        },
      });
      return {
        verdict: 'allow',
        reason: { type: 'subcommandResults', reasons },
      };
    }
  }

  // ===================================================================
  // Per-subcommand evaluation
  // ===================================================================
  const subcommands = getSubcommands();
  if (subcommands.length === 0) {
    logWholeLayer('empty-command', 'allow', undefined);
    return {
      verdict: 'allow',
      reason: { type: 'subcommandResults', reasons: new Map() },
    };
  }

  const results = new Map<string, SubcommandResult>();
  let aggregated: 'allow' | 'ask' | 'deny' | 'undecided' = 'allow';

  for (const subcmd of subcommands) {
    const sub = evaluateSingleSubcommand(subcmd, compiledBashRules, mode, enrichedCtx);
    // The persisted SubcommandResult.behavior is 'allow' | 'ask' | 'deny'
    // — collapse 'undecided' → 'ask' for storage (default-mode equivalent).
    results.set(subcmd, {
      behavior: sub.verdict === 'undecided' ? 'ask' : sub.verdict,
      reason: sub.reason,
    });

    // Aggregator: deny > undecided > ask > allow.
    // - 'deny' is final (early-out).
    // - 'undecided' beats 'ask' because in auto mode we want LLM to see
    //   the ambiguous subcommand even when another subcommand is plainly
    //   ask-decisive. The LLM evaluates the WHOLE command for context.
    // - 'ask' beats 'allow'.
    if (sub.verdict === 'deny') {
      aggregated = 'deny';
      break;
    }
    if (sub.verdict === 'undecided') {
      aggregated = 'undecided';
    } else if (sub.verdict === 'ask' && aggregated !== 'undecided') {
      aggregated = 'ask';
    }
  }

  logWholeLayer('aggregated', aggregated, undefined, {
    subcommandCount: subcommands.length,
  });

  return {
    verdict: aggregated,
    reason: { type: 'subcommandResults', reasons: results },
  };
}

/**
 * Per-subcommand evaluator. See {@link evaluateBashStatic} for the layered
 * policy. Returns the raw verdict including `undecided` for auto-mode
 * callers; default-mode callers normalise `undecided` → `ask`.
 */
function evaluateSingleSubcommand(
  command: string,
  bashRules: CompiledBashPermissionRule[],
  mode: EvaluationMode,
  bashCtx?: BashCheckContext,
): { verdict: 'allow' | 'ask' | 'deny' | 'undecided'; reason: SubcommandResult['reason'] } {
  // Logging helper: emit a `[permission]` structured event per layer hit
  // (layer + optional pattern category + mode flow into pino structured
  // fields). Command preview is truncated to keep multi-KB payloads out of
  // logs.
  const logLayer = <
    T extends {
      verdict: 'allow' | 'ask' | 'deny' | 'undecided';
      reason: SubcommandResult['reason'];
    },
  >(
    layer: string,
    result: T,
    extras: Record<string, unknown> = {},
  ): T => {
    const cmdPreview =
      command.length > 200 ? `${command.slice(0, 200)}…(+${command.length - 200})` : command;
    logger.info(
      {
        permLayer: layer,
        permMode: mode,
        permVerdict: result.verdict,
        permCategory:
          result.reason.type === 'safetyCheck' && 'category' in result.reason
            ? result.reason.category
            : undefined,
        permReasonType: result.reason.type,
        cmdPreview,
        ...extras,
      },
      `[permission] subcommand layer=${layer} mode=${mode} verdict=${result.verdict}`,
    );
    return result;
  };

  let unwrappedCache: string[] | undefined;
  const getUnwrappedCandidates = (): string[] => {
    unwrappedCache ??= unwrapCommandWrappers(command);
    return unwrappedCache;
  };
  let permissionSurfaceCache: string[] | undefined;
  const getPermissionSurfaces = (): string[] => {
    permissionSurfaceCache ??= getUnwrappedCandidates().map((candidate) =>
      getShellPermissionCheckSurface(candidate),
    );
    return permissionSurfaceCache;
  };

  // -------- COMMON LAYER --------

  // Every rule behavior sees the same raw and transparent-wrapper-stripped
  // forms. Otherwise a wrapped command could skip deny/ask and match allow.
  const wrapperStrippedCommand = stripTransparentWrappersForRuleMatch(command);
  const matchesUserRule = (parsedRule: CompiledShellPermissionRule | undefined): boolean =>
    !!parsedRule &&
    (matchShellRule(command, parsedRule) ||
      (!!wrapperStrippedCommand && matchShellRule(wrapperStrippedCommand, parsedRule)));

  // Step 1: user deny rule
  for (const { rule, parsedRule } of bashRules) {
    if (rule.ruleBehavior !== 'deny') continue;
    if (!rule.ruleValue.ruleContent) {
      return logLayer('user-deny', { verdict: 'deny', reason: { type: 'rule', rule } });
    }
    if (matchesUserRule(parsedRule)) {
      return logLayer('user-deny', { verdict: 'deny', reason: { type: 'rule', rule } });
    }
  }

  // Step 2: user ask rule
  for (const { rule, parsedRule } of bashRules) {
    if (rule.ruleBehavior !== 'ask') continue;
    if (!rule.ruleValue.ruleContent) {
      return logLayer('user-ask', { verdict: 'ask', reason: { type: 'rule', rule } });
    }
    if (matchesUserRule(parsedRule)) {
      return logLayer('user-ask', { verdict: 'ask', reason: { type: 'rule', rule } });
    }
  }

  const recoverableWindowsDelete =
    !bashCtx?.nativeDelete &&
    bashCtx?.platform === 'win32' &&
    (bashCtx.shellFamily === 'cmd' || bashCtx.shellFamily === 'powershell')
      ? parseWindowsNativeDelete(command, bashCtx.shellFamily)
      : undefined;

  // Step 3: HARD final-deny (per-subcommand)
  // Strip heredoc bodies / non-executed echo-printf data before pattern match
  // so a `cat <<'EOF' ... /etc/shadow ... EOF` MR description body does not
  // get matched as a real read against the sensitive path. Aligned with the
  // STEP 0b whole-command HARD prescan above (line ~877).
  for (const surface of getPermissionSurfaces()) {
    const hardHit = matchHardBlockedBash(surface, {
      nativeDelete: bashCtx?.nativeDelete,
      recoverableWindowsDelete: Boolean(recoverableWindowsDelete),
    });
    if (hardHit && hardBlockedCategoryIsFinalDeny(hardHit.category)) {
      return logLayer('hard-final-deny', {
        verdict: 'deny',
        reason: {
          type: 'safetyCheck',
          description: formatHardBlockedBashReason(command, hardHit.category, hardHit.description),
          category: hardHit.category,
        },
      });
    }
  }

  // Step 3.5: slow-command guard (COMMON layer — runs in default, auto AND
  // bypass modes). Unbounded whole-disk traversals (`find /` with no
  // -maxdepth, `grep -r /`, `du /`, `ls -R /`, Windows `dir /s C:\`) are not
  // dangerous but routinely run for many minutes and surface to the user as a
  // stuck turn. We `deny` outright with a <system-reminder> steering the model
  // to a narrower / faster command.
  //
  // Placed in the COMMON layer (before the bypass early-exit) on purpose: this
  // is a RELIABILITY guard, not a confirmation gate. bypassPermissions relaxes
  // "ask the user", not "let the agent hang for hours" — so the guard must
  // still fire under bypass, exactly like the catastrophic-standalone /
  // HARD-final-deny denies above. A user who genuinely wants a full-disk scan
  // can turn permission mode off. Runs per-subcommand so a compound command
  // attributes the deny to the offending segment.
  const slowHit = detectSlowCommand(command);
  if (slowHit) {
    return logLayer('slow-command', {
      verdict: 'deny',
      reason: {
        type: 'safetyCheck',
        description: `<system-reminder>\n${slowHit.guidance}\n</system-reminder>`,
        category: slowHit.category,
      },
    });
  }

  // -------- BYPASS EARLY-EXIT --------
  // Common layer passed → bypass mode allows. Per the design, bypass does
  // NOT apply the HARD sensitive-read gate (user accepts the risk).
  //
  // EXCEPT: rm → mavis-trash rewrite (step 8 below) is a transformation,
  // not a confirmation gate. bypass relaxes confirmation, NOT
  // recoverability — without this short-circuit, plain `rm -rf <path>`
  // under bypass routes to real disk deletion instead of the recoverable
  // trash, defeating the trash contract documented in step 8.
  // Catastrophic forms (rm -rf /, rm -rf ~, rm -rf *) are already caught
  // by step 3 hard-final-deny above, so by here only non-catastrophic rm
  // reaches us and is safe to rewrite.
  if (mode === 'bypass') {
    if (recoverableWindowsDelete) {
      return logLayer('recoverable-delete-rewrite', {
        verdict: 'allow',
        reason: { type: 'recoverableDeleteRewrite', targets: recoverableWindowsDelete.targets },
      });
    }
    if (!bashCtx?.nativeDelete && isRmCommand(command)) {
      return logLayer('rm-rewrite', {
        verdict: 'allow',
        reason: { type: 'rmRewrite', rewrittenCommand: command },
      });
    }
    // bypass-mode delete-verb guard: HARD final-deny already caught the
    // shapes we can positively identify with quote-aware anchoring
    // (rmdir /s / drive-letter arg, del/erase/Remove-Item at row-start
    // after wrapper unwrap). Everything else that MENTIONS a delete verb
    // — PS aliases rm/ri/remove, .NET direct call [System.IO.File]::Delete,
    // mid-compound `; rmdir`, positional `-Command` payloads, delete
    // verbs inside string literals — falls through HARD because we do
    // not have a shell-parser-level quote-aware analyser (MR #4001
    // trap). In bypass, "auto-run without asking" applied to a possibly-
    // destructive command is exactly the risk profile the user does NOT
    // want; deny with a hint that mavis-trash is the recoverable path.
    //
    // Scan BOTH the raw command AND every unwrapped candidate produced
    // by `unwrapCommandWrappers` (codex CR: EncodedCommand payloads only
    // reveal their delete verb after base64 decode; if we scan only the
    // raw command, `powershell -EncodedCommand <base64(rm C:\...)>`
    // slips through because the raw command is base64 opaque).
    //
    // Deliberately quote-blind and word-boundary-only: false positives
    // (e.g. `git commit -m "remove foo"`) are the accepted cost of a
    // strong ceiling on bypass. Users who need to run a command whose
    // text happens to mention a delete verb can unbypass for that call.
    const bypassSniffTargets = [command, ...unwrapCommandWrappers(command)];
    if (
      !bashCtx?.nativeDelete &&
      !recoverableWindowsDelete &&
      bypassSniffTargets.some((s) => BYPASS_DELETE_VERB_SNIFF.test(s))
    ) {
      return logLayer('bypass-delete-sniff-deny', {
        verdict: 'deny',
        reason: {
          type: 'safetyCheck',
          description:
            'bypass mode does not auto-run delete-like commands. ' +
            'Use `mavis-trash <path>` for recoverable removal, or drop bypass for this call.',
          category: 'bypassDeleteSniff',
        },
      });
    }
    return logLayer('bypass-allow', {
      verdict: 'allow',
      reason: {
        type: 'safetyCheck',
        description: 'bypass mode: passed user deny + user ask + HARD final-deny common layer',
        category: 'bypassAllow',
      },
    });
  }

  // -------- DEFAULT / AUTO LAYER --------

  // Step 4: HARD sensitive-read → ask (default) / undecided (auto → LLM)
  // Same heredoc / echo-printf stripping as Step 3 — otherwise a
  // documentation example like `cat /etc/shadow` inside an MR description
  // heredoc trips sensitive-read even though the body is data, not shell.
  for (const surface of getPermissionSurfaces()) {
    const hardHit = matchHardBlockedBash(surface, {
      nativeDelete: bashCtx?.nativeDelete,
      recoverableWindowsDelete: Boolean(recoverableWindowsDelete),
    });
    if (!hardHit) continue;
    // final-deny already handled in step 3; non-final-deny falls here.
    return logLayer('hard-sensitive-read', {
      verdict: mode === 'auto' ? 'undecided' : 'ask',
      reason: {
        type: 'safetyCheck',
        description: formatHardBlockedBashReason(command, hardHit.category, hardHit.description),
        category: hardHit.category,
      },
    });
  }

  // Step 5: user allow rule, using the same command forms as deny/ask above.
  for (const { rule, parsedRule } of bashRules) {
    if (rule.ruleBehavior !== 'allow') continue;
    if (!rule.ruleValue.ruleContent) {
      return logLayer('user-allow', { verdict: 'allow', reason: { type: 'rule', rule } });
    }
    if (matchesUserRule(parsedRule)) {
      return logLayer('user-allow', { verdict: 'allow', reason: { type: 'rule', rule } });
    }
  }

  // Step 5.5: write-target gate — `sed -i`, `cp <dst>`, `mv <dst>` writing
  // INTO a write-authorized location (workspace / sibling allow-list)
  // short-circuits to allow before the SUBCOMMAND_DANGEROUS pattern can
  // catch them. Out-of-workspace or dynamic targets fall through and the
  // matching SUBCOMMAND_DANGEROUS entry will route to ask.
  const writeTargetVerdict = evaluateWriteTarget(command, bashCtx);
  if (writeTargetVerdict === 'allow') {
    return logLayer('write-target-authorized', {
      verdict: 'allow',
      reason: {
        type: 'safetyCheck',
        description:
          'Write target is inside a write-authorized location (workspace / allowed working path).',
        category: 'writeAuthorizedTarget',
      },
    });
  }

  // Step 6: SUBCOMMAND_DANGEROUS → ask (default) / undecided (auto → LLM)
  for (const { pattern, category } of SUBCOMMAND_DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return logLayer('subcommand-dangerous', {
        verdict: mode === 'auto' ? 'undecided' : 'ask',
        reason: {
          type: 'safetyCheck',
          description: `Subcommand-graded danger: ${category}`,
          category,
        },
      });
    }
  }

  // Step 6b: secret-read forms (env dump / named-credential read) → ask.
  // Matched on the permission SURFACE so echo/printf data and heredoc bodies
  // are already stripped. Defence-in-depth companion to the env sanitizer
  // (bash-tool-optimization.md §2.3): the sanitizer keeps secrets out of the
  // subprocess; this keeps the harvest command itself out of fast-allow.
  for (const surface of getPermissionSurfaces()) {
    const secretReadCategory = matchSecretReadForm(surface);
    if (secretReadCategory) {
      return logLayer('secret-read-form', {
        verdict: mode === 'auto' ? 'undecided' : 'ask',
        reason: {
          type: 'safetyCheck',
          description: `Environment secret read: ${secretReadCategory}`,
          category: 'secret-read',
        },
      });
    }
  }

  // Step 6.5: source / dot-source of a literal local file → allow.
  //
  // `source <path>` and `. <path>` of a path the session itself wrote
  // (writtenFiles registry) or that lives in a temp dir / workspace
  // is a deterministic safe operation: the agent created the env or
  // setup script we're sourcing and we can statically resolve it. Without
  // this step the SOFT pre-scan (step 7) would catch any `source <path>`
  // via `bashCommandIsSafe`'s `^\s*source\s+` pattern and route to
  // `ask` / `undecided`, forcing a cloud LLM round-trip in auto mode
  // for an unambiguously allow-able shape.
  //
  // Dynamic-shape sources (`source $VAR`, `source $(cat /tmp/x)`,
  // `source ~/.bashrc`, glob targets) are NOT relaxed: extractSourceTarget
  // rejects dynamic tokens, and `~/.bashrc` resolves outside the relaxed
  // set so isAllowableLocalScript bails. Those still hit step 7 SOFT
  // pre-scan and ask the user (or route to LLM in auto mode).
  const sourceTarget = extractSourceTarget(command);
  if (sourceTarget && isAllowableLocalScript(sourceTarget, bashCtx)) {
    return logLayer('source-local-allow', {
      verdict: 'allow',
      reason: {
        type: 'safetyCheck',
        description: `Sourcing local file: ${sourceTarget} (temp/workspace/written)`,
        category: 'sourceLocalAllow',
      },
    });
  }

  // Step 7: SOFT pre-scan (per-subcommand) — bashCommandIsSafe + dangerousPatterns
  // Skipped for rm commands (they get rewritten at step 8).
  if (bashCtx?.nativeDelete || (!isRmCommand(command) && !recoverableWindowsDelete)) {
    const safetyIssue = bashCommandIsSafe(command);
    if (safetyIssue) {
      return logLayer('soft-prescan', {
        verdict: mode === 'auto' ? 'undecided' : 'ask',
        reason: { type: 'safetyCheck', description: safetyIssue },
      });
    }

    for (const candidate of getUnwrappedCandidates()) {
      const dangerousMatch = checkDangerousPatterns(candidate, bashCtx);
      if (!dangerousMatch) continue;
      return logLayer('soft-prescan', {
        verdict: mode === 'auto' ? 'undecided' : 'ask',
        reason: {
          type: 'safetyCheck',
          description:
            candidate === command
              ? dangerousMatch
              : `${dangerousMatch} (unwrapped from shell wrapper)`,
        },
      });
    }
  }

  // Step 8: recoverable delete rewrite → allow. Rule deny/ask and every
  // unrelated HARD boundary have already taken precedence above.
  if (recoverableWindowsDelete) {
    return logLayer('recoverable-delete-rewrite', {
      verdict: 'allow',
      reason: { type: 'recoverableDeleteRewrite', targets: recoverableWindowsDelete.targets },
    });
  }

  // Step 8: rm rewrite → allow (always, including dynamic forms).
  //
  // POSIX recoverable deletion is owned by the execution layer: `rm` resolves
  // to the runtime-managed shim, so the sandbox sees an ordinary in-cage
  // delete and enforces `unlinkAllowOnly` in the kernel. Permission therefore
  // stays a pure judgement here — no sandbox-shaped scope gate.
  if (!bashCtx?.nativeDelete && isRmCommand(command)) {
    return logLayer('rm-rewrite', {
      verdict: 'allow',
      reason: { type: 'rmRewrite', rewrittenCommand: command },
    });
  }

  // Step 9: fast-allow first-word
  const firstWord = pureReadFirstWord(command);
  const safe = firstWord && SAFE_BASH_FIRST_WORDS.has(firstWord);
  const sigkill = isDestructiveKillCommand(command, firstWord);
  if (safe && !commandHasIoRedirect(command, bashCtx) && !sigkill) {
    return logLayer(
      'fast-allow-first-word',
      {
        verdict: 'allow',
        reason: {
          type: 'safetyCheck',
          description: `Default fast-allow: first word "${firstWord}" is non-deletion.`,
          category: 'pureReadFastAllow',
        },
      },
      { firstWord },
    );
  }

  // -------- TAIL --------
  return logLayer('tail', {
    verdict: mode === 'auto' ? 'undecided' : 'ask',
    reason: {
      type: 'safetyCheck',
      description: `No matching permission rule for command: ${command}`,
      category: 'noMatchingPermissionRule',
    },
  });
}

/**
 * Check bash command permission against a set of rules (default mode).
 *
 * Thin wrapper around {@link evaluateBashStatic} with mode = 'default'.
 * Undecided verdicts (which can only arise in auto mode) are normalised
 * to `ask` for compatibility with the {@link PermissionDecision}
 * shape, but with `mode='default'` they should not occur.
 *
 * @param command - The full bash command string
 * @param rules - Permission rules filtered for bash tool
 * @param bashCtx - Optional context allowing local-script awareness
 * @returns PermissionDecision with aggregated result and per-subcommand details
 */
export function checkBashPermission(
  command: string,
  rules: PermissionRule[],
  bashCtx?: BashCheckContext,
): PermissionDecision {
  const result = evaluateBashStatic(command, rules, bashCtx, 'default');
  // 'undecided' should not surface in default mode; normalise to 'ask' as a
  // defensive fallback so callers don't have to widen their type unions.
  const behavior = result.verdict === 'undecided' ? 'ask' : result.verdict;
  return { behavior, reason: result.reason };
}

// ---------------------------------------------------------------------------
// Re-exports — implementations moved to focused sibling modules to keep this
// file under the 2000-line pre-commit block. New code should import directly
// from the sibling files.
// ---------------------------------------------------------------------------

export {
  commandHasIoRedirect,
  commandWritesOutsideAuthorizedTarget,
  evaluateWriteTarget,
  isWriteAuthorizedTarget,
} from './bash-write-target.js';
export { pureReadFirstWord, formatHardBlockedBashReason } from './bash-fast-allow.js';
export { consumeShellWrapperPrefix } from './bash-wrapper-unwrap.js';
export { unwrapCommandWrappers };
