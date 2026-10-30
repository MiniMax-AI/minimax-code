import { homedir } from 'node:os';
import path from 'node:path';
import {
  resolvePermissionPath,
  splitShellSourceSegments,
  stripDataHeredocBodies,
} from '@mavis/permission';
import { shellSourceStages } from '@mavis/shared/shell-source-stages';
import {
  readPermissionCommand,
  type LocalPermissionCheckerInput,
  type LocalPermissionCheckerResult,
} from './checker-input.js';
import { evaluateWindowsPathSafetyCheck } from './windows/path-safety.js';

export type { LocalPermissionCheckerResult, LocalPermissionCheckerInput } from './checker-input.js';
export { evaluateWindowsPathSafetyCheck } from './windows/path-safety.js';

const FS_PERMISSION_TOOLS = new Set(['edit', 'write', 'read', 'glob', 'grep', 'list']);

const HUGE_SCAN_ROOTS = new Set([
  '/',
  '/Users',
  '/home',
  '/System',
  '/Library',
  '/Applications',
  '/usr',
  '/var',
  '/opt',
  '/private',
]);

export function evaluateLocalPermissionCheck(
  input: LocalPermissionCheckerInput,
): LocalPermissionCheckerResult | undefined {
  const immune = buildLocalBypassImmuneDenyReason(input.toolName, input.input, input.workspaceDir);
  if (immune) return { behavior: 'deny', reason: immune, denyKind: 'bypass-immune' };

  const windowsPathSafety =
    input.skipWindowsHardSafetyChecks === true ? undefined : evaluateWindowsPathSafetyCheck(input);
  if (windowsPathSafety) return windowsPathSafety;

  const policy = buildLocalPolicyDenyReason(input.toolName, input.input);
  if (policy) return { behavior: 'deny', reason: policy, denyKind: 'policy' };

  if (input.toolName === 'bash') {
    const command = readPermissionCommand(input.input);
    if (!command) return undefined;
    return evaluateLocalBashCommand(command);
  }

  if (FS_PERMISSION_TOOLS.has(input.toolName)) {
    return evaluateLocalFsTool(input.toolName, input.input, input.workspaceDir);
  }

  return undefined;
}

/**
 * Reasons that survive bypassPermissions ('始终允许'). Keep narrow:
 *
 *   1. UNC / SMB share access — desktop runtime supports local filesystem access only
 *      and must never let the agent talk to network shares directly.
 *   2. Recursive deletion of `/`, `~`, drive roots — irrecoverable
 *      and not a decision a user toggle can reasonably authorize.
 *
 * Sensitive credential paths (`~/.ssh`, `*.pem`, …) are NOT here — they
 * live in `buildLocalPolicyDenyReason` so bypass mode can let the
 * engine's allow-list / cloud gateway decide.
 */
function buildLocalBypassImmuneDenyReason(
  toolName: string,
  input: Record<string, unknown>,
  workspaceDir?: string,
): string | undefined {
  const networkShare = findNetworkShareAccess(toolName, input, workspaceDir);
  if (networkShare) {
    return (
      `Local hard safety policy blocked ${toolName}: direct access to the network share ` +
      `"${networkShare}" is not supported from built-in or bash tools. Copy the file into a local workspace first.`
    );
  }
  if (toolName === 'bash') {
    const command = readPermissionCommand(input);
    // Heredoc bodies fed to cat/git as data (docs, commit messages) are not
    // shell. Bodies fed to a shell or an editor stay in the scan.
    if (command && isRootRecursiveDelete(stripDataHeredocBodies(command), workspaceDir)) {
      return (
        `Local hard safety policy blocked ${toolName}: recursive deletion targets a root or home ` +
        `directory, which is unrecoverable. Target a specific sub-path instead of "/", a drive ` +
        `root, or the home directory.`
      );
    }
  }
  return undefined;
}

/**
 * Policy-grade deny — sensitive credential / system-secret paths. The
 * facade demotes this to an ask under default/auto so the LLM gate or the
 * user can authorize. Under bypassPermissions the engine's own fast-allow /
 * rule store takes over (no facade-side block).
 *
 * Mirrors the design intent in
 * `packages/agent-modules/permission/src/tools/bash-fast-allow.ts` — sensitive
 * reads route to the LLM gate, not to a flat deny.
 * @internal Exported only for focused tests.
 */
export function buildLocalPolicyDenyReason(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  if (toolName === 'web_fetch' || toolName === 'website_deploy') {
    if (toolName === 'web_fetch') {
      const url = typeof input.url === 'string' ? input.url.trim() : '';
      return (
        `Local permission check requires approval: web_fetch will request ` +
        `${url || 'a URL'} from this device's local network context.`
      );
    }
    return (
      'Local permission check requires approval: website_deploy publishes files to a public endpoint ' +
      'on this device network context.'
    );
  }
  const values = collectPermissionPathOrCommandStrings(toolName, input);
  const sensitive = values.find(containsSensitiveLocalPath);
  if (sensitive) {
    return `Local hard safety policy blocked ${toolName}: sensitive credential path in ${sensitive}`;
  }
  return undefined;
}

function evaluateLocalBashCommand(command: string): LocalPermissionCheckerResult | undefined {
  const trimmed = command.trim();
  if (!trimmed) return undefined;
  if (hasCurlPipeShell(trimmed)) {
    return {
      behavior: 'ask',
      reason: 'Local permission check requires approval: curl-pipe-shell command.',
    };
  }
  if (hasShellSubstitution(trimmed)) {
    return {
      behavior: 'ask',
      reason: 'Local permission check requires approval: shell substitution in bash command.',
    };
  }
  if (isSlowWholeTreeScan(trimmed)) {
    return {
      behavior: 'ask',
      reason: 'Local permission check requires approval: slow unbounded filesystem scan.',
    };
  }
  if (isRecursiveRmCommand(trimmed)) {
    return {
      behavior: 'ask',
      reason: 'Local permission check requires approval: recursive rm command.',
    };
  }
  return undefined;
}

function evaluateLocalFsTool(
  toolName: string,
  input: Record<string, unknown>,
  workspaceDir: string | undefined,
): LocalPermissionCheckerResult | undefined {
  if (!workspaceDir) return undefined;
  const target = readFsToolPath(toolName, input);
  if (!target) return undefined;
  if (isWorkspacePathEscape(target, workspaceDir)) {
    return {
      behavior: 'ask',
      reason: `Local permission check requires approval: ${toolName} path escapes workspace (${target}).`,
    };
  }
  return undefined;
}

function readFsToolPath(toolName: string, input: Record<string, unknown>): string | undefined {
  const direct = input.path ?? input.filePath ?? input.file_path;
  if (typeof direct === 'string' && direct.trim()) return direct;
  if (toolName === 'glob' || toolName === 'grep' || toolName === 'list') {
    const pattern = input.pattern;
    if (typeof pattern === 'string' && pattern.trim()) return pattern;
  }
  return undefined;
}

function findNetworkShareAccess(
  toolName: string,
  input: Record<string, unknown>,
  workspaceDir: string | undefined,
): string | undefined {
  if (toolName === 'bash') {
    return findCommandNetworkShare(readPermissionCommand(input), workspaceDir);
  }

  if (!FS_PERMISSION_TOOLS.has(toolName)) return undefined;
  const target = readFsToolPath(toolName, input);
  if (!target) return undefined;
  if (isNetworkSharePath(target)) return target;
  if (workspaceDir && !isAbsolutePathLike(target) && isNetworkSharePath(workspaceDir)) {
    return `${workspaceDir.replace(/[\\/]+$/, '')}/${target}`;
  }
  return undefined;
}

function findCommandNetworkShare(
  command: string | undefined,
  workspaceDir: string | undefined,
): string | undefined {
  if (!command) return undefined;
  const commandShare = findNetworkShareToken(command);
  if (commandShare) return commandShare;
  return workspaceDir && isNetworkSharePath(workspaceDir) ? workspaceDir : undefined;
}

function findNetworkShareToken(value: string): string | undefined {
  for (const token of tokenizeShellLike(value)) {
    if (isNetworkSharePath(token)) return token;
  }
  const unc = value.match(
    /(?:^|[\s"'=])((?:\\\\\?\\UNC\\|\\\\(?!\?\\))[^\\/\s"';&|()<>]+[\\/][^\\/\s"';&|()<>]+(?:[\\/][^\s"';&|()<>]+)*)/i,
  );
  if (unc?.[1]) return unc[1];
  const slashUnc = value.match(
    /(?:^|[\s"'=])(\/\/[^/\s"';&|()<>]+\/[^/\s"';&|()<>]+(?:\/[^\s"';&|()<>]+)*)/,
  );
  return slashUnc?.[1];
}

function isNetworkSharePath(value: string): boolean {
  const trimmed = trimWrappingQuotes(value.trim());
  return (
    /^\\\\\?\\UNC\\[^\\/]+[\\/][^\\/]+/i.test(trimmed) ||
    /^\\\\(?!\?\\)[^\\/\s]+[\\/][^\\/\s]+/.test(trimmed) ||
    /^\/\/[^/\s]+\/[^/\s]+/.test(trimmed)
  );
}

function trimWrappingQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  return (first === '"' && last === '"') || (first === "'" && last === "'")
    ? value.slice(1, -1)
    : value;
}

function isAbsolutePathLike(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^[A-Za-z]:$/.test(value)
  );
}

function isWorkspacePathEscape(target: string, workspaceDir: string): boolean {
  const normalizedTarget = target.replaceAll('\\', '/').trim();
  if (looksLikeNonPathGlob(normalizedTarget)) return false;
  const workspace = resolvePathForCompare(workspaceDir);
  const resolved = resolvePathForCompare(
    path.isAbsolute(normalizedTarget)
      ? normalizedTarget
      : path.join(workspaceDir, normalizedTarget),
  );
  return resolved !== workspace && !resolved.startsWith(`${workspace}/`);
}

function looksLikeNonPathGlob(value: string): boolean {
  return !value.startsWith('/') && !value.startsWith('..') && !value.includes('/');
}

function hasCurlPipeShell(command: string): boolean {
  return (
    /\b(?:curl|wget)\b[\s\S]*\|[\s\S]*(?:^|[\s;&|])(?:sudo\s+)?(?:bash|sh|zsh|fish|dash|ksh)\b/i.test(
      command,
    ) || /\b(?:bash|sh|zsh|fish|dash|ksh)\b[\s\S]*<\s*<\s*\(?\s*(?:curl|wget)\b/i.test(command)
  );
}

function hasShellSubstitution(command: string): boolean {
  return /`[^`]*`|\$\(|<\(|>\(/.test(command);
}

function isSlowWholeTreeScan(command: string): boolean {
  return splitShellCommands(command).some((part) => {
    const tokens = tokenizeShellLike(part);
    const unwrapped = unwrapCommand(tokens);
    const commandName = commandBasename(unwrapped[0] ?? '');
    const args = unwrapped.slice(1);
    if (commandName === 'find') {
      const roots = findStartPaths(args);
      return roots.some(isHugeScanRoot) && !args.includes('-maxdepth');
    }
    if (commandName === 'rg' || commandName === 'grep') {
      if (args.some((arg) => arg === '--max-depth' || arg.startsWith('--max-depth='))) {
        return false;
      }
      return readSearchPaths(args).some(isHugeScanRoot);
    }
    if (commandName === 'tree') {
      if (args.some((arg) => arg === '-L' || /^-L\d+$/.test(arg) || arg.startsWith('--level'))) {
        return false;
      }
      return args.some(isHugeScanRoot);
    }
    return false;
  });
}

function findStartPaths(args: string[]): string[] {
  const paths: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i] ?? '';
    if (['-H', '-L', '-P'].includes(arg)) {
      i += 1;
      continue;
    }
    if (['-D', '-O'].includes(arg)) {
      i += 2;
      continue;
    }
    break;
  }
  for (; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (arg.startsWith('-') || ['(', '!', ')'].includes(arg)) break;
    paths.push(arg);
  }
  return paths;
}

function readSearchPaths(args: string[]): string[] {
  let patternSeen = false;
  const paths: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (arg === '-e' || arg === '-f' || arg === '--regexp' || arg === '--file') {
      i += 1;
      patternSeen = true;
      continue;
    }
    if (arg.startsWith('-')) continue;
    if (!patternSeen) {
      patternSeen = true;
      continue;
    }
    paths.push(arg);
  }
  return paths;
}

function isHugeScanRoot(value: string): boolean {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '') || '/';
  return (
    HUGE_SCAN_ROOTS.has(normalized) ||
    normalized === '~' ||
    normalized === '$HOME' ||
    /^\$\{HOME\}$/.test(normalized) ||
    /^[A-Za-z]:$/.test(normalized)
  );
}

function isRecursiveRmCommand(command: string): boolean {
  return splitShellCommands(command).some((part) => {
    const tokens = unwrapCommand(tokenizeShellLike(part));
    const commandName = commandBasename(tokens[0] ?? '');
    if (commandName !== 'rm') return false;
    return tokens.slice(1).some((token) => token.startsWith('-') && /r/i.test(token));
  });
}

function splitShellCommands(command: string): string[] {
  return command
    .split(/&&|\|\||[;\n\r]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function unwrapCommand(tokens: string[]): string[] {
  let cursor = 0;
  while (cursor < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[cursor] ?? '')) {
    cursor += 1;
  }
  while (cursor < tokens.length) {
    const name = commandBasename(tokens[cursor] ?? '');
    if (name === 'sudo' || name === 'env' || name === 'command' || name === 'exec') {
      cursor += 1;
      continue;
    }
    break;
  }
  return tokens.slice(cursor);
}

function collectPermissionPathOrCommandStrings(
  toolName: string,
  input: Record<string, unknown>,
): string[] {
  const values = [
    input.path,
    input.filePath,
    input.file_path,
    toolName === 'grep' ? undefined : input.pattern,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  if (toolName === 'bash') {
    const command = readPermissionCommand(input);
    if (command && !values.includes(command)) values.push(command);
  }
  return values;
}

const SENSITIVE_LOCAL_PATHS = [
  /(^|[/\s"'=:$])(?:~\/|\$home\/|\$\{home\}\/)?\.ssh(\/|$|[\s"';&|)])/i,
  /(^|[/\s"'=:$])(?:~\/|\$home\/|\$\{home\}\/)?\.aws(\/|$|[\s"';&|)])/i,
  /(^|[/\s"'=:$])(?:~\/|\$home\/|\$\{home\}\/)?\.config\/gcloud(\/|$|[\s"';&|)])/i,
  /(^|[/\s"'=:$])(?:~\/|\$home\/|\$\{home\}\/)?\.kube\/config(?=$|[\s"';&|)])/i,
  /(^|[/\s"'=:$])(?:~\/|\$home\/|\$\{home\}\/)?\.docker\/config\.json(?=$|[\s"';&|)])/i,
  /(^|[/\s"'=:$])(?:~\/|\$home\/|\$\{home\}\/)?\.gnupg(\/|$|[\s"';&|)])/i,
  /(^|[/\s"'=:$])(?:~\/|\$home\/|\$\{home\}\/)?\.npmrc(?=$|[\s"';&|)])/i,
  /(^|[/\s"'=:$])(?:~\/|\$home\/|\$\{home\}\/)?\.netrc(?=$|[\s"';&|)])/i,
  /(^|[/\s"'=:$])(?:~\/|\$home\/|\$\{home\}\/)?\.git-credentials(?=$|[\s"';&|)])/i,
  /(^|[/\s"'=:$])(?:~\/|\$home\/|\$\{home\}\/)?\.env(\.|$|[\s"';&|)])/i,
  /(^|[/\s"'=:$])(?:id_(?:rsa|dsa|ecdsa|ed25519)|[^/\s"';&|)]+\.(?:key|pem|p12|pfx))(?=$|[\s"';&|)])/i,
];

function containsSensitiveLocalPath(value: string): boolean {
  return sensitivePathVariants(value).some((normalized) =>
    SENSITIVE_LOCAL_PATHS.some((pattern) => pattern.test(normalized)),
  );
}

function sensitivePathVariants(value: string): string[] {
  const variants = new Set<string>();
  for (const candidate of [value, value.replace(/\\(.)/g, '$1')]) {
    variants.add(candidate.replaceAll('\\', '/').replace(/['"]/g, '').toLowerCase());
  }
  return [...variants];
}

interface ShellDeleteStage {
  readonly command: string;
  readonly directory: string | undefined;
}

function isRootRecursiveDelete(command: string, workspaceDir?: string, depth = 0): boolean {
  return shellDeleteStages(command, workspaceDir).some((stage) =>
    isRootRecursiveDeleteStage(stage, depth),
  );
}

/**
 * Dynamic shell flow has no trustworthy cwd. Still inspect each command
 * separately so options (including --) cannot leak across command boundaries.
 */
function shellDeleteStages(command: string, workspaceDir: string | undefined): ShellDeleteStage[] {
  const stages = shellSourceStages(command, workspaceDir, resolveLiteralDeletePath);
  if (stages.length > 0) return stages;
  return splitShellSourceSegments(command).map((segment) => ({
    command: segment,
    directory: undefined,
  }));
}

function isRootRecursiveDeleteStage(stage: ShellDeleteStage, depth: number): boolean {
  const tokens = tokenizeShellLike(stage.command);
  const commandIndex = tokens.length - unwrapCommand(tokens).length;
  if (depth < 4 && hasNestedRootDelete(tokens, { ...stage, commandIndex, depth })) return true;
  return tokens.some(
    (token, index) =>
      commandBasename(token).toLowerCase() === 'rm' &&
      hasRecursiveRootTarget(
        tokens.slice(index + 1),
        index === commandIndex ? stage.directory : undefined,
      ),
  );
}

function hasNestedRootDelete(
  tokens: string[],
  stage: ShellDeleteStage & { readonly commandIndex: number; readonly depth: number },
): boolean {
  for (let i = 0; i < tokens.length - 2; i += 1) {
    if (!isShellEvalCommand(tokens[i]!)) continue;
    if (!isShellEvalOption(tokens[i + 1]!)) continue;
    // Login shells and unsupported wrapper options may change cwd.
    const directory =
      i === stage.commandIndex && tokens[i + 1] === '-c' ? stage.directory : undefined;
    if (isRootRecursiveDelete(tokens[i + 2]!, directory, stage.depth + 1)) return true;
  }
  return false;
}

/** rm accepts options after operands, but never after its -- delimiter. */
function hasRecursiveRootTarget(args: string[], directory: string | undefined): boolean {
  const operands = readRmOperands(args);
  return (
    operands.recursive &&
    (operands.hasWhitespaceExpansion ||
      operands.targets.some((target) => isRootOrHomeDeleteTarget(target, directory)))
  );
}

function readRmOperands(args: string[]): {
  recursive: boolean;
  hasWhitespaceExpansion: boolean;
  targets: string[];
} {
  let recursive = false;
  let pastDoubleDash = false;
  let hasWhitespaceExpansion = false;
  const targets: string[] = [];
  for (const token of args) {
    if (!pastDoubleDash && token === '--') {
      pastDoubleDash = true;
      continue;
    }
    hasWhitespaceExpansion ||= containsShellWhitespaceExpansion(token);
    if (!pastDoubleDash && isShellOption(token)) {
      recursive ||= /[rR]/.test(token);
      continue;
    }
    targets.push(token);
  }
  return { recursive, hasWhitespaceExpansion, targets };
}

function resolveLiteralDeletePath(target: string, workspaceDir?: string): string | undefined {
  // Brace expansion and escaped shell syntax are not literal path identities.
  if (
    /[{}\\]/.test(target) ||
    (target.startsWith('~') && target !== '~' && !target.startsWith('~/'))
  ) {
    return undefined;
  }
  return resolvePermissionPath(target, {
    workingDirectory: workspaceDir && path.isAbsolute(workspaceDir) ? workspaceDir : undefined,
    homeDir: homedir(),
  }).resolved;
}

function isShellOption(token: string): boolean {
  return token.startsWith('-') && token.length > 1;
}

function containsShellWhitespaceExpansion(token: string): boolean {
  return /\$\{?ifs(?:\b|[:}])/i.test(token);
}

function isShellEvalCommand(token: string): boolean {
  return ['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'].includes(commandBasename(token));
}

function isShellEvalOption(token: string): boolean {
  return token.startsWith('-') && token.includes('c');
}

function tokenizeShellLike(command: string): string[] {
  return (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) =>
    token.replace(/^['"]|['"]$/g, ''),
  );
}

function commandBasename(token: string): string {
  return token.replaceAll('\\', '/').split('/').pop() || token;
}

/**
 * A glob has no single resolved path. Resolve its literal parent instead,
 * preserving the existing top-level home rule without blocking child globs.
 */
function resolvesToRootOrHome(target: string, workspaceDir: string | undefined): boolean {
  const globIndex = /[$`\\]/.test(target) ? -1 : target.search(/[*?[{]/);
  const literalTarget =
    globIndex < 0 ? target : target.slice(0, target.lastIndexOf('/', globIndex) + 1) || '.';
  const resolved = resolveLiteralDeletePath(literalTarget, workspaceDir);
  if (!resolved || !path.isAbsolute(resolved)) return false;
  const normalized = path.resolve(resolved);
  const home = path.resolve(homedir());
  return (
    normalized === path.parse(normalized).root ||
    (process.platform === 'win32'
      ? normalized.toLowerCase() === home.toLowerCase()
      : normalized === home)
  );
}

function isRootOrHomeDeleteTarget(target: string, workspaceDir?: string): boolean {
  if (resolvesToRootOrHome(target, workspaceDir)) return true;
  const bracedHome = ['$', '{home}'].join('');
  const bracedHomeOpen = ['$', '{home'].join('');
  const raw = target.toLowerCase().replaceAll('\\', '/');
  if (raw === '/' || raw.startsWith('/*') || raw.startsWith('/.*')) return true;
  if (/^[a-z]:(?:\/?$|\/(?:\*|\.))/.test(raw)) return true;
  if (/^\/\/[^/]+\/[^/]+(?:\/?$|\/(?:\*|\.))/.test(raw)) return true;
  const normalized = raw.replace(/\/+$/, '');
  // Home-directory forms mirror the `/` handling above: block only the
  // bare home (`~`, `$HOME`, `${HOME}`) or a top-level *glob* at home
  // whose first path segment contains any shell glob/brace metacharacter
  // (`*`, `?`, `[`, `{`). This covers `~/*`, `~/.*`, `~/[!.]*`, `~/?*`,
  // `${HOME}/{Desktop,Downloads}`, etc. — every one of them expands to
  // a batch of top-level home entries and would be catastrophic to
  // hard-delete. Do NOT block ordinary subpaths like `~/Desktop/hihi`
  // (no metachars in the first segment) — the caller runs this check
  // bypass-immune, so a plain-subpath match here would prevent the
  // permission engine's `rm → mavis-trash` rewrite from ever taking
  // effect and force the model to fall back to a hard delete.
  const isBareHome = (form: string): boolean => normalized === form;
  const hasTopLevelHomeGlob = (form: string): boolean => {
    const prefix = `${form}/`;
    if (!normalized.startsWith(prefix)) return false;
    const remainder = normalized.slice(prefix.length);
    // Extract the first path segment after the home prefix. Anything
    // before the first `/` decides the fan-out; nested `foo/*` under a
    // literal first segment is fine (the rewrite handles it).
    const firstSegment = remainder.split('/')[0] ?? '';
    return /[*?[{]/.test(firstSegment);
  };
  if (['~', '$home', bracedHome].some((form) => isBareHome(form) || hasTopLevelHomeGlob(form))) {
    return true;
  }
  // `${home` followed by parameter-expansion syntax (`:`, `-`, `+`, `?`,
  // `=`, `#`, `%`) or an unterminated brace — the resolved value is
  // unclear at parse time, so treat it as suspicious. `${home}` (closed)
  // followed by nothing or `/subpath` is handled by the branches above
  // and falls through to the plain rules.
  if (normalized.startsWith(bracedHomeOpen) && !normalized.startsWith(bracedHome)) {
    return true;
  }
  return false;
}

function resolvePathForCompare(value: string): string {
  const resolved = path.resolve(value.replaceAll('\\', path.sep));
  const normalized = resolved.split(path.sep).join('/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
