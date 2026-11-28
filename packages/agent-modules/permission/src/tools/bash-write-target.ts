/**
 * Bash write-target classification + IO-redirect gate.
 *
 * Extracted from `bash-permission.ts` to keep that module under the
 * 2000-line pre-commit block. Pure functions on shell text — no
 * permission state beyond the {@link BashCheckContext} the caller
 * supplies.
 *
 * Three exports:
 *   1. {@link isWriteAuthorizedTarget} — single source of truth for
 *      "is this path one fs-permission already auto-allows writes to?".
 *      Used by the IO-redirect classifier (cat > file) and the
 *      write-target gate (cp / mv / sed -i / tee).
 *   2. {@link commandHasIoRedirect} — detects `>` / `>>` / `<` / `&>`
 *      / `<&N` / `>&N` redirects and returns true iff ANY destination
 *      lives outside the write-authorized set.
 *   3. {@link evaluateWriteTarget} — for mutating commands whose
 *      destination(s) are statically resolvable, returns 'allow' when
 *      every destination is write-authorized and 'outside' when a literal
 *      destination crosses the write boundary. Anything ambiguous returns
 *      undefined so the SUBCOMMAND_DANGEROUS / SOFT pre-scan still has a
 *      chance to ask.
 */

import path from 'node:path';
import type { BashCheckContext } from './bash-context.js';
import { shellTokenize } from './shell-tokenize.js';
import { pathInAnyWorkingRoot } from './fs-permission.js';

// ---------------------------------------------------------------------------
// Write-authorized path classification
// ---------------------------------------------------------------------------

/**
 * Returns true when the token holds shell metacharacters that cannot be
 * statically resolved into a literal path at permission-check time:
 *   $VAR / ${VAR}, $(...), `...`, glob `*?[`, process substitution
 *   `<(...)` / `>(...)`, home expansion `~/...`.
 *
 * Any gate that takes a redirect / cp / mv / sed -i target MUST run this
 * before resolving the path — otherwise expansion (`$HOME/.bashrc`,
 * `~/.ssh/id_rsa`) gets misclassified as "relative path inside workspace"
 * and silently allowed (security regression caught on MR !1923).
 */
function hasDynamicPathToken(tok: string): boolean {
  return (
    /\$\{?[\w@*]/.test(tok) ||
    tok.includes('$(') ||
    tok.includes('`') ||
    /[*?[]/.test(tok) ||
    tok.startsWith('<(') ||
    tok.startsWith('>(') ||
    tok.startsWith('~')
  );
}

/**
 * POSIX shell discard sinks — a redirect / write to any of these produces
 * no observable filesystem effect (`stderr` → nowhere, `stdout` → nowhere,
 * `tty` → terminal control byte stream), and matching install / build /
 * git / debug idioms rely on them heavily (`cmd 2>/dev/null`, `... < /dev/null`).
 *
 * This set is the SINGLE SOURCE OF TRUTH: {@link isWriteAuthorizedTarget}
 * and any parallel redirect-scanning code path (currently
 * `path-capability.extractRedirectIntents`) MUST both consult it before
 * flagging a redirect target for permission review. When the two paths
 * diverge, common shell forms pop a permission dialog and — worse — the
 * generated suggestion rule becomes `bash(/dev/**)`, which then silently
 * covers `/dev/tcp/<host>/<port>` (reverse-shell) and `/dev/sda*` (block
 * device write) and undermines the corresponding HARD-block registry
 * entries.
 *
 * Not included here (deliberately):
 *  - `/dev/stdin` — a READ source (execute-path / here-string content),
 *    already handled in extractBashPathIntents' source detection.
 *  - `/dev/random` / `/dev/urandom` — random source, not a discard sink;
 *    reading is normal, writing (`> /dev/urandom`) is nonsensical and
 *    should still ASK.
 *  - `/dev/tcp/<host>/<port>` etc. — reverse-shell magic, HARD-blocked
 *    upstream.
 */
export const DISCARD_SINK_TARGETS: ReadonlySet<string> = new Set([
  '/dev/null',
  '/dev/stderr',
  '/dev/stdout',
  '/dev/tty',
]);

/**
 * Test whether `target` is one of {@link DISCARD_SINK_TARGETS}. Callers
 * should invoke this against the pre-resolved absolute path (e.g. after
 * `expandHomeIfKnown` — `~/dev/null` in someone's home is NOT the sink).
 */
export function isDiscardSinkTarget(target: string): boolean {
  return DISCARD_SINK_TARGETS.has(target);
}

/**
 * Classify an absolute or workspace-relative path as a "write-authorized
 * target" — fs-permission considers writes here implicitly allowed, so any
 * bash gate that mutates a file (IO redirect, `sed -i`, `cp` dst, `mv` dst,
 * `tee`, etc.) MUST honour the same set or else the bash channel will ask
 * for paths the Write tool would silently allow.
 *
 * Includes:
 *  - FD merge / close (`>&1`, `>&-`) — no file is written.
 *  - Discard sinks (`/dev/null`, `/dev/stderr`, `/dev/stdout`, `/dev/tty`) —
 *    see {@link DISCARD_SINK_TARGETS} / {@link isDiscardSinkTarget}. Any
 *    parallel redirect-scanning code path (currently
 *    `path-capability.extractRedirectIntents`) MUST also consult this set;
 *    otherwise the two paths diverge and `cmd 2>/dev/null` pops a
 *    permission dialog with `bash(/dev/**)` as its suggested allow rule
 *    (dangerously wide — /dev/tcp reverse-shell / /dev/sda block device
 *    would be silently un-hard-blocked afterwards).
 *  - The agent's `workingDirectory` and any `allowedWorkingPaths` (the
 *    user-selected workspace where fs-permission already auto-allows writes
 *    via `pathInAnyWorkingRoot`).
 *
 * Returns `false` for paths outside this set (e.g. `/etc/passwd`,
 * `~/.bashrc`, `/Users/other/foo`) so the caller can route those to ASK.
 */
export function isWriteAuthorizedTarget(target: string, ctx?: BashCheckContext): boolean {
  if (!target) return false;
  // Statically expand leading `~/` against ctx.homeDir BEFORE the dynamic-
  // shape bail — `~/path` is a pure function of HOME and safe to resolve.
  const expanded = expandHomeIfKnown(target, ctx?.homeDir);
  // Dynamic-shape bail: `$VAR`, `${VAR}`, `$(…)`, backticks, globs, process
  // substitution all evade static path resolution. Without this the
  // workspace-resolve branch would treat them as relative paths inside
  // `ctx.workingDirectory` and silently allow even though shell expansion
  // resolves outside the workspace.
  if (hasDynamicPathToken(expanded)) return false;
  // FD-merge / close-fd: `>&N`, `&-` — no new file written.
  if (/^&\d+$/.test(expanded)) return true;
  if (expanded === '&-') return true;
  // Discard sinks — kept in sync with DISCARD_SINK_TARGETS above.
  if (isDiscardSinkTarget(expanded)) {
    return true;
  }
  // Agent's user-selected workspace and any allowedWorkingPaths siblings —
  // writes there are explicitly authorized. Resolve relative targets
  // against ctx.workingDirectory.
  if (ctx?.workingDirectory) {
    const resolved = path.isAbsolute(expanded)
      ? expanded
      : path.resolve(ctx.workingDirectory, expanded);
    if (pathInAnyWorkingRoot(resolved, ctx.workingDirectory, ctx.allowedWorkingPaths)) {
      return true;
    }
  }
  // User-granted write-tool allow rules — symmetric with the write checker
  // so shell forms don't ASK on destinations the user has already approved.
  // Absolute-only: relative targets are resolved into workspace above; bare
  // basenames have no safe absolute interpretation for glob match.
  if (ctx?.writeAllowRules && ctx.writeAllowRules.length > 0 && path.isAbsolute(expanded)) {
    for (const rule of ctx.writeAllowRules) {
      if (rule.ruleBehavior !== 'allow') continue;
      const ruleContent = rule.ruleValue.ruleContent;
      if (!ruleContent) continue;
      if (matchWriteAllowRulePath(expanded, ruleContent, ctx.homeDir)) {
        return true;
      }
    }
  }
  return false;
}

/** Expand a leading `~` / `~/` against `homeDir`. `~user` is left untouched. */
function expandHomeIfKnown(target: string, homeDir: string | undefined): string {
  if (!homeDir) return target;
  if (target === '~') return homeDir;
  if (target.startsWith('~/')) return path.join(homeDir, target.slice(2));
  return target;
}

/**
 * Glob match an absolute path against a write-tool allow rule's content.
 * Mirrors `fs-permission.matchPathRule` shapes (`/path/**`, `/path/*`,
 * exact). Expands leading `~/` in the rule pattern against `homeDir`.
 */
function matchWriteAllowRulePath(
  target: string,
  ruleContent: string,
  homeDir: string | undefined,
): boolean {
  const pattern = expandHomeIfKnown(ruleContent, homeDir);
  const resolved = path.resolve(target);
  if (pattern.endsWith('/**')) {
    const dir = path.resolve(pattern.slice(0, -3));
    return resolved === dir || resolved.startsWith(dir + path.sep);
  }
  if (pattern.endsWith('/*') && !pattern.endsWith('**')) {
    const dir = path.resolve(pattern.slice(0, -2));
    return path.dirname(resolved) === dir;
  }
  return resolved === path.resolve(pattern);
}

// Back-compat alias for the IO-redirect classifier callers in this file.
const isSafeRedirectTarget = isWriteAuthorizedTarget;

// ---------------------------------------------------------------------------
// IO-redirect gate
// ---------------------------------------------------------------------------

/**
 * Detect any `>` / `>>` / `<` / `&>` IO redirect and return true if the
 * destination lives OUTSIDE the write-authorized set. Output redirects
 * to a system path (`> /etc/foo`) or home-dir dotfile (`> ~/.bashrc`)
 * bails fast-allow so the user is prompted.
 *
 * Quote-aware: ignores `>` / `<` inside single/double quotes.
 */
export function commandHasIoRedirect(command: string, ctx?: BashCheckContext): boolean {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;

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

    // Detect a redirect operator and consume + classify it.
    const next = command[i + 1] ?? '';
    if (ch === '>') {
      let opEnd = i + 1;
      if (next === '>') opEnd = i + 2; // `>>`
      let t = opEnd;
      while (t < command.length && /\s/.test(command[t] ?? '')) t++;
      const target = readRedirectTarget(command, t);
      if (!isSafeRedirectTarget(target, ctx)) return true;
      i = opEnd - 1;
      continue;
    }
    if (ch === '<') {
      if (next === '<') {
        i += command[i + 2] === '<' ? 2 : 1;
        continue;
      }
      let t = i + 1;
      while (t < command.length && /\s/.test(command[t] ?? '')) t++;
      const target = readRedirectTarget(command, t);
      // Input redirect reads a file. Statically-resolvable local-path targets
      // are vetted by the shared path-capability resolver (it emits a `read`
      // intent for `< /path/to/file`). But a DYNAMIC target — `< $FILE`,
      // `< ${VAR}`, `< $(cmd)`, backticks — produces NO path intent (the
      // resolver only sees literal tokens), so trusting the resolver here would
      // let `FILE=~/.ssh/id_rsa; cat < $FILE` slip past the sensitive-read gate
      // via `cat`'s pure-read fast-allow. Fail closed: treat an unresolvable
      // input redirect as IO that bails fast-allow → ASK.
      if (target.includes('$') || target.includes('`')) return true;
      // The "trust the resolver" relaxation above only holds when a downstream
      // path-capability pass actually runs. That pass keys off `ctx`: default /
      // bypass mode (bash-checker) always supplies one and scans the read
      // intent. The CONTEXT-FREE callers — the auto-mode Stage 1 classifier
      // (`evaluateBashStatic(cmd, [], undefined, 'auto')`) and the `--help`
      // fast-allow check — pass NO ctx and never run the resolver, so a static
      // external read like `wc -l < /home/user/secret.txt` would slip past the
      // fast-allow unconfirmed. With no ctx, fall back to the write-authorized
      // safe set as a conservative read-safety proxy: only `/dev/null`-class
      // discard sinks (and FD merges) are provably safe to read without the
      // resolver. Everything else fails closed and bails fast-allow so the
      // command routes to the LLM gate / per-intent ASK instead.
      const hasPathPermissionContext =
        ctx?.workingDirectory !== undefined ||
        ctx?.homeDir !== undefined ||
        ctx?.allowedWorkingPaths !== undefined;
      if (!hasPathPermissionContext && !isSafeRedirectTarget(target, ctx)) return true;
      i = t - 1;
      continue;
    }
    if (ch === '&' && next === '>') {
      const op2 = command[i + 2] === '>' ? i + 3 : i + 2;
      let t = op2;
      while (t < command.length && /\s/.test(command[t] ?? '')) t++;
      const target = readRedirectTarget(command, t);
      if (!isSafeRedirectTarget(target, ctx)) return true;
      i = op2 - 1;
      continue;
    }
  }
  return false;
}

/**
 * Detect only output redirects that write to a target outside the
 * write-authorized set. Input redirects (`< file`) read a file and should not
 * be reported as workspace-external writes.
 */
function commandHasUnauthorizedOutputRedirect(command: string, ctx?: BashCheckContext): boolean {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;

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

    const next = command[i + 1] ?? '';
    if (ch === '>') {
      let opEnd = i + 1;
      if (next === '>') opEnd = i + 2;
      let t = opEnd;
      while (t < command.length && /\s/.test(command[t] ?? '')) t++;
      const target = readRedirectTarget(command, t);
      if (!isSafeRedirectTarget(target, ctx)) return true;
      i = opEnd - 1;
      continue;
    }
    if (ch === '&' && next === '>') {
      const op2 = command[i + 2] === '>' ? i + 3 : i + 2;
      let t = op2;
      while (t < command.length && /\s/.test(command[t] ?? '')) t++;
      const target = readRedirectTarget(command, t);
      if (!isSafeRedirectTarget(target, ctx)) return true;
      i = op2 - 1;
      continue;
    }
  }
  return false;
}

/**
 * Read a redirect target token starting at `start`. Stops at whitespace, `|`,
 * `;`, `<`, `>` (next redirect or pipe), or end of string.
 *
 * `&` only ends the token when it is NOT the FD-merge target form `&<digit>`
 * (e.g. `>&1`, `>&2`). When the target starts with `&` followed by a digit
 * we consume `&\d+` (and optional trailing `-`) as one token.
 */
function readRedirectTarget(command: string, start: number): string {
  let i = start;
  let out = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  // Special case: token starts with `&<digit>` or `&-` — FD-merge / close.
  if (command[i] === '&') {
    if (command[i + 1] === '-') return '&-';
    let j = i + 1;
    while (j < command.length && /\d/.test(command[j] ?? '')) j++;
    if (j > i + 1) return command.slice(i, j);
    // bare `&` — treat as separator (background), not a target.
    return '';
  }

  while (i < command.length) {
    const ch = command[i]!;
    if (escaped) {
      out += ch;
      escaped = false;
      i++;
      continue;
    }
    if (ch === '\\' && !inSingleQuote) {
      escaped = true;
      i++;
      continue;
    }
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      i++;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      i++;
      continue;
    }
    if (!inSingleQuote && !inDoubleQuote) {
      if (/\s/.test(ch)) break;
      if (ch === '|' || ch === ';' || ch === '&' || ch === '<' || ch === '>') break;
    }
    out += ch;
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mutating-command write-target gate
// ---------------------------------------------------------------------------

/**
 * Classify mutating commands (`sed -i`, `cp <dst>`, `mv <dst>`, `tee`) by
 * their destination path(s). When every destination resolves into a
 * write-authorized location, return 'allow' so the gate caller can
 * short-circuit. When a literal destination resolves outside the write
 * boundary, return 'outside' so callers can surface a direct workspace
 * permission ask in auto mode.
 *
 * Returns a concrete verdict only when:
 *   - The command is unambiguously one of the known forms (`sed -i ...`,
 *     `cp [flags] src... dst`, `mv [flags] src... dst`, `tee [-a] files`).
 *   - Every destination token is a literal path (no `$VAR` / `$(...)` /
 *     globs / process substitution) so we can statically resolve it.
 *
 * Anything ambiguous (variables, command substitutions, missing arguments)
 * returns undefined — the caller's SUBCOMMAND_DANGEROUS / SOFT pre-scan
 * still gets a chance to ask.
 */
export function evaluateWriteTarget(
  command: string,
  ctx?: BashCheckContext,
): 'allow' | 'outside' | undefined {
  const joined = command.replace(/\\\r?\n/g, ' ');
  const tokens = shellTokenize(joined.trim());
  if (tokens.length === 0) return undefined;

  // Peel env-var prefix and `env [-i] K=V` envelope so the gate fires on
  // commands like `LANG=C cp src dst`.
  let i = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? '')) i++;
  if (tokens[i] === 'env') {
    let j = i + 1;
    if (tokens[j] === '-i') j++;
    while (j < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[j] ?? '')) j++;
    if (j < tokens.length) i = j;
  }

  const head = tokens[i];
  if (!head) return undefined;
  // Normalise: strip absolute-path basename from a POSIX shell command
  // token so an absolute-path invocation matches the bare name. Shell text
  // is POSIX on every host — this is NOT an OS file-path check.
  const exe = head[0] === '/' ? (head.split('/').pop() ?? head) : head;
  const rest = tokens.slice(i + 1);

  // Reject any rest-token that holds shell metacharacters we can't resolve.
  // Tilde-expand against ctx.homeDir first so a literal `~/` is no longer
  // dynamic (it resolves purely from HOME).
  const expandToken = (t: string): string => expandHomeIfKnown(t, ctx?.homeDir);
  const hasDynamic = (t: string): boolean => hasDynamicPathToken(expandToken(t));

  if (exe === 'sed') {
    // Look for an in-place flag (-i, -iSUFFIX, --in-place, --in-place=SUFFIX).
    let inPlace = false;
    let k = 0;
    const args: string[] = [];
    while (k < rest.length) {
      const t = rest[k]!;
      if (t === '-i' || t.startsWith('-i') || t === '--in-place' || t.startsWith('--in-place')) {
        inPlace = true;
        k++;
        continue;
      }
      if (t === '-e' || t === '-f') {
        // Take the next token as the script / file argument and skip both.
        if (k + 1 < rest.length) k++;
        k++;
        continue;
      }
      if (t === '--') {
        k++;
        // Everything after `--` is positional.
        while (k < rest.length) args.push(rest[k++]!);
        break;
      }
      if (t.startsWith('-')) {
        // Unknown sed flag — be conservative.
        k++;
        continue;
      }
      args.push(t);
      k++;
    }
    if (!inPlace) return undefined; // non-`-i` sed handled by SAFE fast-allow.
    if (args.length < 2) return undefined; // Need at least a script + target.
    // The first positional is the sed script; everything after is target file(s).
    const targets = args.slice(1);
    if (targets.length === 0) return undefined;
    for (const t of targets) {
      if (hasDynamic(t)) return undefined;
      if (!isWriteAuthorizedTarget(t, ctx)) return 'outside';
    }
    return 'allow';
  }

  if (exe === 'cp' || exe === 'mv') {
    // cp / mv flag set is simple enough to whitelist: every leading `-...`
    // token before positionals is a flag. -t <dir> takes a target arg.
    let k = 0;
    const positional: string[] = [];
    while (k < rest.length) {
      const t = rest[k]!;
      if (t === '--') {
        k++;
        while (k < rest.length) positional.push(rest[k++]!);
        break;
      }
      if (t === '-t' || t === '--target-directory') {
        if (k + 1 >= rest.length) return undefined;
        const dir = rest[k + 1]!;
        if (hasDynamic(dir)) return undefined;
        if (!isWriteAuthorizedTarget(dir, ctx)) return 'outside';
        // -t <dir>: every following positional is a source; destination is dir.
        // Sources don't need a write-authorized check (we only read them).
        return 'allow';
      }
      if (t.startsWith('-')) {
        k++;
        continue;
      }
      positional.push(t);
      k++;
    }
    if (positional.length < 2) return undefined;
    const dst = positional[positional.length - 1]!;
    if (hasDynamic(dst)) return undefined;
    if (!isWriteAuthorizedTarget(dst, ctx)) return 'outside';
    return 'allow';
  }

  if (exe === 'tee') {
    // `tee` writes stdin to its file arguments (does NOT use `>` / `<`
    // operators, so the IO-redirect classifier does not see it). Parse the
    // arg list: skip flag tokens (-a / --append, -i / --ignore-interrupts,
    // -p, --help, --version, and any unknown `-...`). The remaining tokens
    // are all destination files; every one must be write-authorized.
    let k = 0;
    const targets: string[] = [];
    while (k < rest.length) {
      const t = rest[k]!;
      if (t === '--') {
        k++;
        while (k < rest.length) targets.push(rest[k++]!);
        break;
      }
      if (t.startsWith('-')) {
        k++;
        continue;
      }
      targets.push(t);
      k++;
    }
    if (targets.length === 0) return undefined; // `tee` with no args = pure stdin echo
    for (const t of targets) {
      if (hasDynamic(t)) return undefined;
      if (!isWriteAuthorizedTarget(t, ctx)) return 'outside';
    }
    return 'allow';
  }

  return undefined;
}

/**
 * True when the command clearly writes to a target outside the selected
 * workspace / approved write paths. Used by the bash checker to bypass the
 * auto-mode LLM gate and show the user a permission prompt instead.
 */
export function commandWritesOutsideAuthorizedTarget(
  command: string,
  ctx?: BashCheckContext,
): boolean {
  if (commandHasUnauthorizedOutputRedirect(command, ctx)) return true;
  return evaluateWriteTarget(command, ctx) === 'outside';
}
