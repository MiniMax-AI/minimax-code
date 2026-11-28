/**
 * Transparent shell-wrapper unwrap for the Step 9 fast-allow gate.
 *
 * Extracted from `bash-permission.ts` to keep that module under the
 * 2000-line pre-commit block. The fast-allow gate keys on the first
 * word of each subcommand; when the leading token is a transparent
 * wrapper (`xargs`, `nohup`, `setsid`, `nice`, `timeout`, `command`,
 * `parallel`, `watch`) the gate must look through to the inner cmd
 * word, otherwise common pipelines like `find … | xargs grep …` or
 * `nohup setsid pnpm install` trip on the wrapper (not in
 * SAFE_BASH_FIRST_WORDS) and fall through to the LLM gate.
 *
 * Also consumed by Step 5 user-allow matching
 * ({@link stripTransparentWrappersForRuleMatch}) so a user-granted
 * `pnpm:*` rule covers `nohup pnpm install`, `timeout 60 pnpm test`,
 * etc. without needing per-wrapper rule pairs.
 *
 * Wrappers that change privilege scope (`sudo` / `doas` / `pkexec`) or
 * process semantics (`exec`) are deliberately NOT handled here:
 *   - sudo is routed to ask by SUBCOMMAND_DANGEROUS regardless of inner
 *   - exec replaces the shell process; side effects extend beyond the
 *     inner command's intrinsic behaviour
 *   - bash -c / sh -c are surfaced separately by unwrapCommandWrappers
 *
 * Wrapper + destructive inner (`xargs rm`, `env rm`, `find -exec rm`,
 * `busybox rm`, …) is caught by SUBCOMMAND_DANGEROUS_PATTERNS / SOFT
 * pre-scan BEFORE the fast-allow step, so stripping here only matters
 * when the inner is itself in SAFE_BASH_FIRST_WORDS.
 *
 * All helpers operate on `shellTokenize`'d input. Conservative on parse
 * failure: malformed / unknown flag shapes return undefined and the
 * caller (consumeShellWrapperPrefix) bails — the wrapper appears as the
 * literal first word and the command falls through to TAIL ask.
 */

import { shellTokenize, shellTokenizeWithMetadata } from './shell-tokenize.js';

/**
 * Strip transparent command-wrapper prefixes from a token array so the
 * fast-allow gate can see the actual inner command word.
 *
 * Caller normally passes `startIdx` pointing at the first non-env-var
 * token (after `K=V` and `env [-i] K=V` stripping). Exported so unit
 * tests can stress wrapper parsing in isolation.
 *
 * Bounded to 4 nested strips to refuse pathological inputs such as
 * `nohup nohup nohup …` chains. Four nested wrappers cover realistic
 * use cases (`timeout 30 nohup nice xargs grep …`).
 */
export function consumeShellWrapperPrefix(tokens: readonly string[], startIdx: number): number {
  let i = startIdx;
  for (let strips = 0; strips < 4 && i < tokens.length; strips++) {
    const head = tokens[i];
    if (!head) return i;
    // Normalise: an absolute-path basename matches the bare command name.
    // Shell text is POSIX on every host — NOT an OS file-path check.
    const exe = head[0] === '/' ? (head.split('/').pop() ?? head) : head;
    let next: number | undefined;
    switch (exe.toLowerCase()) {
      case 'xargs':
        next = consumeXargsPrefix(tokens, i);
        break;
      case 'nohup':
        next = i + 1;
        break;
      case 'setsid':
        // Fork + new session, no FS / network side effects. -f / -w / -c
        // (and long forms) are all booleans — consume them so the inner
        // command word is exposed to subsequent matchers.
        next = consumeValuedShortFlagPrefix(tokens, i + 1, /^$/);
        break;
      case 'command':
        next = consumeCommandBuiltinPrefix(tokens, i);
        break;
      case 'nice':
        next = consumeNicePrefix(tokens, i);
        break;
      case 'timeout':
        next = consumeTimeoutPrefix(tokens, i);
        break;
      case 'parallel':
        next = consumeValuedShortFlagPrefix(tokens, i + 1, PARALLEL_VALUED_SHORT);
        break;
      case 'watch':
        next = consumeValuedShortFlagPrefix(tokens, i + 1, WATCH_VALUED_SHORT);
        break;
      default:
        return i;
    }
    if (next === undefined || next <= i || next >= tokens.length) return i;
    i = next;
  }
  return i;
}

/** Execution identity for Bash safety checks, not the generic fast-allow gate. */
export function consumeBashExecutionPrefix(tokens: readonly string[]): number {
  let start = 0;
  for (let depth = 0; depth < 8; depth++) {
    const next = consumeShellWrapperPrefix(tokens, consumeEnvVarPrefix(tokens, start));
    if (next !== start) {
      start = next;
      continue;
    }
    if (tokens[start] === 'builtin') {
      start++;
      continue;
    }
    if (tokens[start] !== 'exec') return start;
    start++;
    while (tokens[start]?.startsWith('-')) {
      const flag = tokens[start++]!;
      if (flag === '--') break;
      if (/^-[cl]*a$/u.test(flag)) start++;
    }
  }
  return start;
}

// Per-wrapper valued-short flag tables. Members are short flags whose
// VALUE lives in the next token (e.g. `-n 5` → consume both). Long-form
// (`--max-args=N`) is always single-token and falls through the generic
// `-flag` skip in {@link consumeValuedShortFlagPrefix}.
//
// `watch` only has ONE valued short flag: `-n SEC` (interval). Every
// other watch flag (`-d`, `-e`, `-g`, `-b`, `-t`, `-c`, `-x`, `-p`, `-h`)
// is boolean. Tracking just `-n` is enough to avoid the `watch -n 5 ls`
// under-strip false-negative.
//
// `parallel` shares xargs' valued shorts (`-d -E -I -L -n -P -s`) plus
// `-j N` (jobs) and `-N N` (records per cmd). Other flags are boolean.
const XARGS_VALUED_SHORT = /^-[dEILnPs]$/;
const WATCH_VALUED_SHORT = /^-n$/;
const PARALLEL_VALUED_SHORT = /^-[dEIjLNnPs]$/;

function consumeXargsPrefix(tokens: readonly string[], startIdx: number): number | undefined {
  return consumeValuedShortFlagPrefix(tokens, startIdx + 1, XARGS_VALUED_SHORT);
}

function consumeCommandBuiltinPrefix(
  tokens: readonly string[],
  startIdx: number,
): number | undefined {
  // `command [-p]` runs cmd resetting PATH. `-v` / `-V` print the resolved
  // location and do NOT exec — bail so we keep `command` as the literal
  // first word (not in SAFE → TAIL ask).
  let j = startIdx + 1;
  while (j < tokens.length) {
    const t = tokens[j] ?? '';
    if (t === '-v' || t === '-V' || t === '--help' || t === '--version') return undefined;
    if (t === '-p') {
      j++;
      continue;
    }
    if (t === '--') {
      j++;
      break;
    }
    break;
  }
  return j;
}

function consumeNicePrefix(tokens: readonly string[], startIdx: number): number | undefined {
  let j = startIdx + 1;
  while (j < tokens.length) {
    const t = tokens[j] ?? '';
    if (t === '--') {
      // POSIX option-end terminator (GNU `nice` supports it). Mirrors
      // consumeCommandBuiltinPrefix / consumeValuedShortFlagPrefix.
      j++;
      break;
    }
    if (t === '-n' && /^-?\d+$/.test(tokens[j + 1] ?? '')) {
      j += 2;
      continue;
    }
    if (/^-\d+$/.test(t)) {
      j++;
      continue;
    }
    if (/^--adjustment(?:=|$)/.test(t)) {
      if (t.includes('=')) j++;
      else if (/^-?\d+$/.test(tokens[j + 1] ?? '')) j += 2;
      else return undefined;
      continue;
    }
    break;
  }
  return j;
}

function consumeTimeoutPrefix(tokens: readonly string[], startIdx: number): number | undefined {
  let j = startIdx + 1;
  while (j < tokens.length) {
    const t = tokens[j] ?? '';
    if (!t.startsWith('-')) break;
    if (t === '-k' || t === '--kill-after' || t === '-s' || t === '--signal') {
      j += 2;
      continue;
    }
    if (t === '--preserve-status' || t === '--foreground' || t === '-v' || t === '--verbose') {
      j++;
      continue;
    }
    return undefined; // unknown flag — bail rather than mis-skip
  }
  // Duration token: `30`, `30s`, `5m`, `1h`, `0.5s`, `1h30m`, `INF`.
  // GNU coreutils accepts compound forms; permissive numeric/suffix shapes
  // are acceptable because the inner-cmd SAFE check still gates fast-allow.
  const dur = tokens[j] ?? '';
  if (!/^(?:inf|infinity|\d+(?:\.\d+)?[smhd]?(?:\d+[smhd])*)$/i.test(dur)) return undefined;
  return j + 1;
}

function consumeValuedShortFlagPrefix(
  tokens: readonly string[],
  startIdx: number,
  valuedShort: RegExp,
): number | undefined {
  // Skip leading -X / --long flag tokens; consume the value-bearing short
  // flags two tokens at a time so the inner-cmd word is correctly revealed
  // (e.g. `watch -n 5 ls` → inner = `ls`, not `5`). Stops at the first
  // non-flag token. Long-form `--key=val` and bare booleans (`-d`, `-b`)
  // are single-token and fall through the generic skip. POSIX `--`
  // option-end terminator is consumed and stops further flag scanning,
  // matching consumeCommandBuiltinPrefix and most CLI tools.
  let j = startIdx;
  while (j < tokens.length) {
    const t = tokens[j] ?? '';
    if (t === '--') {
      j++;
      break;
    }
    if (!t.startsWith('-')) break;
    if (valuedShort.test(t)) j += 2;
    else j++;
  }
  return j;
}

/**
 * Strip leading transparent shell wrappers and return the inner command
 * as a string suitable for user-rule prefix matching. Returns undefined
 * when no wrapper was present, so the caller can skip the extra
 * rule-match round-trip.
 *
 * Only used by the Step 5 user-allow gate. The SOFT pre-scan,
 * SUBCOMMAND danger scan, and HARD safety checks intentionally see the
 * original command (wrapper + inner) so they can detect `xargs rm`,
 * `nohup curl | bash`, etc.
 *
 * Strip order:
 *   1. POSIX env-var prefix — `KEY=VAL cmd`, `env cmd` (bare),
 *      `env [-i] [--] K=V cmd` — via {@link consumeEnvVarPrefix}.
 *   2. Transparent shell wrappers — `nohup`, `setsid`, `xargs`, `nice`,
 *      `timeout`, `command`, `parallel`, `watch` — via
 *      {@link consumeShellWrapperPrefix}.
 *   3. Absolute-path basename normalisation on the leading inner token
 *      (`/tmp/x/harness-smoke` → `harness-smoke`).
 *
 * Privilege wrappers (`sudo`, `doas`, `pkexec`) and inline-script
 * wrappers (`bash -c "..."`, `sh -c "..."`, `zsh -c "..."`) are NOT
 * stripped — they remain attached to the command so a user-granted
 * `whatever:*` rule cannot silently elevate to `sudo whatever` or
 * smuggle arbitrary script payloads through.
 */
/**
 * Skip leading POSIX env-var assignments. Returns the index of the
 * first non-assignment token. Mirrors the env-var handling in
 * {@link pureReadFirstWord} so wrapper-unwrap and fast-allow share
 * the same strip semantics.
 *
 * Forms recognised:
 *   - `K=V K=V ... cmd`     — bare inline env-var assignment prefix
 *   - `env cmd`             — bare env wrapper, semantically `cmd`
 *   - `env [-i] [--] K=V cmd` — explicit env wrapper with optional
 *      `-i` (clear environment) and `--` (POSIX option-end terminator)
 *
 * Standalone `env` with no following token (which would list the
 * current environment) is NOT advanced past — the index stays at the
 * `env` token and downstream matchers see `env` as the first word.
 *
 * Env-var prefixes are POSIX single-invocation — they affect ONLY the
 * subprocess created for the trailing command, not the surrounding
 * bash tool subprocess (which the bash tool spawns fresh per
 * invocation), so they have zero out-of-process side effects on their
 * own. Whether the trailing command is safe depends on the command
 * itself, not the env-var prefix.
 */
export function consumeEnvVarPrefix(tokens: readonly string[], startIdx: number): number {
  let i = startIdx;
  // Bare K=V K=V ... prefix.
  while (i < tokens.length) {
    const t = tokens[i] ?? '';
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) break;
    i++;
  }
  // `env [-i] [--] [K=V ...] cmd` form. Bare `env cmd` (no -i, no K=V)
  // is semantically equivalent to running `cmd` with the inherited
  // environment, so we still advance past `env` to expose the inner cmd.
  // `env -- cmd` is the POSIX option-end terminator form (used to pass a
  // command whose name starts with `-`); we consume the `--` as a
  // single-token flag and continue scanning for K=V pairs. Standalone
  // `env` with no following token (which would list the environment)
  // keeps `i` at the env token and falls through.
  if (tokens[i] === 'env') {
    let j = i + 1;
    if (tokens[j] === '-i') j++;
    if (tokens[j] === '--') j++;
    while (j < tokens.length) {
      const t = tokens[j] ?? '';
      if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) break;
      j++;
    }
    // Advance past `env [-i] [K=V ...]` as long as at least one trailing
    // command word remains. Pure `env` (no inner cmd) lists the env and
    // is left at the env token.
    if (j < tokens.length) {
      i = j;
    }
  }
  return i;
}

export function stripTransparentWrappersForRuleMatch(command: string): string | undefined {
  const tokens = shellTokenize(command);
  if (tokens.length === 0) return undefined;
  // Strip POSIX env-var prefix first (`KEY=VAL cmd` / `env [-i] K=V cmd`)
  // so a user-granted `harness-smoke:*` rule covers
  // `LLM_API_KEY=sk-... harness-smoke ...`. Env-var prefixes only affect
  // the spawned subprocess of the trailing command; the surrounding bash
  // tool subprocess is fresh per invocation, so they have no
  // out-of-process side effects on their own.
  const afterEnv = consumeEnvVarPrefix(tokens, 0);
  const innerIdx = consumeShellWrapperPrefix(tokens, afterEnv);
  if (innerIdx <= 0 || innerIdx >= tokens.length) return undefined;
  // Normalise absolute-path basename so a user-granted `harness-smoke:*`
  // rule matches both `harness-smoke arg` and `/tmp/x/harness-smoke arg`.
  // POSIX shell text — NOT an OS file-path check; we only consult the
  // basename of the leading token.
  const inner = tokens.slice(innerIdx);
  const head = inner[0] ?? '';
  if (head.length > 0 && head[0] === '/') {
    const basename = head.split('/').pop() ?? head;
    inner[0] = basename;
  }
  // tokens.slice(innerIdx) is enough for prefix/exact match — those compare
  // by leading literal words, and shellTokenize's quote-aware split keeps
  // each argument intact. Re-quoting on `.join(' ')` is unnecessary because
  // matchShellRule only consults the head, not the tail value content.
  return inner.join(' ');
}

/**
 * Unwrap common command wrappers to expose the inner command for safety
 * checks. Handles `[sudo] bash|sh|zsh -c "..."` AND the same shape
 * wrapped in transparent wrappers (`nohup`, `setsid`, `timeout`, ...) so
 * `nohup setsid bash -c "rm -rf /etc"` exposes the rm payload to the
 * HARD safety scan instead of slipping past it.
 *
 * Distinct from {@link consumeShellWrapperPrefix} / {@link stripTransparentWrappersForRuleMatch}:
 * those reveal the inner first word for fast-allow / user-rule matching.
 * This one digs into PRIVILEGE / INLINE-SCRIPT wrappers and exposes the
 * inline payload as an additional candidate string for HARD safety-check
 * pattern matching. Optional transparent-wrapper unwrap is layered on
 * top of the same regex so attackers can't smuggle `bash -c "<payload>"`
 * past the scan by prefixing `nohup` / `setsid -f` / `timeout 30`.
 *
 * Reference: agent-server rules.py `_unwrap_command_wrappers()`
 */
export function unwrapCommandWrappers(command: string): string[] {
  return unwrapShellCommandWrappers(command, false);
}

/** Preserve native interpreter boundaries for callers that only understand Bash. */
export function unwrapBashCommandWrappers(command: string): string[] {
  return unwrapShellCommandWrappers(command, true);
}

function unwrapShellCommandWrappers(command: string, stopAtWindowsShell: boolean): string[] {
  const cmd = command.trim();
  const candidates: string[] = [cmd];
  // Bounded-depth worklist so nested wrappers get exposed too:
  //   cmd /c "powershell -c 'Remove-Item ...'"
  //   bash -c "cmd /c rmdir C:\..."
  //   powershell -c "bash -c 'rm -rf /'"
  // Each cycle attempts (a) the current candidate verbatim against
  // `pushBashCInner` and `pushWindowsShellInner`, then (b) the same
  // matchers on the transparent-wrapper-stripped form. Any NEW
  // candidate added is enqueued for the next depth. 4 levels covers
  // every realistic nesting the model could emit; deeper chains hit
  // the depth cap and stop — the outermost candidate is still in
  // `candidates`, so HARD scan runs on the full chain even if some
  // inner layer wasn't exposed.
  const MAX_UNWRAP_DEPTH = 4;
  const worklist: Array<{ cmd: string; depth: number }> = [{ cmd, depth: 0 }];
  while (worklist.length > 0) {
    const item = worklist.shift();
    if (!item) break;
    if (item.depth >= MAX_UNWRAP_DEPTH) continue;
    const before = candidates.length;
    unwrapOneLevel(item.cmd, candidates, stopAtWindowsShell);
    for (let idx = before; idx < candidates.length; idx += 1) {
      const next = candidates[idx];
      if (next) worklist.push({ cmd: next, depth: item.depth + 1 });
    }
  }
  return candidates;
}

/**
 * Single-level unwrap step: try both POSIX and Windows shell matchers
 * against `cmd` verbatim, then strip transparent prefixes and try
 * again. Pushes any new candidates onto `candidates` (dedup via the
 * caller's `!candidates.includes(...)` check inside each push helper).
 * Called by `unwrapCommandWrappers`'s worklist so nested wrappers get
 * further unwrapped by re-running this on the exposed inner payload.
 */
function unwrapOneLevel(cmd: string, candidates: string[], stopAtWindowsShell = false): void {
  // First try the command verbatim against `[sudo] bash|sh|zsh|... -c`
  // and Windows-shell wrappers (`cmd /c "..."`, `powershell -Command "..."`,
  // etc.). These expose the inner payload so the HARD safety scan applies
  // to the actual delete/dangerous command instead of the outer wrapper —
  // otherwise `cmd /c "rmdir /s /q ..."` slips past the row-anchored
  // windows-delete regexes in HARD_BLOCKED_BASH_PATTERNS.
  pushBashCInner(cmd, candidates, stopAtWindowsShell);
  if (!stopAtWindowsShell) pushWindowsShellInner(cmd, candidates);

  // Then strip leading transparent wrappers (nohup / setsid / timeout / ...)
  // and try the same matchers on the stripped form. Without this the
  // SOFT pre-scan + HARD safety scan miss `nohup bash -c "<payload>"` and
  // `setsid -f bash -c "<payload>"` (security gap flagged on MR !2210
  // Test Agent's adversarial probe). Privilege wrappers (sudo / doas /
  // pkexec) are deliberately NOT stripped by consumeShellWrapperPrefix.
  const shellTokens = shellTokenizeWithMetadata(cmd);
  const tokens = shellTokens.map((t) => t.value);
  if (tokens.length > 0) {
    const innerIdx = consumeShellWrapperPrefix(tokens, consumeEnvVarPrefix(tokens, 0));
    if (innerIdx > 0 && innerIdx < tokens.length) {
      // Slice the RAW source substring from the first non-stripped
      // token to the end of the command so quoted payloads
      // (`nohup bash -c "rm -rf /etc"`) keep their quote grouping —
      // otherwise `tokens.slice(innerIdx).join(' ')` would emit
      // `bash -c rm -rf /etc` (5 tokens), and pushBashCInner's
      // metadata-driven payload extractor would see 5 tokens instead
      // of 3 and pull only `rm` out.
      const innerStartMeta = shellTokens[innerIdx];
      const stripped = innerStartMeta ? cmd.slice(innerStartMeta.start).trim() : '';
      if (stripped && !candidates.includes(stripped)) {
        candidates.push(stripped);
        pushBashCInner(stripped, candidates, stopAtWindowsShell);
        if (!stopAtWindowsShell) pushWindowsShellInner(stripped, candidates);
      }
    }
  }
}

/**
 * POSIX shells recognised as `-c` inline-script wrappers. Both bare
 * command name (`bash -c`) and absolute-path invocation
 * (`/bin/bash -c`, `/usr/local/bin/zsh -c`) hit the same list via
 * basename normalisation. `busybox <shell> -c` is handled separately
 * because busybox needs its second token consumed before the shell
 * name.
 */
const POSIX_SHELL_NAMES: ReadonlySet<string> = new Set([
  'bash',
  'sh',
  'zsh',
  'dash',
  'ksh',
  'fish',
]);

/**
 * Match `[sudo] <shell> -c "<payload>"` where `<shell>` is any POSIX
 * shell in {@link POSIX_SHELL_NAMES}, invoked either as a bare name
 * (`bash -c`) or via an absolute path (`/bin/bash -c`), plus the
 * `busybox sh -c` idiom common on Alpine / OpenWRT / minimal Linux.
 * If matched, push the unwrapped payload onto `candidates`.
 *
 * Uses `shellTokenizeWithMetadata` (not a regex on the raw string) so
 * a payload with Windows-style backslashes (`bash -c "cmd /c rmdir
 * C:\..."` from a WSL cross-shell nest) survives the POSIX tokenizer's
 * escape-strip.
 */
function pushBashCInner(cmd: string, candidates: string[], posixPayload = false): void {
  const payload = readBashInlineScript(cmd, posixPayload);
  if (!payload || (posixPayload && payload.dynamic)) return;
  const script = posixPayload ? payload.script : payload.rawScript;
  if (script && !candidates.includes(script)) candidates.push(script);
}

/** Shared inline-script parsing for Bash wrapper inspection and hard safety. */
export function readBashInlineScript(
  cmd: string,
  posixPayload = true,
): { script: string; rawScript: string; dynamic: boolean } | undefined {
  const shellTokens = shellTokenizeWithMetadata(cmd, true);
  const tokens = shellTokens.map((t) => t.value);
  if (tokens.length < 2) return;

  // Optional `sudo` prefix consumes 1 token. `sudo` itself carries flags
  // (`-u`, `-i`, `-H`, etc.) but callers usually invoke as bare `sudo
  // bash -c ...` — extended `sudo -u user bash -c` is uncommon and not
  // handled here (falls through to no-op if the shape doesn't match).
  let head = posixPayload ? consumeBashExecutionPrefix(tokens) : 0;
  if ((tokens[head] ?? '').toLowerCase() === 'sudo') head++;
  if (head >= tokens.length) return;

  if (posixPayload && tokens[head] === 'eval') {
    const args = shellTokens.slice(head + (tokens[head + 1] === '--' ? 2 : 1));
    const script = args.map((token) => token.value).join(' ');
    return {
      script,
      rawScript: script,
      dynamic: args.some((token) => token.pathSyntax?.dynamic === true),
    };
  }

  const headBasename = (tokens[head]?.split(/[\\/]/).pop() ?? '')
    .replace(/\.exe$/i, '')
    .toLowerCase();

  // Two shapes are supported:
  //   1. Direct shell:      <shell> -c <payload>          → -c at head+1
  //   2. busybox indirect:  busybox <shell> -c <payload>  → -c at head+2
  let cFlagIdx: number;
  if (headBasename === 'busybox') {
    // busybox may be invoked as `busybox sh -c ...` or via a hardlink
    // (`sh` symlinks to busybox). Only the two-word form needs special
    // handling here; the hardlink form is caught by the bare shell
    // match below.
    const nextTok = (tokens[head + 1] ?? '').toLowerCase();
    if (!POSIX_SHELL_NAMES.has(nextTok)) return;
    cFlagIdx = head + 2;
  } else if (POSIX_SHELL_NAMES.has(headBasename)) {
    cFlagIdx = head + 1;
  } else {
    return;
  }
  if (cFlagIdx >= tokens.length - 1) return;

  // Shell startup flags precede the inline command: -lc, -e -c,
  // --noprofile --norc -c, or -o errexit -c. Do not scan past a script
  // filename or the -- option terminator and mistake script args for flags.
  while (cFlagIdx < tokens.length - 1) {
    const flag = tokens[cFlagIdx] ?? '';
    if (flag === '--' || !flag.startsWith('-')) return;
    if (/^-[^-]*c/u.test(flag)) break;
    cFlagIdx += /^(?:-[^-]*[oO]|--rcfile|--init-file)$/u.test(flag) ? 2 : 1;
  }
  if (cFlagIdx >= tokens.length - 1) return;

  // Payload is the single next token (all POSIX `-c` shells take one
  // string argument). Raw substring preserves any Windows-shape content
  // an attacker might nest inside; outer quote peeling handles the
  // typical `bash -c "..."` shape.
  const payloadIdx = cFlagIdx + 1;
  const payloadMeta = shellTokens[payloadIdx];
  if (!payloadMeta) return;
  let rest = cmd.slice(payloadMeta.start, payloadMeta.end).trim();
  if (rest.length >= 2) {
    const first = rest[0];
    const last = rest[rest.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      rest = rest.slice(1, -1);
    }
  }
  rest = rest.trim();
  return {
    script: payloadMeta.value.trim(),
    rawScript: rest,
    dynamic: payloadMeta.pathSyntax?.dynamic === true,
  };
}

/**
 * PowerShell boolean (switch) flags that take NO value argument.
 * When the unwrapper encounters one, it must skip only the flag itself
 * (1 token), NOT the next token — otherwise the actual command payload
 * gets eaten as the flag's "value" and the delete verb never surfaces.
 *
 * Lowercase for case-insensitive comparison.
 */
const PS_BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  '-noprofile',
  '-noninteractive',
  '-nologo',
  '-noexit',
  '-sta',
  '-mta',
]);

/**
 * Match Windows shell wrappers (`cmd /c`, `cmd.exe /c`, `cmd /s /c`,
 * `powershell -Command`, `powershell -c`, `pwsh -c`, and their
 * `-EncodedCommand` obfuscated forms) and, if found, push the unwrapped
 * inner payload onto `candidates`.
 *
 * Motivation — 2026-06-30 data-loss incident: a `bypass`-mode session
 * wrapped `rmdir /s /q "E:\..."` inside `cmd /c "..."`. The Windows-delete
 * regexes in HARD_BLOCKED_BASH_PATTERNS are anchored to `^` or `;&|`, so
 * the `cmd /c ` prefix hid the inner `rmdir` from the HARD scan and the
 * command executed under bypassAllow. Unwrapping cmd /c / powershell -c
 * exposes the inner command as an additional candidate string so the
 * existing hard-deny patterns fire against the actual delete.
 *
 * We deliberately parse via `shellTokenize` (POSIX quoting) rather than a
 * regex on the raw string — the observed payloads use POSIX-style escape
 * for the inner quotes (`cmd /c "rmdir /s /q \"E:\\...\""`) which the
 * tokenizer collapses into a single inner token. If tokenization fails or
 * the shape isn't a recognised Windows shell invocation we bail without
 * mutating candidates; the raw command still hits the regex scan directly.
 */
function pushWindowsShellInner(cmd: string, candidates: string[]): void {
  // shellTokenizeWithMetadata keeps `start` / `end` offsets so we can
  // slice the RAW source substring for the head token. The plain
  // shellTokenize value loses POSIX-escape backslashes ("\a" → "a"), so
  // an absolute-path invocation like
  //   C:\Windows\System32\cmd.exe /c "rmdir /s /q E:\work"
  // would land in `tokens[0]` as `C:WindowsSystem32cmd.exe` — the
  // basename split below would return the whole mangled string and
  // never match `cmd.exe`. Codex CR on MR !4024 flagged that gap: the
  // raw substring restores the backslashes so basename extraction
  // works. Down-stream we still use `tokens[i]` value for flag matching
  // (flags are `-`-prefixed ASCII, no backslashes to worry about).
  const shellTokens = shellTokenizeWithMetadata(cmd);
  const tokens = shellTokens.map((t) => t.value);
  if (tokens.length < 3) return;

  const headMeta = shellTokens[0];
  const headRaw = headMeta ? cmd.slice(headMeta.start, headMeta.end) : (tokens[0] ?? '');
  // If the raw substring was quoted, strip a single layer of wrapping
  // quotes so `"C:\\Windows\\System32\\cmd.exe" /c ...` normalises to
  // the same absolute path as the unquoted form.
  const headForBasename = (() => {
    if (headRaw.length >= 2) {
      const first = headRaw[0];
      const last = headRaw[headRaw.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        return headRaw.slice(1, -1);
      }
    }
    return headRaw;
  })();
  // Basename-normalise absolute paths so `C:\Windows\System32\cmd.exe /c ...`
  // is matched the same as bare `cmd`. Split on either separator.
  const headBasename = headForBasename.split(/[\\/]/).pop() ?? headForBasename;
  const headLower = headBasename.toLowerCase();

  const isCmdExe = headLower === 'cmd' || headLower === 'cmd.exe';
  const isPwsh =
    headLower === 'powershell' ||
    headLower === 'powershell.exe' ||
    headLower === 'pwsh' ||
    headLower === 'pwsh.exe';
  if (!isCmdExe && !isPwsh) return;

  // Walk flags to find the inline-command flag (`/c` or `/k` for cmd,
  // `-Command` / `-c` / `-EncodedCommand` for powershell/pwsh). Everything
  // after this flag is the inline payload; shellTokenize keeps the payload
  // as a single token when it was quoted at invocation time.
  let i = 1;
  let commandFlag: 'plain' | 'encoded' | undefined;
  while (i < tokens.length) {
    const tok = tokens[i] ?? '';
    if (isCmdExe) {
      const tokLower = tok.toLowerCase();
      // `/c` and `/k` both run the inline command; `/s` and `/d` are
      // parsing/AutoRun modifiers that appear before `/c`. Any other
      // flag (`/q`, `/v`, `/e`) is boolean, safe to skip.
      if (tokLower === '/c' || tokLower === '/k') {
        commandFlag = 'plain';
        i++;
        break;
      }
      if (tok.startsWith('/')) {
        i++;
        continue;
      }
      // Non-flag before any `/c` — not a shape we recognise; bail.
      return;
    }
    // powershell / pwsh: only `-Command`, `-c`, and the EncodedCommand
    // family (`-EncodedCommand`, `-enc`, `-encoded`, `-ec`, `-e`) actually
    // carry an inline payload; other flags are consumed. PowerShell CLI
    // accepts any unambiguous prefix of `-EncodedCommand` starting at
    // `-enc` — kept in sync with the `-enc` / `-EncodedCommand` matcher
    // in dangerous-patterns.ts (windows-encoded-command category), so
    // both classifier and unwrap see the same shape. Case-insensitive.
    const tokLower = tok.toLowerCase();
    if (tokLower === '-command' || tokLower === '-c') {
      commandFlag = 'plain';
      i++;
      break;
    }
    if (
      tokLower === '-e' ||
      tokLower === '-ec' ||
      // Any prefix of `-encodedcommand` starting at `-enc` (`-enc`,
      // `-encod`, `-encode`, `-encoded`, `-encodedc`, `-encodedcom`,
      // `-encodedcomm`, `-encodedcomma`, `-encodedcomman`,
      // `-encodedcommand`) is a valid PowerShell abbreviation. Codex CR
      // on MR !4024 flagged that the pre-fix code only knew
      // `-encodedcommand`, `-e`, `-ec` — a `-enc` payload would fall
      // through to the generic `-` flag branch, get its base64 payload
      // "consumed" as an unrelated value, and the encoded delete would
      // never surface for HARD scan.
      (tokLower.length >= 4 &&
        tokLower.startsWith('-enc') &&
        'encodedcommand'.startsWith(tokLower.slice(1)))
    ) {
      commandFlag = 'encoded';
      i++;
      break;
    }
    if (tok.startsWith('-')) {
      // Known boolean flags: consume only the flag itself, not the next
      // token. Without this, `-NoProfile "Remove-Item ..."` treats the
      // command payload as the flag's value and skips it entirely —
      // the delete verb never surfaces for the bypass sniff.
      if (PS_BOOLEAN_FLAGS.has(tokLower)) {
        i++;
        continue;
      }
      // Valued flags (`-File script.ps1`, `-ExecutionPolicy Bypass`) consume
      // the next token. For unrecognized flags, conservatively consume both
      // tokens only if the next token doesn't look like a flag.
      const nextTok = tokens[i + 1] ?? '';
      if (nextTok && !nextTok.startsWith('-')) {
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    // Non-flag token without prior -Command / -EncodedCommand — treat as
    // POSITIONAL command argument. PowerShell binds the first non-flag arg
    // as the -Command value when no explicit flag is given, e.g.
    // `powershell -NoProfile "Remove-Item C:\file.txt"`.
    commandFlag = 'plain';
    break;
  }
  if (commandFlag === undefined || i >= tokens.length) return;

  if (commandFlag === 'encoded') {
    // EncodedCommand payload boundary (Codex CR MR !4024 P1b): only the
    // token IMMEDIATELY after the flag is the base64 payload. Any
    // trailing args are unrelated to PowerShell parsing but if we
    // include them in the payload string, `decodeEncodedCommand`'s
    // strict base64 regex rejects the whole thing and no candidate
    // gets pushed — leaving the outer `powershell -EncodedCommand ...`
    // as the only string HARD sees, which never matches the delete
    // regex. Slice the single next-token substring from the raw source
    // (so backslash-free base64 survives) and peel outer quotes if the
    // token was quoted at invocation.
    const encodedTokenMeta = shellTokens[i];
    if (!encodedTokenMeta) return;
    let encodedRaw = cmd.slice(encodedTokenMeta.start, encodedTokenMeta.end).trim();
    if (encodedRaw.length >= 2) {
      const first = encodedRaw[0];
      const last = encodedRaw[encodedRaw.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        encodedRaw = encodedRaw.slice(1, -1);
      }
    }
    if (!encodedRaw) return;

    // PowerShell expects UTF-16LE base64 (spec) but some callers pass
    // UTF-8. Try both so the HARD scan sees whatever text the attacker
    // embedded.
    const decoded = decodeEncodedCommand(encodedRaw);
    for (const s of decoded) {
      if (s && !candidates.includes(s)) candidates.push(s);
    }
    return;
  }

  // Plain -Command / -c payload: prefer the RAW source substring so
  // Windows-style backslashes survive the POSIX shellTokenize escape-
  // strip. Same class of gap Codex flagged for the head token: joining
  // tokenizer values for `cmd /c rmdir C:\Users\me\empty` would emit
  // `rmdir C:Usersmeempty` as a candidate, and the row-anchored
  // windows-delete regexes rely on `[A-Za-z]:[\\/]` to fire.
  //
  // Two shapes both need the raw slice:
  //   - Single quoted token wrapping the whole payload:
  //       cmd /c "rmdir /s /q E:\path"
  //   - Multi-token payload with individual quoted arguments:
  //       cmd /c rmdir /s /q "E:\proj\src"
  // For the single-quoted case, peel one layer of outer quotes so the
  // inner command is exposed for downstream matching.
  const firstPayloadMeta = shellTokens[i];
  const lastPayloadMeta = shellTokens[shellTokens.length - 1];
  let rawPayload: string;
  if (firstPayloadMeta && lastPayloadMeta) {
    let slice = cmd.slice(firstPayloadMeta.start, lastPayloadMeta.end);
    if (i === shellTokens.length - 1 && slice.length >= 2) {
      const first = slice[0];
      const last = slice[slice.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        slice = slice.slice(1, -1);
      }
    }
    rawPayload = slice.trim();
  } else {
    // Defensive fallback if metadata is unavailable — should never
    // happen because shellTokenizeWithMetadata ran at the top.
    rawPayload = tokens.slice(i).join(' ').trim();
  }
  if (!rawPayload) return;
  if (!candidates.includes(rawPayload)) candidates.push(rawPayload);

  // The incident command places a standalone descriptor merge after one fully
  // quoted cmd payload, followed by a status-check statement. The local hard-
  // safety path splits at `>` before unwrapping, so the source descriptor can
  // reach here as `cmd /c "..." 1`, `2`, or `*`. Keep the normal raw candidate
  // above and additionally expose only that quoted payload for the delete deny.
  if (isCmdExe && firstPayloadMeta) {
    const firstPayload = cmd.slice(firstPayloadMeta.start, firstPayloadMeta.end);
    const trailing = cmd.slice(firstPayloadMeta.end);
    const first = firstPayload[0];
    const last = firstPayload[firstPayload.length - 1];
    const isQuoted =
      firstPayload.length >= 2 &&
      ((first === '"' && last === '"') || (first === "'" && last === "'"));
    const hasSupportedDescriptorRedirect =
      /^\s+(?:2>&1|1>&2|\*>&1)(?:\s*;|\s*$)/.test(trailing) || /^\s+(?:1|2|\*)\s*$/.test(trailing);
    if (isQuoted && hasSupportedDescriptorRedirect) {
      const redirectedPayload = firstPayload.slice(1, -1).trim();
      if (redirectedPayload && !candidates.includes(redirectedPayload)) {
        candidates.push(redirectedPayload);
      }
    }
  }

  // Strip escaped quotes from nested wrappers: `cmd /c "powershell -c
  // \"rm C:\file.txt\""` → inner unwrap yields `\"rm C:\file.txt\"`.
  // Without stripping, the delete verb sits after `\"` instead of at
  // command position, and the position-aware sniff misses it.
  const unescaped = stripEscapedQuotes(rawPayload);
  if (unescaped && unescaped !== rawPayload && !candidates.includes(unescaped)) {
    candidates.push(unescaped);
  }
}

/**
 * Strip one layer of escaped quotes (`\"...\"`  or `\\'...\\'`) from
 * a payload string. Handles nested wrapper output where the outer
 * quote-peel exposed backslash-escaped inner quotes.
 */
function stripEscapedQuotes(s: string): string | undefined {
  const t = s.trim();
  if (t.length < 4) return undefined;
  if (t.startsWith('\\"') && t.endsWith('\\"')) return t.slice(2, -2).trim() || undefined;
  if (t.startsWith("\\'") && t.endsWith("\\'")) return t.slice(2, -2).trim() || undefined;
  return undefined;
}

function decodeEncodedCommand(payload: string): string[] {
  // shellTokenize keeps the value as one token including any wrapping
  // quotes that were escaped. Strip a single layer of wrapping quotes.
  let raw = payload.trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1);
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(raw) || raw.length % 4 !== 0) return [];
  let buf: Buffer;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch {
    return [];
  }
  const results: string[] = [];
  // UTF-16LE is the canonical PowerShell encoding.
  try {
    const utf16 = buf.toString('utf16le');
    if (utf16) results.push(utf16);
  } catch {
    // ignore
  }
  // UTF-8 fallback for lax callers.
  try {
    const utf8 = buf.toString('utf8');
    if (utf8 && !results.includes(utf8)) results.push(utf8);
  } catch {
    // ignore
  }
  return results;
}
