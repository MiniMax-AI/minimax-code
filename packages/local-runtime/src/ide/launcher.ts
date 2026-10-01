import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  IDE_APPS_CACHE_TTL_MS,
  IDE_APP_RESOLVE_CONCURRENCY,
  IDE_CATALOG,
  IDE_PATH_PROBE_CONCURRENCY,
  IDE_UNAVAILABLE_REASON,
  type IdeAppInfo,
  type IdeAppsResponse,
  type IdeCatalogEntry,
  type ResolvedIdeAppInfo,
} from './catalog.js';

const execFile = promisify(execFileCallback);

interface IdeAppsCacheEntry {
  expiresAt: number;
  apps: ResolvedIdeAppInfo[];
}

interface IdeOpenTarget {
  workspaceRoot?: string;
  filePath?: string;
}

interface RunCommandOptions {
  windowsHide?: boolean;
  windowsVerbatimArguments?: boolean;
  ignoreExitCode?: boolean;
}

export class IdeLauncherError extends Error {
  readonly status: number;

  readonly code: string;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'IdeLauncherError';
    this.code = code;
    this.status = status;
  }
}

function stripIdeLaunchFields(app: ResolvedIdeAppInfo): IdeAppInfo {
  const result: IdeAppInfo = {
    id: app.id,
    name: app.name,
    family: app.family,
    available: app.available,
  };
  if (app.appPath) result.appPath = app.appPath;
  if (app.iconDataUrl) result.iconDataUrl = app.iconDataUrl;
  if (app.unavailableReason) result.unavailableReason = app.unavailableReason;
  return result;
}

function cloneResolvedIdeApps(apps: ResolvedIdeAppInfo[]): ResolvedIdeAppInfo[] {
  return apps.map((app) => ({ ...app }));
}

function expandTilde(input: string): string {
  return input.startsWith('~') ? path.join(homedir(), input.slice(1)) : input;
}

function resolvePath(input: string): string {
  return path.resolve(expandTilde(input));
}

function isPathInsideOrEqual(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function assertWithinWorkspace(workspaceRoot: string, filePath: string): void {
  const target = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(workspaceRoot, filePath);
  if (!isPathInsideOrEqual(workspaceRoot, target)) {
    throw new IdeLauncherError('Path traversal denied', 'PATH_TRAVERSAL', 400);
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(items[index] as T, index);
      }
    }),
  );
  return results;
}

async function firstExistingPathConcurrent(candidates: string[]): Promise<string | null> {
  if (candidates.length === 0) return null;
  const results = await mapWithConcurrency(
    candidates,
    IDE_PATH_PROBE_CONCURRENCY,
    async (candidate) => ((await pathExists(candidate)) ? candidate : null),
  );
  return results.find((candidate): candidate is string => Boolean(candidate)) ?? null;
}

function macApplicationRoots(): string[] {
  const roots = [
    '/Applications',
    '/System/Applications',
    '/System/Applications/Utilities',
    '/System/Library/CoreServices',
  ];
  const home = homedir();
  if (home) roots.push(path.join(home, 'Applications'));
  return roots;
}

function findContainingMacApp(targetPath: string): string | null {
  let current = path.resolve(targetPath);
  const root = path.parse(current).root;
  while (current && current !== root) {
    if (path.extname(current) === '.app') return current;
    current = path.dirname(current);
  }
  return null;
}

async function assertRegularFileExists(absolutePath: string): Promise<void> {
  try {
    const info = await fs.stat(absolutePath);
    if (!info.isFile()) {
      throw new IdeLauncherError('File not found', 'NOT_FOUND', 404);
    }
  } catch (error) {
    if (error instanceof IdeLauncherError) throw error;
    throw new IdeLauncherError('File not found', 'NOT_FOUND', 404);
  }
}

async function runCommand(
  file: string,
  args: string[],
  options: RunCommandOptions = {},
): Promise<void> {
  const needsShell = process.platform === 'win32' && !/\.(exe|com)$/i.test(file);
  try {
    if (needsShell) {
      const quoted = [`"${file}"`, ...args.map((a) => `"${a}"`)].join(' ');
      await execFile('cmd.exe', ['/d', '/s', '/c', `"${quoted}"`], {
        windowsHide: options.windowsHide ?? true,
        windowsVerbatimArguments: true,
      });
    } else {
      await execFile(file, args, {
        windowsHide: options.windowsHide ?? true,
        windowsVerbatimArguments: options.windowsVerbatimArguments,
      });
    }
  } catch (error) {
    if (options.ignoreExitCode) return;
    const message = error instanceof Error ? error.message : String(error);
    throw new IdeLauncherError(message || `Failed to start ${file}`, 'IDE_OPEN_FAILED', 422);
  }
}

async function whichBinary(binary: string): Promise<string | null> {
  if (!binary) return null;
  const command = process.platform === 'win32' ? 'where' : 'which';
  try {
    const result = await execFile(command, [binary], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const stdout = String(result.stdout ?? '');
    return (
      stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .find(Boolean) ?? null
    );
  } catch {
    return null;
  }
}

export class IdeLauncher {
  private readonly ideAppsCache = new Map<NodeJS.Platform, IdeAppsCacheEntry>();

  private readonly ideAppsRequests = new Map<NodeJS.Platform, Promise<ResolvedIdeAppInfo[]>>();

  async listIdeApps(): Promise<IdeAppsResponse> {
    return this.resolveCachedIdeApps();
  }

  async openWorkspaceInIde(
    workspaceDir: string | undefined,
    ideId: string,
    filePath?: string,
  ): Promise<void> {
    const entry = IDE_CATALOG.find((item) => item.id === ideId);
    if (!entry) {
      throw new IdeLauncherError(`Unsupported IDE: ${ideId}`, 'IDE_APP_UNSUPPORTED', 400);
    }
    const target = await this.resolveIdeOpenTarget(workspaceDir, filePath);

    const cachedApp = this.getCachedIdeApp(ideId);
    if (cachedApp?.available && cachedApp.launchTarget && cachedApp.launchKind) {
      try {
        await this.launchIdeOpenTarget(target, entry, cachedApp);
        return;
      } catch {
        // The cached launch target may be stale; fall through to a fresh resolve.
      }
    }

    const app = await this.resolveIdeApp(entry);
    await this.launchIdeOpenTarget(target, entry, app);
    this.updateCachedIdeApp(process.platform, app);
  }

  private async resolveWorkspaceDirectory(workspaceDir: string): Promise<string> {
    const workspaceRoot = resolvePath(workspaceDir);
    try {
      const info = await fs.stat(workspaceRoot);
      if (!info.isDirectory()) {
        throw new IdeLauncherError('Workspace is not a directory', 'NOT_A_DIRECTORY', 400);
      }
      return workspaceRoot;
    } catch (error) {
      if (error instanceof IdeLauncherError) throw error;
      throw new IdeLauncherError('Workspace not found', 'NOT_FOUND', 404);
    }
  }

  private async resolveIdeOpenTarget(
    workspaceDir?: string,
    filePath?: string,
  ): Promise<IdeOpenTarget> {
    const workspaceRoot = workspaceDir
      ? await this.resolveWorkspaceDirectory(workspaceDir)
      : undefined;
    const trimmedPath = filePath?.trim();

    if (!trimmedPath) {
      if (workspaceRoot) return { workspaceRoot };
      throw new IdeLauncherError('workspace or path is required', 'VALIDATION_ERROR', 400);
    }

    if (workspaceRoot) {
      assertWithinWorkspace(workspaceRoot, trimmedPath);
      const absoluteFilePath = path.isAbsolute(trimmedPath)
        ? path.resolve(trimmedPath)
        : path.resolve(workspaceRoot, trimmedPath);
      try {
        await assertRegularFileExists(absoluteFilePath);
        return { workspaceRoot, filePath: absoluteFilePath };
      } catch {
        return { workspaceRoot };
      }
    }

    const expandedPath = expandTilde(trimmedPath);
    if (!path.isAbsolute(expandedPath)) {
      throw new IdeLauncherError(
        'path must be absolute when workspace is not provided',
        'VALIDATION_ERROR',
        400,
      );
    }
    const absoluteFilePath = path.resolve(expandedPath);
    await assertRegularFileExists(absoluteFilePath);
    return { filePath: absoluteFilePath };
  }

  private async resolveCachedIdeApps(): Promise<IdeAppsResponse> {
    const platform = process.platform;
    const now = Date.now();
    const cached = this.ideAppsCache.get(platform);
    if (cached) {
      const stale = cached.expiresAt <= now;
      if (stale) this.refreshIdeAppsCacheInBackground(platform);
      return {
        apps: cached.apps.map(stripIdeLaunchFields),
        stale,
      };
    }

    return {
      apps: (await this.refreshIdeAppsCache(platform)).map(stripIdeLaunchFields),
      stale: false,
    };
  }

  private refreshIdeAppsCacheInBackground(platform: NodeJS.Platform): void {
    void this.refreshIdeAppsCache(platform).catch(() => undefined);
  }

  private async refreshIdeAppsCache(platform: NodeJS.Platform): Promise<ResolvedIdeAppInfo[]> {
    const existingRequest = this.ideAppsRequests.get(platform);
    if (existingRequest) return existingRequest;

    const request = this.scanIdeApps()
      .then((apps) => {
        this.ideAppsCache.set(platform, {
          expiresAt: Date.now() + IDE_APPS_CACHE_TTL_MS,
          apps: cloneResolvedIdeApps(apps),
        });
        return apps;
      })
      .finally(() => {
        this.ideAppsRequests.delete(platform);
      });

    this.ideAppsRequests.set(platform, request);
    return request;
  }

  private getCachedIdeApp(ideId: string): ResolvedIdeAppInfo | null {
    const cached = this.ideAppsCache.get(process.platform);
    if (!cached) return null;
    const app = cached.apps.find((item) => item.id === ideId);
    return app ? { ...app } : null;
  }

  private updateCachedIdeApp(platform: NodeJS.Platform, app: ResolvedIdeAppInfo): void {
    const cached = this.ideAppsCache.get(platform);
    if (!cached) return;
    this.ideAppsCache.set(platform, {
      expiresAt: cached.expiresAt,
      apps: cached.apps.map((item) => (item.id === app.id ? { ...app } : { ...item })),
    });
  }

  private async scanIdeApps(): Promise<ResolvedIdeAppInfo[]> {
    return mapWithConcurrency(IDE_CATALOG, IDE_APP_RESOLVE_CONCURRENCY, (entry) =>
      this.resolveIdeApp(entry),
    );
  }

  private async resolveIdeApp(entry: IdeCatalogEntry): Promise<ResolvedIdeAppInfo> {
    if (entry.windowsOnly && process.platform !== 'win32') {
      return this.buildUnavailableIde(entry);
    }
    if (process.platform === 'darwin') return this.resolveMacIdeApp(entry);
    if (process.platform === 'win32') return this.resolveWindowsIdeApp(entry);
    return this.resolveUnixIdeApp(entry);
  }

  private async resolveMacIdeApp(entry: IdeCatalogEntry): Promise<ResolvedIdeAppInfo> {
    const appPath = await firstExistingPathConcurrent(
      macApplicationRoots().flatMap((root) =>
        (entry.macAppNames ?? []).map((appName) => path.join(root, appName)),
      ),
    );

    if (appPath) {
      return {
        id: entry.id,
        name: entry.name,
        family: entry.family,
        available: true,
        appPath,
        launchKind: 'mac-app',
        launchTarget: appPath,
      };
    }

    const binaryPath = await this.resolveBinary(entry.binaries);
    if (binaryPath && (await this.isMacBinaryOwnedByIde(entry, binaryPath))) {
      return {
        id: entry.id,
        name: entry.name,
        family: entry.family,
        available: true,
        appPath: binaryPath,
        launchKind: 'binary',
        launchTarget: binaryPath,
      };
    }

    return this.buildUnavailableIde(entry);
  }

  private async isMacBinaryOwnedByIde(
    entry: IdeCatalogEntry,
    binaryPath: string,
  ): Promise<boolean> {
    const appNames = entry.macAppNames ?? [];
    if (appNames.length === 0) return true;
    let resolvedBinaryPath = binaryPath;
    try {
      resolvedBinaryPath = await fs.realpath(binaryPath);
    } catch {
      // Keep the original path and reject it below if it is not inside an app.
    }
    const appPath = findContainingMacApp(resolvedBinaryPath);
    if (!appPath) return false;
    return appNames.includes(path.basename(appPath));
  }

  private async resolveWindowsIdeApp(entry: IdeCatalogEntry): Promise<ResolvedIdeAppInfo> {
    if (entry.id === 'file-explorer') return this.resolveWindowsFileExplorerApp(entry);

    const binaryPath = await this.resolveBinary(entry.binaries);
    if (binaryPath) {
      return {
        id: entry.id,
        name: entry.name,
        family: entry.family,
        available: true,
        appPath: binaryPath,
        launchKind: 'binary',
        launchTarget: binaryPath,
      };
    }

    const appPath =
      (await firstExistingPathConcurrent(this.getWindowsIdeCandidatePaths(entry))) ??
      (await this.findWindowsJetBrainsApp(entry));
    if (appPath) {
      return {
        id: entry.id,
        name: entry.name,
        family: entry.family,
        available: true,
        appPath,
        launchKind: 'binary',
        launchTarget: appPath,
      };
    }

    return this.buildUnavailableIde(entry);
  }

  private async resolveWindowsFileExplorerApp(entry: IdeCatalogEntry): Promise<ResolvedIdeAppInfo> {
    const binaryPath = await this.resolveBinary(entry.binaries);
    const windowsDir = process.env['WINDIR'] ?? process.env['SystemRoot'];
    const candidates = [
      ...(windowsDir ? [path.win32.join(windowsDir, 'explorer.exe')] : []),
      path.win32.join('C:\\Windows', 'explorer.exe'),
    ];
    const appPath = binaryPath ?? (await firstExistingPathConcurrent(candidates));
    if (!appPath) return this.buildUnavailableIde(entry);
    return {
      id: entry.id,
      name: entry.name,
      family: entry.family,
      available: true,
      appPath,
      launchKind: 'windows-file-manager',
      launchTarget: appPath,
    };
  }

  private async resolveUnixIdeApp(entry: IdeCatalogEntry): Promise<ResolvedIdeAppInfo> {
    const binaryPath = await this.resolveBinary(entry.binaries);
    if (!binaryPath) return this.buildUnavailableIde(entry);
    return {
      id: entry.id,
      name: entry.name,
      family: entry.family,
      available: true,
      appPath: binaryPath,
      launchKind: 'binary',
      launchTarget: binaryPath,
    };
  }

  private buildUnavailableIde(entry: IdeCatalogEntry): ResolvedIdeAppInfo {
    return {
      id: entry.id,
      name: entry.name,
      family: entry.family,
      available: false,
      unavailableReason: IDE_UNAVAILABLE_REASON,
    };
  }

  private async resolveBinary(binaries: string[]): Promise<string | null> {
    for (const binary of binaries) {
      const resolved = await whichBinary(binary);
      if (resolved) return resolved;
    }

    if (process.platform === 'win32') return null;
    const candidates = binaries.flatMap((binary) => [
      path.join('/opt/homebrew/bin', binary),
      path.join('/usr/local/bin', binary),
      path.join('/usr/bin', binary),
      path.join('/snap/bin', binary),
    ]);
    return firstExistingPathConcurrent(candidates);
  }

  private getWindowsIdeCandidatePaths(entry: IdeCatalogEntry): string[] {
    const roots: string[] = [];
    const localAppData = process.env['LOCALAPPDATA'];
    const programFiles = process.env['PROGRAMFILES'];
    const programFilesX86 = process.env['PROGRAMFILES(X86)'];
    if (localAppData) roots.push(path.win32.join(localAppData, 'Programs'));
    if (programFiles) roots.push(programFiles);
    if (programFilesX86) roots.push(programFilesX86);

    const dirs = entry.windowsDirNames ?? [];
    const executables = entry.windowsExecutables ?? [];
    return roots.flatMap((root) =>
      dirs.flatMap((dirName) => executables.map((exe) => path.win32.join(root, dirName, exe))),
    );
  }

  private async findWindowsJetBrainsApp(entry: IdeCatalogEntry): Promise<string | null> {
    if (entry.family !== 'jetbrains') return null;

    const roots: string[] = [];
    const localAppData = process.env['LOCALAPPDATA'];
    const programFiles = process.env['PROGRAMFILES'];
    const programFilesX86 = process.env['PROGRAMFILES(X86)'];
    if (localAppData) roots.push(path.win32.join(localAppData, 'Programs', 'JetBrains'));
    if (programFiles) roots.push(path.win32.join(programFiles, 'JetBrains'));
    if (programFilesX86) roots.push(path.win32.join(programFilesX86, 'JetBrains'));

    const dirPrefixes = (entry.windowsDirNames ?? []).map((name) => name.toLowerCase());
    const executables = entry.windowsExecutables ?? [];
    const candidates: string[] = [];
    for (const root of roots) {
      let entries: Array<{ name: string; isDirectory: () => boolean }>;
      try {
        entries = await fs.readdir(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const item of entries) {
        if (!item.isDirectory()) continue;
        const lowerName = item.name.toLowerCase();
        if (!dirPrefixes.some((prefix) => lowerName.startsWith(prefix))) continue;
        candidates.push(...executables.map((exe) => path.win32.join(root, item.name, 'bin', exe)));
      }
    }
    return firstExistingPathConcurrent(candidates);
  }

  private async launchIdeOpenTarget(
    target: IdeOpenTarget,
    entry: IdeCatalogEntry,
    app: ResolvedIdeAppInfo,
  ): Promise<void> {
    if (target.filePath) {
      try {
        await this.launchFileInResolvedIde(target.filePath, entry, app);
        return;
      } catch (error) {
        if (!target.workspaceRoot) throw error;
      }
    }

    if (target.workspaceRoot) {
      await this.launchWorkspaceInResolvedIde(target.workspaceRoot, entry, app);
      return;
    }

    throw new IdeLauncherError('workspace or path is required', 'VALIDATION_ERROR', 400);
  }

  private async launchFileInResolvedIde(
    filePath: string,
    entry: IdeCatalogEntry,
    app: ResolvedIdeAppInfo,
  ): Promise<void> {
    if (!app.available || !app.launchTarget || !app.launchKind) {
      throw new IdeLauncherError(`${entry.name} is not available`, 'IDE_APP_UNAVAILABLE', 422);
    }

    if (entry.family === 'ghostty') {
      await this.launchWorkspaceInResolvedIde(path.dirname(filePath), entry, app);
      return;
    }
    if (entry.id === 'finder') {
      await runCommand('open', ['-R', filePath]);
      return;
    }
    if (app.launchKind === 'mac-app') {
      await runCommand('open', ['-a', app.launchTarget, filePath]);
      return;
    }
    if (app.launchKind === 'windows-file-manager') {
      await runCommand(app.launchTarget, [`/select,"${filePath}"`], {
        windowsHide: false,
        windowsVerbatimArguments: true,
        ignoreExitCode: true,
      });
      return;
    }
    await runCommand(app.launchTarget, [filePath]);
  }

  private async launchWorkspaceInResolvedIde(
    workspaceRoot: string,
    entry: IdeCatalogEntry,
    app: ResolvedIdeAppInfo,
  ): Promise<void> {
    if (!app.available || !app.launchTarget || !app.launchKind) {
      throw new IdeLauncherError(`${entry.name} is not available`, 'IDE_APP_UNAVAILABLE', 422);
    }

    if (app.launchKind === 'mac-app') {
      await runCommand('open', ['-a', app.launchTarget, workspaceRoot]);
      return;
    }
    if (app.launchKind === 'windows-file-manager') {
      await runCommand(app.launchTarget, [workspaceRoot], {
        windowsHide: false,
        ignoreExitCode: true,
      });
      return;
    }
    const args =
      entry.family === 'ghostty' ? [`--working-directory=${workspaceRoot}`] : [workspaceRoot];
    await runCommand(app.launchTarget, args);
  }
}
