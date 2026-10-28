/**
 * Helpers for release-check.mjs, kept free of side effects so they can be unit tested.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

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
