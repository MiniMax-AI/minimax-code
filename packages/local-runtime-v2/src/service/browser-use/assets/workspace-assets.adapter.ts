import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';

import {
  LOCAL_BROWSER_ACTION_NAMES,
  type LocalBrowserAdapter,
  type LocalBrowserAsset,
  type LocalBrowserToolAction,
  type LocalRuntimeToolContext,
} from '@mavis/agent-tools/desktop';

const MAX_BROWSER_UPLOAD_FILES = 20;
const MAX_BROWSER_UPLOAD_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_BROWSER_SCRIPT_BYTES = 200 * 1024;
const BROWSER_SCRIPT_EXTENSIONS: Readonly<Record<string, true>> = { '.js': true, '.mjs': true };
const LEGACY_BROWSER_ACTIONS = [
  'wait_for',
  'get_dom',
  'verify_text',
  'inspect_editable_targets',
] as const satisfies readonly LocalBrowserToolAction[];
const DEFAULT_BROWSER_ACTIONS: readonly LocalBrowserToolAction[] = [
  ...LOCAL_BROWSER_ACTION_NAMES,
  ...LEGACY_BROWSER_ACTIONS,
];
const MIME_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
};

export function createWorkspaceBrowserAssetAdapter(
  delegate: LocalBrowserAdapter,
  options: { readonly workspaceRoot: string },
): LocalBrowserAdapter {
  return {
    getCapabilities: () =>
      delegate.getCapabilities?.() ?? {
        provider: 'local-workspace-browser',
        version: 1,
        actions: DEFAULT_BROWSER_ACTIONS,
      },
    notifyLifecycle: (event) => delegate.notifyLifecycle?.(event),
    async execute(ctx, action, input, signal) {
      throwIfAborted(signal);
      if (action === 'run_script' && typeof input.path === 'string') {
        return delegate.execute(
          ctx,
          action,
          await readWorkspaceScript(input, options.workspaceRoot),
          signal,
        );
      }
      if (action !== 'upload_files') return delegate.execute(ctx, action, input, signal);
      const files = await resolveAuthorizedUploadPaths(ctx, input, options.workspaceRoot, signal);
      return delegate.execute(
        { ...ctx, browserAssets: files },
        action,
        { ...input, paths: files.map((file) => file.filePath) },
        signal,
      );
    },
  };
}

/**
 * Replace a workspace script path with its source. The script keeps its
 * workspace-relative filename so error locations point at the saved file.
 */
async function readWorkspaceScript(
  input: Record<string, unknown>,
  workspaceRoot: string,
): Promise<Record<string, unknown>> {
  const submitted = String(input.path).trim();
  const root = await realpath(workspaceRoot);
  const candidate = isAbsolute(submitted) ? submitted : resolve(root, submitted);
  let fileRealPath: string;
  try {
    fileRealPath = await realpath(candidate);
  } catch {
    throw new Error('SCRIPT_NOT_FOUND: run_script path does not exist');
  }
  if (!isPathInside(root, fileRealPath)) {
    throw new Error('SCRIPT_NOT_AUTHORIZED: run_script path must be inside the active workspace');
  }
  if (!BROWSER_SCRIPT_EXTENSIONS[extname(fileRealPath).toLowerCase()]) {
    throw new Error('SCRIPT_NOT_AUTHORIZED: run_script path must be a .js or .mjs file');
  }
  const fileStat = await stat(fileRealPath);
  if (!fileStat.isFile()) throw new Error('SCRIPT_NOT_AUTHORIZED: run_script path is not a file');
  if (fileStat.size > MAX_BROWSER_SCRIPT_BYTES) {
    throw new Error(`SCRIPT_TOO_LARGE: run_script file exceeds ${MAX_BROWSER_SCRIPT_BYTES} bytes`);
  }
  const code = await readFile(fileRealPath, 'utf8');
  const forwarded: Record<string, unknown> = {
    ...input,
    code,
    filename: relative(root, fileRealPath).split(sep).join('/'),
  };
  delete forwarded.path;
  return forwarded;
}

async function resolveAuthorizedUploadPaths(
  ctx: LocalRuntimeToolContext,
  input: Record<string, unknown>,
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<LocalBrowserAsset[]> {
  const submittedPaths = requireSubmittedPaths(input.paths);
  const root = await realpath(workspaceRoot);
  const currentTurnAttachments = new Map(
    (ctx.browserAssets ?? []).map((asset) => [asset.filePath, asset] as const),
  );
  const files: LocalBrowserAsset[] = [];
  let totalBytes = 0;

  for (const submittedPath of submittedPaths) {
    throwIfAborted(signal);
    const resolved = await resolveAuthorizedUploadPath(submittedPath, root, currentTurnAttachments);
    totalBytes += resolved.bytes;
    if (totalBytes > MAX_BROWSER_UPLOAD_TOTAL_BYTES) {
      throw new Error('FILE_TOO_LARGE: Browser upload exceeds the 512 MiB limit');
    }
    files.push(resolved.asset);
  }
  return files;
}

function requireSubmittedPaths(paths: unknown): unknown[] {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('FILE_NOT_AUTHORIZED: no upload paths were provided');
  }
  if (paths.length > MAX_BROWSER_UPLOAD_FILES) {
    throw new Error(`FILE_NOT_AUTHORIZED: at most ${MAX_BROWSER_UPLOAD_FILES} files are allowed`);
  }
  return paths;
}

async function resolveAuthorizedUploadPath(
  submittedPath: unknown,
  root: string,
  currentTurnAttachments: ReadonlyMap<string, LocalBrowserAsset>,
): Promise<{ readonly asset: LocalBrowserAsset; readonly bytes: number }> {
  if (typeof submittedPath !== 'string' || submittedPath.trim().length === 0) {
    throw new Error('FILE_NOT_AUTHORIZED: every upload path must be a non-empty string');
  }
  const attachment = currentTurnAttachments.get(submittedPath);
  let candidate = submittedPath;
  if (attachment) candidate = attachment.filePath;
  else if (!isAbsolute(submittedPath)) candidate = resolve(root, submittedPath);

  const fileRealPath = await resolveExistingFile(candidate);
  if (!attachment && !isPathInside(root, fileRealPath)) {
    throw new Error(
      'FILE_NOT_AUTHORIZED: upload path is neither a current-turn attachment nor an active-workspace file',
    );
  }
  const fileStat = await stat(fileRealPath);
  if (!fileStat.isFile()) {
    throw new Error('FILE_NOT_AUTHORIZED: Browser uploads require regular files');
  }
  const fileName = attachment?.fileName ?? basename(fileRealPath);
  return {
    asset: {
      filePath: fileRealPath,
      fileName,
      mimeType: attachment?.mimeType ?? inferMimeType(fileName),
    },
    bytes: fileStat.size,
  };
}

async function resolveExistingFile(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch {
    throw new Error('FILE_NOT_AUTHORIZED: upload file does not exist');
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function inferMimeType(fileName: string): string {
  return MIME_TYPE_BY_EXTENSION[extname(fileName).toLowerCase()] ?? 'application/octet-stream';
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Operation aborted');
}
