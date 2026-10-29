/**
 * Helpers for release-check.mjs, kept free of side effects so they can be unit tested.
 * Run directly, this file is the `prepublishOnly` guard and always refuses a directory publish.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const NPMJS_REGISTRY = 'https://registry.npmjs.org/';
export const PACKAGE_SCOPE = '@minimax-ai';

/**
 * Every npm command that talks to a registry gets both flags. `publishConfig.registry` and
 * `--registry` only replace the default registry; a configured `@minimax-ai:registry` would still
 * win for this scoped package, so the scope is pinned explicitly as well.
 */
export const NPMJS_TARGET_ARGS = Object.freeze([
  `--registry=${NPMJS_REGISTRY}`,
  `--${PACKAGE_SCOPE}:registry=${NPMJS_REGISTRY}`,
]);

/** Normalizes `npm config get` output; npm prints `undefined` for unset keys. */
export function normalizeRegistry(value) {
  const text = String(value ?? '').trim();
  if (!text || text === 'undefined' || text === 'null') return '';
  try {
    const url = new URL(text);
    return url.href.endsWith('/') ? url.href : `${url.href}/`;
  } catch {
    return text;
  }
}

/** Why the effective npm configuration could publish or read the package elsewhere, if it could. */
export function scopedRegistryProblem(scopedRegistry) {
  const scoped = normalizeRegistry(scopedRegistry);
  if (!scoped || scoped === NPMJS_REGISTRY) return undefined;
  return (
    `${PACKAGE_SCOPE}:registry is set to ${scoped}. It overrides publishConfig and --registry for ` +
    `${PACKAGE_SCOPE} packages, so publish and read-back would use that registry. Remove it ` +
    `(npm config delete ${PACKAGE_SCOPE}:registry) or set it to ${NPMJS_REGISTRY}, then run ` +
    'release:check again.'
  );
}

/** The publish command printed for a maintainer to run. */
export function publishCommand(tarball) {
  return ['npm', 'publish', tarball, ...NPMJS_TARGET_ARGS, '--access', 'public', '--tag', 'latest'];
}

/** Read-back commands printed after a successful check. */
export function readBackCommands(spec, name) {
  return [
    ['npm', 'view', spec, 'version', 'dist.integrity', ...NPMJS_TARGET_ARGS],
    ['npm', 'view', name, 'dist-tags', ...NPMJS_TARGET_ARGS],
  ];
}

/**
 * How to start a tool without a shell. Node.js refuses to spawn `.cmd` files without a shell
 * on Windows, so npm and pnpm run through their JS entry with the current Node.js there.
 */
export function resolveTool(
  name,
  {
    platform = process.platform,
    env = process.env,
    execPath = process.execPath,
    exists = existsSync,
  } = {},
) {
  if (name === 'node') return { command: execPath, args: [] };
  if (platform !== 'win32') return { command: name, args: [] };
  // git.exe and the bsdtar shipped with Windows 10+ are native executables.
  if (name === 'git' || name === 'tar') return { command: name, args: [] };
  const execPathEnv = env.npm_execpath ?? '';
  const runsWith = (file) =>
    /\.exe$/iu.test(file) ? { command: file, args: [] } : { command: execPath, args: [file] };
  if (name === 'pnpm') {
    if (
      /pnpm[^\\/]*$/iu.test(path.win32.basename(execPathEnv)) ||
      /[\\/]pnpm[\\/]/iu.test(execPathEnv)
    ) {
      if (exists(execPathEnv)) return runsWith(execPathEnv);
    }
    throw new Error(
      'On Windows, run release:check through pnpm (pnpm --filter @minimax-ai/code-sdk run release:check).',
    );
  }
  if (name === 'npm') {
    const candidates = [
      /npm-cli\.js$/iu.test(execPathEnv) ? execPathEnv : '',
      path.win32.join(path.win32.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ].filter(Boolean);
    const cli = candidates.find((candidate) => exists(candidate));
    if (cli) return { command: execPath, args: [cli] };
    throw new Error(
      `Cannot find npm-cli.js next to ${execPath}. release:check needs the npm that ships with Node.js on Windows.`,
    );
  }
  throw new Error(`Unsupported tool ${name}`);
}

/**
 * Local paths that must not appear in a published tarball. Covers macOS and Linux home
 * directories, root's home, macOS per-user temp folders, and both the single-backslash and
 * the escaped `C:\\Users\\` forms that show up in JS strings, JSON and source maps.
 */
export const LOCAL_USER_PATH =
  /(?:\/Users\/|\/home\/[^/\s]+\/|\/root\/|\/private\/var\/folders\/|[A-Za-z]:\\Users\\|[A-Za-z]:\\\\Users\\\\)/u;

/** Package-local scan rules. Shared credential and host patterns are added by release-check. */
export const PACKAGE_TEXT_RULES = Object.freeze([
  ['local user path', LOCAL_USER_PATH],
  ['repository package path', /\b(?:packages\/(?!code-sdk\b)[\w.-]+|third_party)\//u],
  ['internal package name', /@minimax\/code\b|@mavis\//u],
]);

/** npm pack paths, relative to the tarball root. One directory level under dist/ and src/. */
export const TARBALL_ENTRY =
  /^package\/(?:package\.json|README\.md|CHANGELOG\.md|LICENSE|(?:dist|src)\/[^/]+\.(?:js|js\.map|d\.ts|d\.ts\.map|ts))$/u;

export const REQUIRED_TARBALL_ENTRIES = Object.freeze([
  'package/package.json',
  'package/README.md',
  'package/CHANGELOG.md',
  'package/LICENSE',
  'package/dist/index.js',
  'package/dist/index.d.ts',
]);

export const DIRECTORY_PUBLISH_MESSAGE = [
  'Refusing to publish @minimax-ai/code-sdk from the package directory.',
  'Run `pnpm --filter @minimax-ai/code-sdk run release:check` on an up-to-date main and publish the checked tarball that command prints.',
  '`npm publish <tarball>` does not run this script. `npm publish` in this directory does, and it would skip release:check.',
].join('\n');

/** Rule labels from `rules` that match `text`, if any. */
export function textLabels(text, rules) {
  return rules
    .filter(([, pattern]) => {
      pattern.lastIndex = 0;
      return pattern.test(text);
    })
    .map(([label]) => label);
}

/** Allowlist result for `npm pack` entry names (directories omitted). */
export function tarballProblems(entries) {
  const files = entries.filter((entry) => entry && !entry.endsWith('/'));
  return {
    unexpected: files.filter(
      (entry) => !TARBALL_ENTRY.test(entry) || entry.split('/').includes('..'),
    ),
    missing: REQUIRED_TARBALL_ENTRIES.filter((entry) => !files.includes(entry)),
  };
}

/** A shell word for the command printed to a maintainer. Not used to spawn a process. */
export function shellWord(value) {
  return /^[\w@%+=:,./-]+$/u.test(value) ? value : `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function formatCommand(command) {
  return command.map(shellWord).join(' ');
}

/** True when release:check must not print an `npm publish` command. */
export function isReleaseRehearsal({ branch, head, remoteMain, releaseBranch = 'main' }) {
  return branch !== releaseBranch || head !== remoteMain;
}

/**
 * Closing lines of release:check. A rehearsal (any branch other than an up-to-date main) does
 * not include a publish command.
 */
export function releaseClosingLines({
  rehearsal,
  spec,
  releaseBranch,
  tarball,
  integrity,
  version,
  name,
}) {
  const lines = [
    rehearsal
      ? `\n! Rehearsal passed for ${spec}. Do not publish this tarball: release from an up-to-date ${releaseBranch}.`
      : `\n✓ ${spec} is ready. The tarball was checked but nothing was published.`,
  ];
  if (rehearsal) return lines;
  const [viewVersion, viewTags] = readBackCommands(spec, name);
  lines.push(
    '\nPublish it yourself (npm login with 2FA required):\n',
    `  ${formatCommand(publishCommand(tarball))}`,
    `\nThen read it back:\n\n  ${formatCommand(viewVersion)}   # expect ${integrity}`,
    `  ${formatCommand(viewTags)}   # expect latest: ${version}`,
  );
  return lines;
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isDirectRun()) {
  console.error(DIRECTORY_PUBLISH_MESSAGE);
  process.exit(1);
}
