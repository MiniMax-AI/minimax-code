import os from 'node:os';
import path from 'node:path';
import type { ToolCheckResult } from '../engine.js';
import type { ToolPermissionContext } from '../context.js';
import type {
  PathCheckContext,
  PermissionRule,
  PermissionRuleAction,
  PermissionRuleMatcher,
} from '../types.js';
import { getContentRulesForTool, hasWholeToolRule } from '../context.js';
import { matchHardBlockedFsRead } from '../classifier/dangerous-patterns.js';
import { matchesMcpServerRuntimeName } from '../mcp-runtime-name.js';
import { shellTokenize } from './shell-tokenize.js';
import { splitCommand, findHeredocBodyRanges } from './bash-split.js';
import { extractSourceTarget } from './bash-permission.js';
import { isDiscardSinkTarget } from './bash-write-target.js';
import {
  FS_UMBRELLA_TOOL_NAME,
  READ_ONLY_TOOLS,
  isDangerousRemovalPath,
  isPathAllowed,
  isPublicKeyFile,
  isTempDirectory,
  matchPathRule,
} from './fs-permission.js';

export type PathCapabilityAction = 'read' | 'write' | 'delete' | 'execute';

export type PathCapabilityOptions = {
  toolName?: string;
  allowTempWrite?: boolean;
  /**
   * The tool that actually triggered this path check (e.g. `bash`,
   * `apply_patch`, an unknown path-bearing tool). When a path-capability ASK
   * is approved, permission-flow persists the resulting rule under this tool's
   * namespace — NOT the read/write capability namespace this resolver queries.
   * Passing it here lets the resolver honor that previously-approved rule on
   * the next invocation instead of re-prompting forever. Leave unset for the
   * fs tools, whose approvals already persist under the `read`/`write`/`fs`
   * namespaces this resolver consults directly.
   */
  originToolName?: string;
};

export type PathCapabilityIntent = {
  path: string;
  action: PathCapabilityAction;
  relativeBase?: 'home';
};

export function pathActionToToolName(action: PathCapabilityAction): string {
  switch (action) {
    case 'read':
    case 'execute':
      return 'read';
    case 'write':
    case 'delete':
      return 'write';
  }
}

export function evaluatePathCapability(
  filePath: string,
  action: PathCapabilityAction,
  context: ToolPermissionContext,
  options: PathCapabilityOptions = {},
): ToolCheckResult {
  const effectiveToolName = options.toolName ?? pathActionToToolName(action);
  const pathCtx: PathCheckContext = {
    workingDirectory: context.workingDirectory,
    allowedWorkingPaths: [...context.allowedWorkingPaths],
    sandboxAllowPaths: [...context.sandboxAllowPaths],
    dataDir: context.dataDir,
    homeDir: context.homeDir,
    agentName: context.agentName,
    trustedExactWritePaths: [...context.trustedExactWritePaths],
  };

  // Two-step match:
  //   (a) Windows-style absolute paths (`C:\...`, `\\server\share\...`, or any
  //       path containing backslash separators) bypass `path.resolve()`
  //       because on a non-Windows host `path.resolve` would treat them as
  //       relative segments and silently mount them under the current cwd,
  //       hiding HARD patterns. We test the raw string against the HARD
  //       patterns first so cross-platform daemon environments still catch
  //       Windows-shaped credential reads (e.g. mac daemon receiving a
  //       `C:\Users\x\.ssh\id_rsa` string from a Windows-side caller).
  //   (b) Otherwise normal POSIX resolve + match.
  // Use the same shell-aware resolver as suggestion generation and persisted-rule
  // matching. In particular, `~/...` must resolve against the session home,
  // not the daemon cwd (or the daemon process user's home).
  const candidatePath = resolveShellAwarePath(filePath, context.workingDirectory, context.homeDir);
  const hardHit = matchHardBlockedFsRead(candidatePath);
  if (hardHit) {
    // Honor a SPECIFIC per-path rule the user persisted under the originating
    // wrapper tool's namespace before falling back to the HARD ASK. Without this
    // the early return short-circuits matchOriginToolPathRule (run later for the
    // softer safetyCheck branch), so a user who explicitly DENIED `cat ~/.ssh/id_rsa`
    // keeps getting a (bypass-immune, classifier-approvable) ASK that auto mode
    // could still approve — a saved deny must force DENY. A specific per-path ALLOW
    // is likewise honored, matching the safetyCheck branch below. includeWholeTool
    // stays false: a blanket whole-tool / server grant must NOT waive a HARD
    // credential read (r8/r9 design) — only an exact per-path rule does.
    const originVerdict = matchOriginToolPathRule(
      context,
      options.originToolName,
      filePath,
      action,
    );
    if (originVerdict === 'deny') {
      return {
        behavior: 'deny',
        reason: {
          type: 'safetyCheck',
          description: formatHardBlockedFsReason(
            hardHit.category,
            hardHit.description,
            candidatePath,
          ),
          category: hardHit.category,
        },
        ...buildPathRuleSuggestion(filePath, action, context),
      };
    }
    if (originVerdict === 'allow') {
      return {
        behavior: 'allow',
        reason: {
          type: 'safetyCheck',
          description: formatHardBlockedFsReason(
            hardHit.category,
            hardHit.description,
            candidatePath,
          ),
          category: hardHit.category,
          classifierApprovable: true,
        },
      };
    }
    return {
      behavior: 'ask',
      reason: {
        type: 'safetyCheck',
        description: formatHardBlockedFsReason(
          hardHit.category,
          hardHit.description,
          candidatePath,
        ),
        category: hardHit.category,
        classifierApprovable: true,
      },
      bypassImmune: true,
      ...buildPathRuleSuggestion(filePath, action, context),
    };
  }

  // An `execute` capability on a non-static (shell-expansion) path —
  // `bash $HOME/bin/setup.sh`, `source ${DIR}/env.sh`, `sh $(...)` — cannot be
  // statically resolved. validatePath returns a non-workingDirectory
  // `pathValidation` reason, which hard-DENIES a legitimate script run. Fail SAFE
  // to ASK instead: the resolved target may well be workspace-external, exactly
  // like the static `bash /home/user/scripts/setup.sh` execute ASK, so leave the
  // final say to the user (default) / classifier (auto). A sensitive-basename
  // expansion was already caught with bypass-immunity by matchHardBlockedFsRead
  // above; this ordinary ASK is bypass-waivable.
  if (action === 'execute' && !isStaticPathToken(filePath)) {
    return {
      behavior: 'ask',
      reason: {
        type: 'safetyCheck',
        description: `Running a script from an unresolved dynamic path (${filePath}) requires confirmation.`,
        classifierApprovable: true,
      },
    };
  }

  if (action === 'delete' && isDangerousRemovalPath(filePath, context.homeDir)) {
    return {
      behavior: 'deny',
      reason: { type: 'dangerousRemoval', path: candidatePath },
      ...buildPathRuleSuggestion(filePath, action, context),
    };
  }

  // Round-19: an `execute` capability must NOT be authorized by the `fs`
  // umbrella ALLOW rule. `isPathAllowed` folds `fs(/path/**)` into EVERY tool's
  // match, and edit/write ASK approvals persist as `fs(...)`, so an fs-folder
  // grant would silently allow `source /downloads/x.sh` — re-opening the
  // round-18 execute-isolation hole from the fs namespace. Strip only fs
  // umbrella ALLOW for execute (keep fs umbrella DENY: a deny must still
  // block); temp/workspace (below) and a `bash`-origin rule (`originToolName`)
  // remain the only ways to authorize running a script.
  const capabilityRules =
    action === 'execute'
      ? context.rules.filter(
          (r) => !(r.ruleValue.toolName === FS_UMBRELLA_TOOL_NAME && r.ruleBehavior === 'allow'),
        )
      : context.rules;
  const result = isPathAllowed(filePath, [...capabilityRules], pathCtx, effectiveToolName, action);

  if (
    !result.allowed &&
    options.allowTempWrite &&
    action !== 'read' &&
    result.reason.type === 'workingDirectory'
  ) {
    const resolved = result.reason.path;
    if (isTempDirectory(resolved)) {
      return { behavior: 'allow', reason: { type: 'tempDirectory', path: resolved } };
    }
  }

  if (result.allowed) {
    // Capability namespace rules and built-in read/write policy may ALLOW a path
    // (workspace, well-known read locations, temp writes, etc.), but an explicit
    // deny persisted under the originating wrapper tool must still win. Example:
    // after the user denies `cat ~/Desktop/out`, the saved rule is
    // `bash(/home/user/Desktop/**)`; a later Desktop read would otherwise return
    // here as built-in allow and bypass that deny.
    const originVerdict = matchOriginToolPathRule(
      context,
      options.originToolName,
      filePath,
      action,
    );
    if (originVerdict === 'deny') {
      return {
        behavior: 'deny',
        reason: result.reason,
        ...buildPathRuleSuggestion(filePath, action, context),
      };
    }
    return { behavior: 'allow', reason: result.reason };
  }

  if (result.reason.type === 'safetyCheck') {
    const isReadOnlyTool = READ_ONLY_TOOLS.has(effectiveToolName);
    const bypassAllowed =
      context.mode === 'bypassPermissions' ||
      (isReadOnlyTool &&
        (result.reason.category === 'gitDirectory' ||
          (result.reason.category === 'protectedDirectory' && isPublicKeyFile(filePath))));

    const wouldBeBypassImmune = result.reason.classifierApprovable === true ? true : !bypassAllowed;

    // Honor a rule the user persisted under the ORIGINATING wrapper tool's
    // namespace (bash / apply_patch / unknown). A safetyCheck ASK on a sensitive
    // path (`.env`, a private key) that the user already approved is stored under
    // that wrapper tool name by permission-flow applyDecision, not read/write/fs,
    // so without this lookup the same bash/apply_patch invocation re-prompts on
    // every call. Deny-before-allow, mirroring the workingDirectory branch below.
    const originVerdict = matchOriginToolPathRule(
      context,
      options.originToolName,
      filePath,
      action,
    );
    if (originVerdict === 'deny') {
      return {
        behavior: 'deny',
        reason: result.reason,
        ...buildPathRuleSuggestion(filePath, action, context),
      };
    }
    if (originVerdict === 'allow') {
      return { behavior: 'allow', reason: result.reason };
    }

    if (wouldBeBypassImmune) {
      const allowRules = getContentRulesForTool(context, effectiveToolName, 'allow');
      // Same round-19 rule on the sensitive/protected-path branch: the `fs`
      // umbrella ALLOW must not authorize EXECUTE (`source ~/.ssh/agent.sh`
      // under an `fs(~/.ssh/**)` grant). bash-origin authorization already ran
      // above (matchOriginToolPathRule); fs umbrella is excluded for execute.
      const umbrellaRules =
        effectiveToolName !== FS_UMBRELLA_TOOL_NAME && action !== 'execute'
          ? getContentRulesForTool(context, FS_UMBRELLA_TOOL_NAME, 'allow')
          : [];
      for (const rule of [...allowRules, ...umbrellaRules]) {
        if (
          ruleAllowsPathAction(rule, action) &&
          rule.ruleValue.ruleContent &&
          matchPathRule(filePath, rule.ruleValue.ruleContent)
        ) {
          return { behavior: 'allow', reason: { type: 'rule', rule } };
        }
      }
    }

    return {
      behavior: 'ask',
      reason: result.reason,
      bypassImmune: wouldBeBypassImmune,
      ...(result.reason.classifierApprovable === false ? { skipAutoClassifier: true } : {}),
      ...buildPathRuleSuggestion(filePath, action, context),
    };
  }

  // Outside workspace/scratch with no matching capability-namespace rule.
  // Before delegating to the mode router, honor an allow/deny rule the user
  // previously persisted under the ORIGINATING tool's namespace (bash,
  // apply_patch, an unknown path-bearing tool). permission-flow applyDecision
  // stores path approvals from those wrapper tools under the wrapper tool name
  // rather than read/write, so without this lookup every subsequent
  // invocation would re-prompt for an already-approved path.
  if (result.reason.type === 'workingDirectory') {
    // Boundary (workspace-external, non-sensitive) ask: a bare whole-tool grant
    // (acceptEdits / explicit `allow apply_patch`) may waive it — pass
    // includeWholeTool=true. (The sensitive safetyCheck branch above intentionally
    // does NOT, so a blanket grant cannot waive a credential/.env ask.)
    const originVerdict = matchOriginToolPathRule(
      context,
      options.originToolName,
      filePath,
      action,
      true,
    );
    if (originVerdict === 'allow') {
      return { behavior: 'allow', reason: result.reason };
    }
    if (originVerdict === 'deny') {
      return {
        behavior: 'deny',
        reason: result.reason,
        ...buildPathRuleSuggestion(filePath, action, context),
      };
    }
  }

  // Outside workspace/scratch with no matching rule → ASK and delegate to
  // the mode router (auto mode may run the LLM gate; default mode surfaces
  // user confirmation). Mirrors dev policy 8d490e84d — path boundary asks
  // must NOT skip the auto classifier. Non-workingDirectory reasons
  // (pathValidation, dangerousRemoval) stay hard denies.
  return {
    behavior: result.reason.type === 'workingDirectory' ? 'ask' : 'deny',
    reason: result.reason,
    ...buildPathRuleSuggestion(filePath, action, context),
  };
}

/**
 * Whole-tool allow/deny check that also honors an MCP **server-level** grant.
 *
 * The engine's Step 2b allows `mcp__server__tool` when a bare server-level rule
 * `mcp__server` (no content) exists (`findMcpServerRule`). But the unknown-tool
 * path-capability fallback runs BEFORE Step 2b, so a boundary (workspace-external,
 * non-sensitive) `workingDirectory` ASK from the resolver short-circuits the engine
 * and the already-approved server-level grant never gets a chance — re-prompting on
 * a path the user already blessed at the server level. Mirror
 * the engine's server-level match here so a bare `mcp__server` allow waives a
 * boundary ask exactly like a bare whole-tool allow does. Gated by the SAME
 * `includeWholeTool` flag as `hasWholeToolRule`, so it is consulted ONLY for the
 * boundary branch — a server-level grant must NOT waive a SENSITIVE-file ask.
 */
function hasWholeToolOrMcpServerRule(
  context: ToolPermissionContext,
  toolName: string,
  behavior: 'allow' | 'deny',
): boolean {
  if (hasWholeToolRule(context, toolName, behavior)) return true;
  if (!toolName.startsWith('mcp__')) return false;
  return context.rules.some((rule) => {
    if (rule.ruleBehavior !== behavior || rule.ruleValue.ruleContent) return false;
    const ruleToolName = rule.ruleValue.toolName;
    return matchesMcpServerRuntimeName(toolName, ruleToolName);
  });
}

/**
 * After isPathAllowed has declined under the capability namespace
 * (read / write / fs), give the ORIGINATING wrapper tool's own content rules a
 * chance to resolve the path. Path approvals from wrapper tools (bash,
 * apply_patch, unknown path-bearing tools) are persisted under that wrapper
 * tool's name by permission-flow applyDecision, so they are invisible to the
 * read/write/fs scans isPathAllowed already ran. read / write / fs themselves
 * are skipped — those were the namespaces already consulted.
 *
 * Returns 'deny' / 'allow' when an origin-tool rule matches the path, else
 * undefined so the caller keeps its capability-namespace verdict.
 */
function matchOriginToolPathRule(
  context: ToolPermissionContext,
  originToolName: string | undefined,
  filePath: string,
  action: PermissionRuleAction,
  includeWholeTool = false,
): 'allow' | 'deny' | undefined {
  if (!originToolName) return undefined;
  if (
    originToolName === 'read' ||
    originToolName === 'write' ||
    originToolName === FS_UMBRELLA_TOOL_NAME
  ) {
    return undefined;
  }
  // Resolve the operand against the SESSION workspace before matching: matchPathRule
  // anchors a RELATIVE path to the daemon process cwd, but a persisted approval is
  // stored as the workspace-resolved suggestion (`/workspace/**`). Without this a
  // relative `.env` / `cat .env` would never re-match the rule the user just
  // approved and would re-prompt forever (Codex P2 round-8). Absolute operands are
  // unaffected (path.resolve ignores the base for them).
  const resolvedPath = resolveShellAwarePath(filePath, context.workingDirectory, context.homeDir);

  // Deny short-circuits first, mirroring isPathAllowed's deny-before-allow order.
  // `includeWholeTool` honors the originating wrapper tool's BARE whole-tool
  // allow/deny (engine Step 1a/2b) — e.g. an acceptEdits migration grant or an
  // explicit `allow apply_patch`. The path-capability ASK short-circuits the engine
  // before Step 2b, so without this a whole-tool allow stops working for any path
  // the resolver flags. It is enabled ONLY for the boundary
  // (workingDirectory) branch: a blanket tool grant may waive a workspace-external
  // write, but must NOT silently waive a SENSITIVE-file ask (`.env`, credentials) —
  // those require a specific per-path content rule, preserving the unified
  // sensitive-path protection this resolver exists to provide.
  if (includeWholeTool && hasWholeToolOrMcpServerRule(context, originToolName, 'deny'))
    return 'deny';
  for (const rule of getContentRulesForTool(context, originToolName, 'deny')) {
    if (
      ruleAllowsPathAction(rule, action) &&
      rule.ruleValue.ruleContent &&
      matchPathRule(resolvedPath, rule.ruleValue.ruleContent)
    ) {
      return 'deny';
    }
  }
  if (includeWholeTool && hasWholeToolOrMcpServerRule(context, originToolName, 'allow'))
    return 'allow';
  for (const rule of getContentRulesForTool(context, originToolName, 'allow')) {
    if (
      ruleAllowsPathAction(rule, action) &&
      rule.ruleValue.ruleContent &&
      matchPathRule(resolvedPath, rule.ruleValue.ruleContent)
    ) {
      return 'allow';
    }
  }
  return undefined;
}

function ruleAllowsPathAction(rule: PermissionRule, action: PermissionRuleAction): boolean {
  const matcher = rule.ruleValue.matcher;
  if (!matcher) return true;
  if (matcher.kind !== 'path') return false;
  return matcher.actions === undefined || matcher.actions.includes(action);
}

function resolveShellAwarePath(
  filePath: string,
  workingDirectory?: string,
  homeDir?: string,
): string {
  const looksWindows = /^[A-Za-z]:[\\/]/.test(filePath) || filePath.includes('\\');
  if (looksWindows) return filePath;

  const homeResolvedPath =
    filePath === '~'
      ? homeDir
      : filePath.startsWith('~/') && homeDir
        ? path.join(homeDir, filePath.slice(2))
        : filePath;
  return path.resolve(workingDirectory ?? process.cwd(), homeResolvedPath ?? filePath);
}

function generateSuggestionRulesWithContext(
  filePath: string,
  context: Pick<ToolPermissionContext, 'workingDirectory' | 'homeDir'>,
): string[] {
  return generateSuggestionRules(filePath, context.workingDirectory, context.homeDir);
}

function buildPathRuleSuggestion(
  filePath: string,
  action: PermissionRuleAction,
  context: Pick<ToolPermissionContext, 'workingDirectory' | 'homeDir'>,
): { ruleContents: string[]; ruleMatchers: PermissionRuleMatcher[] } {
  const ruleContents = generateSuggestionRulesWithContext(filePath, context);
  return {
    ruleContents,
    ruleMatchers: ruleContents.map((pattern) => ({ kind: 'path', pattern, actions: [action] })),
  };
}

export function generateSuggestionRules(
  filePath: string,
  workingDirectory?: string,
  homeDir = os.homedir(),
): string[] {
  // Shell-aware resolution is required here: Node's path.resolve treats `~/x`
  // as a relative path and would persist `<workingDirectory>/~/x/**`, which is
  // not the path the shell checked or executed. Keep this adapter conservative
  // and expand only the unquoted-looking home forms supplied by this API.
  const shellResolvedPath =
    filePath === '~'
      ? homeDir
      : filePath.startsWith('~/')
        ? path.join(homeDir, filePath.slice(2))
        : filePath;
  // Resolve a relative operand against the SESSION workspace, not the daemon
  // process cwd. `path.resolve(filePath)` alone anchors `cat .env` /
  // apply_patch `.env` to wherever the daemon was launched, so the persisted
  // allow rule would point at `<daemon-cwd>/.env` while the actual capability
  // check (isPathAllowed → validatePath) used `context.workingDirectory` — the
  // mismatch re-prompts every call or mis-reuses an approval across workspaces.
  // Absolute operands ignore the base, so this is a no-op for them.
  const dir = path.dirname(path.resolve(workingDirectory ?? process.cwd(), shellResolvedPath));
  // Refuse to emit a wide "always allow" glob under system pseudo-FS trees.
  // A user-approved `bash(/dev/**)` / `bash(/proc/**)` / `bash(/sys/**)`
  // rule silently covers dangerous entries that live in the same tree:
  //   - `/dev/tcp/<host>/<port>`  → reverse-shell (HARD-blocked in
  //     dangerous-patterns.ts:reverse-shell); a wide user rule would
  //     erode the HARD gate on rule-priority tie.
  //   - `/dev/sda*` / `/dev/nvme*` → raw block-device write (`dd of=/dev/sda`
  //     is HARD `disk-erase`).
  //   - `/dev/mem` / `/dev/kmem` → direct physical-memory access.
  //   - `/proc/<pid>/mem` / `/proc/kcore` → arbitrary process memory.
  //   - `/sys/kernel/*` → kernel state mutation.
  // Returning [] here keeps the ask interaction intact (user can still
  // approve THIS specific path via the concrete-rule flow upstream) but
  // does not offer a "next time auto-allow" checkbox — a deliberate
  // one-shot approval, matching the pre-suggestion behaviour.
  //
  // Note: the discard-sink whitelist above should already have kept
  // `/dev/null` / `/dev/stderr` / `/dev/stdout` / `/dev/tty` from ever
  // reaching this function via a redirect intent. This guard is the
  // second layer — defence-in-depth in case another intent extractor
  // (e.g. an fs-tool path arg that legitimately points at `/dev/x` for
  // some future exotic case, or a tool checker that bypasses the
  // discard-sink filter) still lands here.
  if (
    dir === '/dev' ||
    dir.startsWith('/dev/') ||
    dir === '/proc' ||
    dir.startsWith('/proc/') ||
    dir === '/sys' ||
    dir.startsWith('/sys/')
  ) {
    return [];
  }
  if (dir === '/' || dir === path.parse(dir).root) {
    return [filePath];
  }
  return [`${dir}/**`];
}

function formatHardBlockedFsReason(
  category: string,
  description: string,
  resolvedPath: string,
): string {
  if (category === 'system-secret') {
    return `Needs confirmation: system secret access requires LLM review and explicit approval if the LLM cannot allow it. Path: ${resolvedPath}. Reason: ${description}.`;
  }
  return `Needs confirmation: credential or private-key access requires LLM review and explicit approval if the LLM cannot allow it. Path: ${resolvedPath}. Reason: ${description}.`;
}

function isLikelyLocalPath(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.startsWith('.') ||
    value.startsWith('~/') ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.includes('/') ||
    value.includes('\\')
  );
}

function inferUnknownAction(toolName: string, field: string): PathCapabilityAction {
  const lowerTool = toolName.toLowerCase();
  const lowerField = field.toLowerCase();
  if (
    lowerTool.includes('delete') ||
    lowerTool.includes('remove') ||
    lowerTool.includes('unlink')
  ) {
    return 'delete';
  }
  if (lowerField === 'output' || lowerField === 'destination' || lowerField === 'target') {
    return 'write';
  }
  if (lowerField === 'cwd' || lowerField === 'dir') {
    return 'write';
  }
  if (
    lowerTool.includes('read') ||
    lowerTool.includes('fetch') ||
    lowerTool.includes('open') ||
    lowerTool.includes('show') ||
    lowerTool.includes('list') ||
    lowerTool.includes('grep') ||
    lowerTool.includes('glob')
  ) {
    return 'read';
  }
  return 'write';
}

function extractApplyPatchPaths(patchText: string): PathCapabilityIntent[] {
  const intents: PathCapabilityIntent[] = [];
  const lines = patchText.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('*** Add File: ')) {
      intents.push({ path: line.slice('*** Add File: '.length).trim(), action: 'write' });
    } else if (line.startsWith('*** Update File: ')) {
      intents.push({ path: line.slice('*** Update File: '.length).trim(), action: 'write' });
    } else if (line.startsWith('*** Delete File: ')) {
      intents.push({ path: line.slice('*** Delete File: '.length).trim(), action: 'delete' });
    } else if (line.startsWith('*** Move to: ')) {
      // V4A rename: the hunk keeps `*** Update File: <src>` and adds
      // `*** Move to: <dst>`. The destination is a real write target — without
      // it a patch could update an in-workspace source and move the file
      // outside the workspace boundary while only the source path was vetted.
      intents.push({ path: line.slice('*** Move to: '.length).trim(), action: 'write' });
    }
  }
  return intents;
}

export function extractUnknownToolPathIntents(
  toolName: string,
  input: Record<string, unknown>,
): PathCapabilityIntent[] {
  const intents: PathCapabilityIntent[] = [];

  for (const field of [
    'filePath',
    'file_path',
    'path',
    'output',
    'destination',
    'target',
    'dir',
    'cwd',
  ]) {
    const value = input[field];
    if (typeof value === 'string' && isLikelyLocalPath(value)) {
      intents.push({ path: value, action: inferUnknownAction(toolName, field) });
    }
  }

  const commandValue = input.command;
  if (
    typeof commandValue === 'string' &&
    !commandValue.includes(' ') &&
    (isLikelyLocalPath(commandValue) ||
      /\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|tsx)$/i.test(commandValue))
  ) {
    intents.push({ path: commandValue, action: 'execute' });
  }

  if (toolName === 'apply_patch') {
    const patchText = extractApplyPatchText(input);
    if (typeof patchText === 'string') {
      intents.push(...extractApplyPatchPaths(patchText));
    }
  }

  intents.push(...extractMatrixToolPathIntents(toolName, input));

  return dedupePathIntents(intents);
}

const MATRIX_READ_PATH_FIELDS = new Set([
  'file',
  'url',
  'file_path',
  'image',
  'audio',
  'video',
  'image_file',
  'image_file_path',
  'audio_file_path',
  'video_file_path',
  'input_image',
  'input_image_path',
  'image_url',
  'audio_url',
  'video_url',
]);

const MATRIX_READ_PATH_LIST_FIELDS = new Set([
  'input_files',
  'input_file_paths',
  'file_path_list',
  'image_list',
  'images',
  'image_file_path_list',
  'audio_list',
  'audios',
  'audio_file_path_list',
  'video_list',
  'videos',
  'video_file_path_list',
  'reference_image_paths',
  'reference_video_paths',
  'reference_audio_paths',
]);

const MATRIX_WRITE_PATH_FIELDS = new Set(['output_file_path', 'output_dir_path']);

const MATRIX_WRITE_PATH_LIST_FIELDS = new Set(['output_file_path_list']);

const MATRIX_NATIVE_TOOL_NAMES = new Set([
  'web_search',
  'images_understand',
  'image_synthesize',
  'images_search_and_download',
  'image_reverse_search',
  'submit_video_generation',
  'query_video_generation',
  'gen_videos',
  'batch_text_to_video',
  'batch_image_to_video',
  'get_voice_list',
  'batch_text_to_audio',
  'batch_text_to_music',
  'synthesize_speech',
  'batch_synthesize_speech',
  'audios_understand',
  'videos_understand',
  'transcribe_audio',
]);

const LEGACY_MATRIX_MCP_TOOL_PREFIXES = ['mcp_matrix_', 'mcp__matrix__', 'matrix_'];

function extractMatrixToolPathIntents(
  toolName: string,
  input: Record<string, unknown>,
): PathCapabilityIntent[] {
  const matrixTool = normalizeMatrixToolName(toolName);
  if (!matrixTool) return [];

  const intents: PathCapabilityIntent[] = [];
  const addRead = (value: unknown): void => {
    if (typeof value !== 'string' || value.length === 0) return;
    if (isHttpUrl(value)) return;
    const filePath = stripFileUri(value).trim();
    if (!filePath) return;
    intents.push({
      path: filePath,
      action: 'read',
    });
  };
  const addWrite = (value: unknown): void => {
    if (typeof value !== 'string' || value.length === 0) return;
    if (isHttpUrl(value)) return;
    const filePath = stripFileUri(value).trim();
    if (!filePath) return;
    intents.push({
      path: filePath,
      action: 'write',
    });
  };
  const collectValue = (value: unknown, action: PathCapabilityIntent['action']): void => {
    if (Array.isArray(value)) {
      for (const item of value) collectValue(item, action);
      return;
    }
    if (typeof value === 'string') {
      if (action === 'write') addWrite(value);
      else addRead(value);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    for (const [field, fieldValue] of Object.entries(record)) {
      collectMatrixAliasPath(field, fieldValue);
    }
  };
  const collectMatrixAliasPath = (field: string, value: unknown): void => {
    if (MATRIX_READ_PATH_FIELDS.has(field) || MATRIX_READ_PATH_LIST_FIELDS.has(field)) {
      collectValue(value, 'read');
      return;
    }
    if (MATRIX_WRITE_PATH_FIELDS.has(field) || MATRIX_WRITE_PATH_LIST_FIELDS.has(field)) {
      collectValue(value, 'write');
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (Array.isArray(item) || (item && typeof item === 'object')) {
          collectValue(item, 'read');
        }
      }
      return;
    }
    if (value && typeof value === 'object') {
      for (const [childField, childValue] of Object.entries(value as Record<string, unknown>)) {
        collectMatrixAliasPath(childField, childValue);
      }
    }
  };
  for (const [field, value] of Object.entries(input)) {
    collectMatrixAliasPath(field, value);
  }

  return dedupePathIntents(intents);
}

function normalizeMatrixToolName(toolName: string): string | undefined {
  if (MATRIX_NATIVE_TOOL_NAMES.has(toolName)) return toolName;
  return LEGACY_MATRIX_MCP_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix))
    ? toolName
    : undefined;
}

function stripFileUri(value: string): string {
  if (!value.startsWith('file://')) return value;
  try {
    const url = new URL(value);
    if (url.protocol === 'file:') return decodeURIComponent(url.pathname);
  } catch {
    // Fall through to the simple prefix strip below.
  }
  return value.slice('file://'.length);
}

function isHttpUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}

function dedupePathIntents(intents: PathCapabilityIntent[]): PathCapabilityIntent[] {
  const seen = new Set<string>();
  return intents.filter((intent) => {
    const key = `${intent.action}\u0000${intent.relativeBase ?? ''}\u0000${intent.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * apply_patch payloads do not have a single stable field name across
 * frameworks. OpenCode lands the raw envelope in `_raw` when the arguments are
 * not JSON; Codex / direct callers may use `patch`, `input`, or `patchText`.
 * Probe them in priority order and return the first string body so the V4A
 * patch parser sees the actual `*** Add/Update/Delete File:` headers.
 */
function extractApplyPatchText(input: Record<string, unknown>): string | undefined {
  for (const field of ['patchText', 'patch', 'input', '_raw']) {
    const value = input[field];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

// Commands whose file READ operands this resolver fully models: every path
// argument is extracted as a `read` intent below, so a sensitive operand always
// surfaces as a path ASK. Exported so the bash redirect fast-allow can restrict
// its allow-upgrade to commands whose read surface is fully resolved here.
export const READ_PATH_COMMANDS = new Set(['cat', 'head', 'tail', 'less', 'more', 'nl', 'wc']);
export const SEARCH_PATH_COMMANDS = new Set(['grep', 'rg']);
const EXECUTE_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);

export function extractBashPathIntents(command: string): PathCapabilityIntent[] {
  const intents: PathCapabilityIntent[] = [];
  for (const rawSubcommand of splitCommand(command)) {
    // Heredoc/here-string bodies are DATA, not command arguments. splitCommand
    // keeps a heredoc body attached to its header subcommand; mask the body so
    // its contents (e.g. `rm -rf /x` written into a `cat <<EOF` body) are never
    // mistaken for real path intents. The heredoc operator token itself
    // (`<<EOF`, `<<<…`) is dropped later by isStaticPathToken.
    const subcommand = maskHeredocBodies(rawSubcommand);
    intents.push(...extractRedirectIntents(subcommand));

    const sourceTarget = extractSourceTarget(subcommand);
    if (sourceTarget) {
      if (sourceTarget !== '/dev/stdin') {
        intents.push({ path: sourceTarget, action: 'execute' });
      }
      continue;
    }

    const tokens = shellTokenize(subcommand.trim());
    if (tokens.length === 0) continue;
    const commandIndex = skipEnvPrefixes(tokens);
    const head = normalizeCommandToken(tokens[commandIndex]);
    if (!head) continue;
    const args = tokens.slice(commandIndex + 1);

    if (READ_PATH_COMMANDS.has(head)) {
      for (const target of collectPathArgs(args)) {
        intents.push({ path: target, action: 'read' });
      }
      continue;
    }

    if (SEARCH_PATH_COMMANDS.has(head)) {
      intents.push(...extractSearchPathIntents(args));
      continue;
    }

    if (head === 'rm') {
      for (const target of collectPathArgs(args)) {
        intents.push({ path: target, action: 'delete' });
      }
      continue;
    }

    if (head === 'tee') {
      for (const target of collectPathArgs(args)) {
        intents.push({ path: target, action: 'write' });
      }
      continue;
    }

    if (head === 'cp' || head === 'mv') {
      // `-t DIR` / `--target-directory=DIR` inverts the argument order: every
      // positional is a SOURCE copied INTO DIR, so the real write target is
      // DIR — not the last positional. Without this, `cp -t /external/dir src`
      // would treat the in-workspace `src` as the destination and wave the
      // external write through.
      const targetDir = extractTargetDirectoryFlag(args);
      const positional = collectPathArgs(args);
      // Source operands must be read-checked (and, for `mv`, delete-checked):
      // copying / moving a sensitive file (`cp ~/.ssh/id_rsa /tmp/key`) must
      // not slip through just because the destination is writable. With a
      // separated `-t DIR` / `--target-directory DIR` form, collectPathArgs
      // also keeps DIR as a positional — exclude it from sources, otherwise the
      // destination dir gets a bogus delete intent (`mv -t /tmp README` would
      // add a delete check on `/tmp`, which isDangerousRemovalPath hard-rejects,
      // breaking a legitimate temp move).
      const sources = targetDir
        ? positional.filter((entry) => entry !== targetDir)
        : positional.slice(0, -1);
      for (const source of sources) {
        intents.push({ path: source, action: 'read' });
        if (head === 'mv') {
          intents.push({ path: source, action: 'delete' });
        }
      }
      if (targetDir) {
        intents.push({ path: targetDir, action: 'write' });
      } else if (positional.length >= 2) {
        intents.push({ path: positional[positional.length - 1]!, action: 'write' });
      }
      continue;
    }

    if (head === 'sed') {
      // `-f FILE`/`--file=FILE` is a script FILE sed READS; `-e`/`--expression`
      // is an inline script (data). When either supplies the script, no positional
      // is the inline script, so the first positional must NOT be dropped below.
      // Without this, `sed -i -f ~/.ssh/id_rsa /tmp/out` dropped the key read and
      // only modeled the /tmp write -> the sed-i fast-allow upgraded it to allow.
      const positional: string[] = [];
      let scriptFromFlag = false;
      let inPlace = false;
      for (let index = 0; index < args.length; index++) {
        const token = args[index] ?? '';
        if (isRedirectOperatorToken(token)) {
          index++;
          continue;
        }
        if (token.startsWith('-') && token !== '-') {
          if (token === '--in-place' || token.startsWith('--in-place=')) {
            inPlace = true;
            continue;
          }
          if (token === '-f' || token === '--file') {
            const value = args[++index];
            if (value && isStaticPathToken(value)) intents.push({ path: value, action: 'read' });
            scriptFromFlag = true;
            continue;
          }
          if (token.startsWith('--file=')) {
            const value = token.slice('--file='.length);
            if (isStaticPathToken(value)) intents.push({ path: value, action: 'read' });
            scriptFromFlag = true;
            continue;
          }
          if (token === '-e' || token === '--expression') {
            index++;
            scriptFromFlag = true;
            continue;
          }
          if (token.startsWith('--expression=')) {
            scriptFromFlag = true;
            continue;
          }
          // Short-option cluster: walk left-to-right with getopt semantics so a
          // mid-cluster `-f` script FILE is read-modeled (`sed -nf/home/.../id_rsa`
          // = `-n -f <file>`), while `-i[SUFFIX]` (optional ATTACHED backup suffix)
          // and `-e[SCRIPT]` (inline data) never mis-read their value. Stop at the
          // first arg-consuming option. The earlier `-[A-Za-z]*f$` / `-f[^-]`
          // regexes missed the mid-cluster attached form (`-nf/path`), and the old
          // `args.some(startsWith('-i'))` in-place probe missed the combined forms
          // (`-Ei` / `-ni` / `-ri`) where `i` is not the cluster's first option —
          // leaking an external in-place write past sed's SAFE first-word allow.
          if (token[1] !== '-') {
            for (let cursor = 1; cursor < token.length; cursor++) {
              const opt = token[cursor];
              if (opt === 'i') {
                // -i[SUFFIX]: in-place edit; the rest of the token is the optional
                // backup suffix (data, not an option), so stop scanning.
                inPlace = true;
                break;
              }
              if (opt === 'e') {
                // -e[SCRIPT]: inline script is data, never a file. Consume the
                // separate SCRIPT token when `e` is the cluster's last char.
                scriptFromFlag = true;
                if (cursor === token.length - 1) index++;
                break;
              }
              if (opt === 'f') {
                // -f[SCRIPTFILE]: sed READS the script file (attached rest, or the
                // next token when `f` is the cluster's last char).
                scriptFromFlag = true;
                const value = cursor === token.length - 1 ? args[++index] : token.slice(cursor + 1);
                if (value && isStaticPathToken(value))
                  intents.push({ path: value, action: 'read' });
                break;
              }
              // no-arg flags (n / r / E / s / z / u / …): keep scanning the cluster.
            }
            continue;
          }
          continue;
        }
        if (isStaticPathToken(token)) positional.push(token);
      }
      if (inPlace) {
        const targets = scriptFromFlag ? positional : positional.slice(1);
        for (const target of targets) {
          intents.push({ path: target, action: 'write' });
        }
      }
      continue;
    }

    if (EXECUTE_SHELLS.has(head)) {
      const script = extractShellScriptPath(args);
      if (script) intents.push({ path: script, action: 'execute' });
    }
  }
  return intents;
}

export function decideUnknownToolPathCapabilities(
  toolName: string,
  input: Record<string, unknown>,
  context: ToolPermissionContext,
): ToolCheckResult | undefined {
  const intents = extractUnknownToolPathIntents(toolName, input);
  if (intents.length === 0) {
    if (toolName === 'apply_patch') {
      // apply_patch always mutates the filesystem. If no path intent could be
      // extracted (unrecognized payload shape / unparseable patch body), fail
      // closed: ASK instead of letting the engine's no-checker default-allow
      // wave an opaque write through. Not bypass-immune — bypassPermissions
      // mode still means the user opted out of all prompts.
      return {
        behavior: 'ask',
        reason: {
          type: 'safetyCheck',
          description:
            'apply_patch payload could not be parsed for path-capability checks; manual confirmation required.',
        },
      };
    }
    return undefined;
  }

  // Aggregate across ALL intents with deny > bypass-immune ask > ordinary ask >
  // allow precedence. Returning the first non-allow intent would let an early
  // ordinary ASK (e.g. an out-of-workspace `workingDirectory` boundary write) mask
  // a later deterministic DENY (a dangerous deletion) OR a later bypass-immune ASK
  // (a sensitive `.env`/private-key write) in the same apply_patch. A non-immune
  // boundary ASK is skipped by bypassPermissions mode (engine Step 2a), so masking a
  // later immune ASK behind it would let bypass mode wave the sensitive write
  // through. Mirrors the bash subcommand path loop's immune-over-ordinary ordering.
  let sawAllow = false;
  let pendingAsk: ToolCheckResult | undefined;
  let pendingImmuneAsk: ToolCheckResult | undefined;
  for (const intent of intents) {
    const decision = evaluatePathCapability(
      resolvePathIntent(intent, context),
      intent.action,
      context,
      {
        toolName: pathActionToToolName(intent.action),
        allowTempWrite: toolName === 'apply_patch',
        originToolName: toolName,
      },
    );
    if (decision.behavior === 'deny') return decision;
    if (decision.behavior === 'ask') {
      if (decision.bypassImmune) {
        if (!pendingImmuneAsk) pendingImmuneAsk = decision;
      } else if (!pendingAsk) {
        pendingAsk = decision;
      }
      continue;
    }
    sawAllow = true;
  }

  if (pendingImmuneAsk) return pendingImmuneAsk;
  if (pendingAsk) return pendingAsk;
  return sawAllow
    ? {
        behavior: 'allow',
        reason: {
          type: 'safetyCheck',
          description: `Path capability allow for tool "${toolName}"`,
        },
      }
    : undefined;
}

function resolvePathIntent(intent: PathCapabilityIntent, context: ToolPermissionContext): string {
  if (intent.relativeBase === 'home') {
    return path.resolve(context.homeDir, intent.path);
  }
  return intent.path;
}

function skipEnvPrefixes(tokens: readonly string[]): number {
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? '')) index++;
  if (tokens[index] === 'env') {
    index += 1;
    while (
      index < tokens.length &&
      (tokens[index]?.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? ''))
    ) {
      index++;
    }
  }
  return index;
}

function normalizeCommandToken(token: string | undefined): string | undefined {
  if (!token) return undefined;
  if (token.startsWith('/')) return token.split('/').pop() ?? token;
  return token;
}

function collectPathArgs(tokens: readonly string[]): string[] {
  const positional: string[] = [];
  let afterDoubleDash = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] ?? '';
    if (!afterDoubleDash && token === '--') {
      afterDoubleDash = true;
      continue;
    }
    // A redirection operator token (`<`, `<<`, `<<<`, `>`, `>>`, `2>`, `&>`, …)
    // and its following operand are NOT command path arguments: the operand is a
    // here-string payload (`<<< ~/.ssh/id_rsa` — stdin data, not a file) or a
    // redirect target already modeled by extractRedirectIntents. Skip both so a
    // here-string literal is never mistaken for a sensitive read and a write
    // target is not double-counted as a read.
    if (!afterDoubleDash && isRedirectOperatorToken(token)) {
      index++;
      continue;
    }
    if (!afterDoubleDash && token.startsWith('-')) {
      continue;
    }
    if (!isStaticPathToken(token)) {
      continue;
    }
    positional.push(token);
  }
  return positional;
}

/**
 * Resolve the READ targets of a `grep` / `rg` invocation.
 *
 * `grep PATTERN file...` — the FIRST positional is the inline regex pattern, not
 * a file. But when the pattern is supplied via a flag the rules differ:
 *   - `-f FILE` / `--file FILE` (and `--file=`, `-fFILE`, short cluster `-rf FILE`):
 *     grep READS the pattern FILE, so it is itself a read target — and there is no
 *     inline-pattern positional, so EVERY positional is a search file.
 *   - `-e PATTERN` / `--regexp PATTERN` (and attached forms): the pattern is data,
 *     never a file, but again no positional is the inline pattern.
 * The old `collectPathArgs(...).slice(1)` dropped the first positional
 * unconditionally; with `-f`, that first positional WAS the pattern file, so a
 * sensitive pattern file (`grep -f /home/user/.ssh/id_rsa <ws>`) was read without
 * confirmation while only the in-workspace search file got modeled.
 */
function extractSearchPathIntents(args: readonly string[]): PathCapabilityIntent[] {
  const readPaths: string[] = [];
  const positionals: string[] = [];
  let patternFromFlag = false;
  // rg `--files` (and `--type-list`) list files without searching, so there is no
  // inline regex: the first positional is a search ROOT, not a pattern to drop.
  let noInlinePattern = false;
  let afterDoubleDash = false;
  for (let index = 0; index < args.length; index++) {
    const token = args[index] ?? '';
    if (!afterDoubleDash && token === '--') {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && isRedirectOperatorToken(token)) {
      index++;
      continue;
    }
    if (!afterDoubleDash && token.startsWith('-') && token !== '-') {
      if (token === '--files' || token === '--type-list') {
        noInlinePattern = true;
        continue;
      }
      // File-valued options that the search command READS but that do NOT supply a
      // pattern: rg `--ignore-file PATH`, GNU grep `--exclude-from=PATH`. The value
      // must be modeled as a read (and consumed) — otherwise it falls through as a
      // positional and slice(1) silently drops a sensitive path.
      if (token === '--ignore-file' || token === '--exclude-from') {
        const value = args[++index];
        if (value && isStaticPathToken(value)) readPaths.push(value);
        continue;
      }
      if (token.startsWith('--ignore-file=') || token.startsWith('--exclude-from=')) {
        const value = token.slice(token.indexOf('=') + 1);
        if (isStaticPathToken(value)) readPaths.push(value);
        continue;
      }
      // Pattern-FILE flag: grep/rg READS the pattern file, so it is itself a read
      // target and no positional is the inline pattern. `-f FILE` / `--file FILE`
      // take the next token; `--file=FILE` is attached.
      if (token === '-f' || token === '--file') {
        const value = args[++index];
        if (value && isStaticPathToken(value)) readPaths.push(value);
        patternFromFlag = true;
        continue;
      }
      if (token.startsWith('--file=')) {
        const value = token.slice('--file='.length);
        if (isStaticPathToken(value)) readPaths.push(value);
        patternFromFlag = true;
        continue;
      }
      // Short-option cluster carrying a value-taking pattern flag — `f` (pattern
      // FILE, a read target) or `e` (inline pattern DATA, never a file). getopt
      // consumes the rest of the token after the flag char as its argument
      // (`-fFILE`, `-rf/path`, `-ebar`, `-nebar`), or the next token when the flag
      // char is the cluster's last char (`-rf FILE`, `-ne PATTERN`). Whichever of
      // `e`/`f` appears FIRST owns the rest of the cluster; a later char is part of
      // that argument, not a separate flag. The earlier `-[A-Za-z]*f$` / `-f[^-]` /
      // `-[A-Za-z]*e$` / `-e[^-]` regexes missed the mid-cluster attached forms
      // (`-rf/path`, `-nebar`), leaking either a sensitive pattern-file read (`f`) or
      // a dropped first FILE operand (`e` slot uncounted) past grep's fast-allow
      // (mirrors extractTargetDirectoryFlag's `-t` handling).
      if (token[1] !== '-') {
        const fIndex = token.indexOf('f', 1);
        const eIndex = token.indexOf('e', 1);
        if (fIndex !== -1 || eIndex !== -1) {
          const isFile = fIndex !== -1 && (eIndex === -1 || fIndex < eIndex);
          const flagIndex = isFile ? fIndex : eIndex;
          patternFromFlag = true;
          const value = flagIndex === token.length - 1 ? args[++index] : token.slice(flagIndex + 1);
          // Only `-f`'s value is a file READ; `-e`'s value is inline pattern data.
          if (isFile && value && isStaticPathToken(value)) readPaths.push(value);
          continue;
        }
      }
      // Long-form inline-pattern flag: the pattern is data (never a file), but it
      // still means no positional is the inline pattern — every positional is a
      // search file. (Short `-e` clusters are handled by the scanner above.)
      if (token === '--regexp') {
        index++;
        patternFromFlag = true;
        continue;
      }
      if (token.startsWith('--regexp=')) {
        patternFromFlag = true;
        continue;
      }
      // Any other flag: skip it. grep/rg value-taking flags (`-m NUM`, `-A NUM`,
      // `-d ACTION`, `--include=GLOB`, `-g GLOB`) never take a file READ operand,
      // so a stray separated value falling through as a positional only ever adds
      // a harmless in-workspace read.
      continue;
    }
    // Keep EVERY positional (static or not) so the inline-pattern slot is counted.
    // A non-static pattern (`grep 'token$' FILE`) must still occupy slot 0, else the
    // slice(1) below drops the first real FILE argument and a sensitive read
    // (`grep 'token$' ~/.ssh/id_rsa`) slips through unmodeled into grep's fast-allow.
    positionals.push(token);
  }
  // With a flag-supplied pattern (or a no-pattern listing mode like rg --files)
  // every positional is a search file; otherwise the first positional is the
  // inline regex pattern (not a file). Non-static tokens that survive into the
  // search-file slots are not statically resolvable, so they are filtered here (the
  // bash classifier handles their ASK separately) — only static paths are modeled.
  const searchFiles = patternFromFlag || noInlinePattern ? positionals : positionals.slice(1);
  return [...readPaths, ...searchFiles]
    .filter((filePath) => isStaticPathToken(filePath))
    .map((filePath) => ({
      path: filePath,
      action: 'read' as const,
    }));
}

/**
 * A standalone shell redirection operator token: `<`, `<<`, `<<<`, `>`, `>>`,
 * `>|`, and fd / `&`-prefixed forms (`2>`, `1>>`, `&>`, `&>>`). Used to drop the
 * operator AND its operand from a command's positional path arguments.
 */
function isRedirectOperatorToken(token: string): boolean {
  return /^(?:[0-9]+|&)?(?:<<<|<<|<|>>|>)\|?$/.test(token);
}

/**
 * Resolve the destination directory of a GNU `cp`/`mv` invocation that uses the
 * `-t` / `--target-directory` form. Returns the directory when present so the
 * caller can treat it (not the trailing positional) as the write target.
 *
 *   `--target-directory DIR` / `--target-directory=DIR`
 *   `-t DIR`  (next token) — also inside a short cluster: `-rt DIR`
 *   `-tDIR`   (attached)    — also inside a short cluster: `-rtDIR`
 *
 * Long `--` and `-T` / `--no-target-directory` (dest-is-a-file) never match.
 */
function extractTargetDirectoryFlag(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? '';
    if (arg === '--') break;
    if (arg === '-t' || arg === '--target-directory') {
      const value = args[index + 1];
      return value && isStaticPathToken(value) ? value : undefined;
    }
    if (arg.startsWith('--target-directory=')) {
      const value = arg.slice('--target-directory='.length);
      return value && isStaticPathToken(value) ? value : undefined;
    }
    // Short-option cluster (single leading dash, not `--`). GNU getopt: when
    // `t` is the last char its argument is the next token; otherwise it is the
    // rest of the cluster. Long options and `-T` are excluded because the
    // search is case-sensitive for lowercase `t`.
    if (arg.length > 1 && arg[0] === '-' && arg[1] !== '-') {
      const tIndex = arg.indexOf('t', 1);
      if (tIndex !== -1) {
        if (tIndex === arg.length - 1) {
          const value = args[index + 1];
          return value && isStaticPathToken(value) ? value : undefined;
        }
        const value = arg.slice(tIndex + 1);
        return isStaticPathToken(value) ? value : undefined;
      }
    }
  }
  return undefined;
}

/**
 * Only literal, statically-resolvable tokens are real path intents. Redirect /
 * heredoc operators (`<…`, `>…`) and shell expansions (`$VAR`, `${#x}`,
 * `$(…)`, backticks) cannot be resolved here — let the bash classifier handle
 * them instead of fabricating a bogus path check.
 */
function isStaticPathToken(token: string): boolean {
  if (!token) return false;
  if (token.startsWith('<') || token.startsWith('>')) return false;
  if (token.includes('$') || token.includes('`')) return false;
  return true;
}

/**
 * Replace heredoc / here-doc body ranges (body content + terminator line) with
 * spaces so downstream tokenization sees only the command header. Length is
 * preserved; here-strings (`<<<…`) have no body range and are filtered by
 * {@link isStaticPathToken}.
 */
function maskHeredocBodies(subcommand: string): string {
  const ranges = findHeredocBodyRanges(subcommand);
  if (ranges.length === 0) return subcommand;
  const chars = subcommand.split('');
  for (const range of ranges) {
    for (let index = range.start; index < range.end && index < chars.length; index++) {
      if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' ';
    }
  }
  return chars.join('');
}

function extractShellScriptPath(tokens: readonly string[]): string | undefined {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index] ?? '';
    if (!token) {
      index++;
      continue;
    }
    if (token === '--') {
      index++;
      continue;
    }
    if (token === '-c' || token === '--command') return undefined;
    if (token.startsWith('-')) {
      index++;
      continue;
    }
    if (!isLikelyLocalPath(token)) return undefined;
    return token;
  }
  return undefined;
}

function extractRedirectIntents(command: string): PathCapabilityIntent[] {
  const intents: PathCapabilityIntent[] = [];
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let index = 0; index < command.length; index++) {
    const ch = command[index] ?? '';
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) continue;

    const next = command[index + 1] ?? '';
    if (ch === '<' && next === '<') {
      // `<<` heredoc / `<<<` here-string operator: the following token is a
      // delimiter or literal stdin data, never a file path. Consume the whole
      // operator run so the trailing `<` of `<<<` does not fall into the single
      // `<` input-redirect read branch below (which would otherwise treat the
      // here-string content as a sensitive file read, e.g. `cat <<< ~/.ssh/id_rsa`).
      index += command[index + 2] === '<' ? 2 : 1;
      continue;
    }
    if (ch === '<') {
      // Only model a STATICALLY resolvable target. A redirect whose path is a
      // shell expansion (`$HOME/.ssh/id_rsa`, `${x}`, `$(...)`, backticks) cannot
      // be resolved here: feeding it to evaluatePathCapability makes validatePath
      // hard-DENY the unresolvable path, turning an approvable dynamic redirect
      // into an unapprovable block. Let the bash classifier handle those instead.
      const target = readRedirectTarget(command, skipWhitespace(command, index + 1));
      // Skip POSIX discard sinks (`< /dev/null` idiom). Kept in sync with
      // `bash-write-target.isDiscardSinkTarget`; without this a common
      // read-from-null form (e.g. `ssh-agent < /dev/null`) would emit a
      // read-intent on `/dev/null`, pop a permission dialog, and — the
      // real damage — persist `bash(/dev/**)` as its suggested allow rule,
      // which silently covers `/dev/tcp/<host>/<port>` (reverse-shell
      // vector already HARD-blocked upstream) and `/dev/sda*` (block
      // device). See fix commit for the full analysis.
      if (isLikelyLocalPath(target) && isStaticPathToken(target) && !isDiscardSinkTarget(target)) {
        intents.push({ path: target, action: 'read' });
      }
      continue;
    }
    if (ch === '>' || (ch === '&' && next === '>')) {
      let start = index + 1;
      if (ch === '>' && next === '>') start = index + 2;
      if (ch === '&' && next === '>') start = command[index + 2] === '>' ? index + 3 : index + 2;
      const target = readRedirectTarget(command, skipWhitespace(command, start));
      // Same static-resolvability guard as the input redirect above: a write to a
      // shell-expanded target (`echo x > $HOME/out`) must reach the bash classifier
      // (ASK), not be hard-DENIED by validatePath on the unresolvable path.
      // Also short-circuit POSIX discard sinks — `>/dev/null`, `2>/dev/null`,
      // `&>/dev/null`, `>/dev/tty` are shell idioms with zero filesystem
      // impact, and were already whitelisted by isWriteAuthorizedTarget's
      // discard-sink branch. Emitting a write-intent on `/dev/null` here
      // popped a permission dialog (the regression the fix commit repairs)
      // and its `bash(/dev/**)` suggestion would silently allow /dev/tcp
      // reverse-shell and block-device writes on the next command.
      if (isLikelyLocalPath(target) && isStaticPathToken(target) && !isDiscardSinkTarget(target)) {
        intents.push({ path: target, action: 'write' });
      }
      continue;
    }
  }

  return intents;
}

function skipWhitespace(command: string, index: number): number {
  let cursor = index;
  while (cursor < command.length && /\s/.test(command[cursor] ?? '')) cursor++;
  return cursor;
}

function readRedirectTarget(command: string, start: number): string {
  let index = start;
  let out = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  if (command[index] === '&') return '';

  while (index < command.length) {
    const ch = command[index] ?? '';
    if (escaped) {
      out += ch;
      escaped = false;
      index++;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      escaped = true;
      index++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      index++;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      index++;
      continue;
    }
    if (
      !inSingle &&
      !inDouble &&
      (/\s/.test(ch) || ch === '|' || ch === ';' || ch === '&' || ch === '<' || ch === '>')
    ) {
      break;
    }
    out += ch;
    index++;
  }
  return out;
}
