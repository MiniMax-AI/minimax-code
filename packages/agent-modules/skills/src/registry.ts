import { constants as fsConstants, promises as fs, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import yaml from 'js-yaml';
import { subscribeToSkillDirectory } from './directory-watcher.js';

import type {
  SkillCatalogRender,
  SkillDiagnostic,
  SkillEntry,
  SkillLoser,
  SkillRefreshMetrics,
  SkillRegistryDump,
  SkillRegistryWatchOptions,
  SkillRegistryWatcher,
  SkillRenderMetrics,
  SkillRenderOptions,
  SkillSnapshot,
  SkillSourceKind,
  SkillSourceRoot,
  SkillViewEntry,
} from './types.js';

interface CachedSkillFile {
  key: string;
  entry?: SkillEntry;
  diagnostics: SkillDiagnostic[];
}

interface CanonicalRoot extends SkillSourceRoot {
  canonicalPath: string;
}

interface SkillFileStat {
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
}

interface SkillWatchTarget {
  targetPath: string;
  dev: number;
  ino: number;
}

interface ActiveSkillWatcher extends SkillWatchTarget {
  watcher: { close(): void };
}

interface SkillFileCandidate {
  fileLocation: string;
  contentDir: string;
  entryDir: string;
  allowOutsideRoot: boolean;
}

/**
 * Resolve template variables in skill content.
 * Currently only supports {{DATA_DIR}} → actual data directory path.
 * Windows paths are normalized to forward slashes for cross-platform consistency.
 */
export function resolveSkillContentVariables(content: string): string {
  const dataDir = process.env.MINIMAX_DATA_DIR;
  if (!dataDir || !content.includes('{{DATA_DIR}}')) return content;
  // Normalize Windows backslashes to forward slashes
  const normalizedDir = dataDir.replace(/\\/g, '/');
  return content.split('{{DATA_DIR}}').join(normalizedDir);
}

const SOURCE_RANK: Record<SkillSourceKind, number> = {
  project: 0,
  workspace: 1,
  agent: 2,
  global: 3,
  user: 3,
  builtin: 4,
};

const DEFAULT_RENDER_BUDGET_CHARS = 20_000;
const DEFAULT_EXTERNAL_DESCRIPTION_CHARS = 120;
const WATCH_DEBOUNCE_MS = 200;
const WATCH_MAX_WAIT_MS = 1000;
const OPEN_SKILL_FILE_FLAGS =
  fsConstants.O_RDONLY | (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0);

export class SkillRegistry {
  private readonly cache = new Map<string, CachedSkillFile>();
  private snapshot?: SkillSnapshot;
  private version = 0;

  constructor(private readonly roots: SkillSourceRoot[]) {}

  async refresh(): Promise<SkillSnapshot> {
    const canonicalRoots = await canonicalizeRoots(this.roots);
    const diagnostics: SkillDiagnostic[] = [];
    const entries: SkillEntry[] = [];
    const seenCacheLocations = new Set<string>();
    const metrics: SkillRefreshMetrics = {
      rootsScanned: canonicalRoots.length,
      filesSeen: 0,
      filesRead: 0,
      filesReused: 0,
      diagnostics: 0,
      entries: 0,
      winners: 0,
      losers: 0,
    };

    for (const root of canonicalRoots) {
      const candidates = await listSkillFiles(root, diagnostics);
      for (const candidate of candidates) {
        const cacheLocation = `${root.id}:${candidate.entryDir}`;
        seenCacheLocations.add(cacheLocation);
        metrics.filesSeen += 1;
        const stat = await statSkillFile(root, candidate, diagnostics);
        if (!stat) {
          this.cache.delete(cacheLocation);
          continue;
        }
        const cacheKey = `${candidate.fileLocation}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
        const cached = this.cache.get(cacheLocation);
        let parsed: CachedSkillFile;

        if (cached?.key === cacheKey) {
          metrics.filesReused += 1;
          parsed = cached;
        } else {
          metrics.filesRead += 1;
          parsed = await parseSkillFile(root, candidate, stat, cacheKey);
          this.cache.set(cacheLocation, parsed);
        }

        diagnostics.push(...parsed.diagnostics);
        if (parsed.entry) {
          entries.push(parsed.entry);
        }
      }
    }

    for (const cachedLocation of this.cache.keys()) {
      if (!seenCacheLocations.has(cachedLocation)) {
        this.cache.delete(cachedLocation);
      }
    }

    const { winners, losers } = resolvePrecedence(entries);
    metrics.entries = entries.length;
    metrics.winners = winners.length;
    metrics.losers = losers.length;
    metrics.diagnostics = diagnostics.length;

    this.snapshot = {
      version: ++this.version,
      generatedAt: Date.now(),
      roots: canonicalRoots.map(({ canonicalPath: _canonicalPath, ...root }) => root),
      entries: sortEntries(entries),
      winners,
      losers,
      diagnostics,
      metrics,
    };
    return this.snapshot;
  }

  getSnapshot(): SkillSnapshot | undefined {
    return this.snapshot;
  }

  getAvailableSkills(): SkillViewEntry[] {
    return this.requireSnapshot().winners;
  }

  getByLocationUri(locationUri: string): SkillEntry {
    const normalizedLocationUri = normalizeLocationUri(locationUri);
    const entry = this.requireSnapshot().entries.find(
      (candidate) => candidate.locationUri === normalizedLocationUri,
    );
    if (!entry) {
      throw new Error(`Unknown skill location_uri: ${locationUri}`);
    }
    return entry;
  }

  readByLocationUri(locationUri: string): string {
    return this.getByLocationUri(locationUri).content;
  }

  watch(options: SkillRegistryWatchOptions): SkillRegistryWatcher {
    const watchers = new Map<string, ActiveSkillWatcher>();
    let closed = false;
    let refreshInFlight = false;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let maxWaitTimer: ReturnType<typeof setTimeout> | undefined;
    const pendingRoots = new Map<string, SkillSourceRoot>();

    const clearFlushTimers = () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      if (maxWaitTimer) {
        clearTimeout(maxWaitTimer);
        maxWaitTimer = undefined;
      }
    };

    const closeWatchers = () => {
      for (const activeWatcher of watchers.values()) {
        activeWatcher.watcher.close();
      }
      watchers.clear();
    };

    const watchKey = (watchTarget: SkillWatchTarget, root: SkillSourceRoot) =>
      `${path.resolve(watchTarget.targetPath)}\0${root.id}`;

    const desiredWatchTargets = () => {
      const targets = new Map<string, { root: SkillSourceRoot; target: SkillWatchTarget }>();
      const rootsById = new Map(this.roots.map((root) => [root.id, root]));
      const collectPath = (targetPath: string, root: SkillSourceRoot) => {
        const target = existingWatchTarget(targetPath);
        if (!target) return;
        targets.set(watchKey(target, root), { root, target });
      };
      for (const root of this.roots) {
        collectPath(root.rootPath, root);
        for (const skillDir of listWatchableSkillDirs(root)) {
          collectPath(skillDir, root);
        }
      }
      for (const entry of this.snapshot?.entries ?? []) {
        const root = rootsById.get(entry.rootId);
        if (root) collectPath(entry.skillDir, root);
      }
      return targets;
    };

    const closeStaleWatchers = (
      desiredTargets: Map<string, { root: SkillSourceRoot; target: SkillWatchTarget }>,
    ) => {
      for (const [key, activeWatcher] of watchers) {
        const desired = desiredTargets.get(key);
        if (
          desired &&
          activeWatcher.dev === desired.target.dev &&
          activeWatcher.ino === desired.target.ino
        ) {
          continue;
        }
        activeWatcher.watcher.close();
        watchers.delete(key);
      }
    };

    const watchTarget = (target: SkillWatchTarget, root: SkillSourceRoot) => {
      const key = watchKey(target, root);
      const existingWatcher = watchers.get(key);
      if (existingWatcher?.dev === target.dev && existingWatcher.ino === target.ino) return;
      existingWatcher?.watcher.close();
      try {
        const watcher = subscribeToSkillDirectory(target, {
          onChange: () => scheduleChange(root),
          onError: () => {
            watchers.delete(key);
            scheduleChange(root);
          },
        });
        watchers.set(key, { ...target, watcher });
      } catch {
        // Missing roots or skill directories are expected while users edit skills.
      }
    };

    const armWatchers = () => {
      if (closed) return;
      const desiredTargets = desiredWatchTargets();
      closeStaleWatchers(desiredTargets);
      for (const { root, target } of desiredTargets.values()) {
        watchTarget(target, root);
      }
    };

    const flushChanges = async () => {
      clearFlushTimers();
      while (pendingRoots.size > 0 && !closed) {
        const roots = [...pendingRoots.values()];
        pendingRoots.clear();
        await this.refresh().catch(() => undefined);
        armWatchers();
        for (const root of roots) {
          await Promise.resolve(options.onChange(root)).catch(() => undefined);
        }
      }
      refreshInFlight = false;
      if (pendingRoots.size > 0 && !closed) {
        scheduleFlush();
      }
    };

    const runScheduledFlush = () => {
      if (closed || refreshInFlight || pendingRoots.size === 0) return;
      refreshInFlight = true;
      void flushChanges();
    };

    const scheduleFlush = () => {
      if (closed || refreshInFlight) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(runScheduledFlush, WATCH_DEBOUNCE_MS);
      maxWaitTimer ??= setTimeout(runScheduledFlush, WATCH_MAX_WAIT_MS);
    };

    const scheduleChange = (root: SkillSourceRoot) => {
      if (closed) return;
      pendingRoots.set(root.id, root);
      scheduleFlush();
    };

    armWatchers();

    return {
      rearm() {
        armWatchers();
      },
      close() {
        closed = true;
        clearFlushTimers();
        closeWatchers();
      },
    };
  }

  dump(renderMetrics?: SkillRenderMetrics): SkillRegistryDump {
    const snapshot = this.requireSnapshot();
    return dumpSkillRegistry(snapshot, renderMetrics);
  }

  private requireSnapshot(): SkillSnapshot {
    if (!this.snapshot) {
      throw new Error('Skill registry has not been refreshed');
    }
    return this.snapshot;
  }
}

export async function createSkillRegistry(roots: SkillSourceRoot[]): Promise<SkillRegistry> {
  const registry = new SkillRegistry(roots);
  await registry.refresh();
  return registry;
}

export function renderAvailableSkillsCatalog(
  input: SkillSnapshot | SkillViewEntry[],
  options: SkillRenderOptions = {},
): SkillCatalogRender {
  const winners = Array.isArray(input) ? input : input.winners;
  const budgetChars = options.budgetChars ?? DEFAULT_RENDER_BUDGET_CHARS;
  const externalDescriptionChars =
    options.externalDescriptionChars ?? DEFAULT_EXTERNAL_DESCRIPTION_CHARS;
  const metrics: SkillRenderMetrics = {
    total: winners.length,
    rendered: 0,
    compacted: 0,
    dropped: 0,
    charsUsed: 0,
    budgetChars,
  };
  const lines: string[] = [];

  for (const entry of winners) {
    const compact = entry.sourceExternal;
    const description = compact
      ? truncate(entry.firstDescriptionLine || entry.description, externalDescriptionChars)
      : entry.description;
    const rendered = `- ${entry.name}: ${description}\n  location_uri: ${entry.locationUri}`;
    const projectedLength = joinCatalog(lines, rendered).length;

    if (projectedLength > budgetChars) {
      metrics.dropped = winners.length - metrics.rendered;
      break;
    }

    lines.push(rendered);
    metrics.rendered += 1;
    if (compact) {
      metrics.compacted += 1;
    }
  }

  const catalog = lines.join('\n');
  metrics.charsUsed = catalog.length;
  if (metrics.dropped === 0) {
    metrics.dropped = metrics.total - metrics.rendered;
  }
  return { catalog, metrics };
}

export function dumpSkillRegistry(
  snapshot: SkillSnapshot,
  renderMetrics?: SkillRenderMetrics,
): SkillRegistryDump {
  return {
    version: snapshot.version,
    generated_at: snapshot.generatedAt,
    roots: snapshot.roots.map((root) => ({ ...root, canonicalPath: path.resolve(root.rootPath) })),
    entries: snapshot.entries.map(({ content: _content, ...entry }) => entry),
    winners: snapshot.winners.map((winner) => winner.locationUri),
    losers: snapshot.losers.map((loser) => ({
      locationUri: loser.entry.locationUri,
      name: loser.entry.name,
      reason: loser.reason,
      winnerLocationUri: loser.winnerLocationUri,
    })),
    diagnostics: snapshot.diagnostics,
    refresh_metrics: snapshot.metrics,
    render_metrics: renderMetrics,
  };
}

async function canonicalizeRoots(roots: SkillSourceRoot[]): Promise<CanonicalRoot[]> {
  return Promise.all(
    roots.map(async (root) => ({
      ...root,
      canonicalPath: await canonicalRootPath(root),
    })),
  );
}

async function canonicalRootPath(root: SkillSourceRoot): Promise<string> {
  try {
    const stat = await fs.lstat(root.rootPath);
    if (stat.isSymbolicLink() && !allowsDirectorySymlinkOutsideRoot(root)) {
      return path.resolve(root.rootPath);
    }
  } catch {
    return path.resolve(root.rootPath);
  }
  return canonicalPath(root.rootPath);
}

async function canonicalPath(filePath: string): Promise<string> {
  try {
    return await fs.realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function existingWatchTarget(targetPath: string): SkillWatchTarget | undefined {
  const resolvedTarget = path.resolve(targetPath);
  try {
    const targetStat = statSync(resolvedTarget);
    if (targetStat.isDirectory()) {
      return {
        targetPath: resolvedTarget,
        dev: targetStat.dev,
        ino: targetStat.ino,
      };
    }
    const parentPath = path.dirname(resolvedTarget);
    const parentStat = statSync(parentPath);
    return {
      targetPath: parentPath,
      dev: parentStat.dev,
      ino: parentStat.ino,
    };
  } catch {
    return undefined;
  }
}

function allowsDirectorySymlinkOutsideRoot(root: SkillSourceRoot): boolean {
  return (
    root.allowDirectorySymlinksOutsideRoot === true ||
    ['agent', 'global', 'user', 'builtin'].includes(root.kind)
  );
}

async function listSkillFiles(
  root: CanonicalRoot,
  diagnostics: SkillDiagnostic[],
): Promise<SkillFileCandidate[]> {
  let children;
  try {
    children = await fs.readdir(root.canonicalPath, { withFileTypes: true });
  } catch (error) {
    diagnostics.push({
      level: 'warning',
      code: 'root_unreadable',
      rootId: root.id,
      message: `Unable to read skill root: ${error instanceof Error ? error.message : String(error)}`,
    });
    return [];
  }

  const files: SkillFileCandidate[] = [];
  for (const child of children) {
    if (!child.isDirectory() && !child.isSymbolicLink()) continue;

    const entryDir = path.join(root.canonicalPath, child.name);
    let contentDir = entryDir;
    let allowOutsideRoot = false;
    if (child.isSymbolicLink()) {
      try {
        if (!(await fs.stat(entryDir)).isDirectory()) {
          diagnostics.push({
            level: 'warning',
            code: 'skill_directory_link_not_directory',
            rootId: root.id,
            locationUri: locationUriFromFilePath(entryDir),
            message: 'Skill directory link target is not a directory',
          });
          continue;
        }
        contentDir = await fs.realpath(entryDir);
        allowOutsideRoot = allowsDirectorySymlinkOutsideRoot(root);
      } catch (error) {
        diagnostics.push({
          level: 'warning',
          code: 'skill_directory_link_unreadable',
          rootId: root.id,
          locationUri: locationUriFromFilePath(entryDir),
          message: `Unable to resolve skill directory link: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
    }

    const skillFile = path.join(contentDir, 'SKILL.md');
    try {
      const stat = await fs.lstat(skillFile);
      if (stat.isSymbolicLink()) {
        diagnostics.push({
          level: 'warning',
          code: 'skill_symlink_rejected',
          rootId: root.id,
          locationUri: locationUriFromFilePath(skillFile),
          message: 'SKILL.md symlinks are not allowed inside bounded skill roots',
        });
        continue;
      }
      if (stat.isFile()) {
        const fileLocation = await fs.realpath(skillFile);
        if (allowOutsideRoot || isInsideRoot(root, fileLocation)) {
          files.push({ fileLocation, contentDir, entryDir, allowOutsideRoot });
        } else {
          diagnostics.push({
            level: 'warning',
            code: 'skill_outside_root',
            rootId: root.id,
            locationUri: locationUriFromFilePath(fileLocation),
            message: 'Resolved SKILL.md path is outside its bounded skill root',
          });
        }
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        diagnostics.push({
          level: 'warning',
          code: 'skill_file_unreadable',
          rootId: root.id,
          locationUri: locationUriFromFilePath(skillFile),
          message: `Unable to inspect SKILL.md: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }
  return files.sort(
    (left, right) =>
      left.fileLocation.localeCompare(right.fileLocation) ||
      left.entryDir.localeCompare(right.entryDir),
  );
}

async function statSkillFile(
  root: CanonicalRoot,
  candidate: SkillFileCandidate,
  diagnostics: SkillDiagnostic[],
): Promise<SkillFileStat | undefined> {
  const { fileLocation, allowOutsideRoot } = candidate;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const pathStat = await fs.lstat(fileLocation);
    if (pathStat.isSymbolicLink()) {
      diagnostics.push({
        level: 'warning',
        code: 'skill_symlink_rejected',
        rootId: root.id,
        locationUri: locationUriFromFilePath(fileLocation),
        message: 'SKILL.md symlinks are not allowed inside bounded skill roots',
      });
      return undefined;
    }
    if (!pathStat.isFile()) {
      diagnostics.push({
        level: 'warning',
        code: 'skill_file_not_file',
        rootId: root.id,
        locationUri: locationUriFromFilePath(fileLocation),
        message: 'Skill path is no longer a file',
      });
      return undefined;
    }
    handle = await fs.open(fileLocation, OPEN_SKILL_FILE_FLAGS);
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      diagnostics.push({
        level: 'warning',
        code: 'skill_file_not_file',
        rootId: root.id,
        locationUri: locationUriFromFilePath(fileLocation),
        message: 'Skill path is no longer a file',
      });
      return undefined;
    }
    const canonicalFileLocation = await canonicalPath(fileLocation);
    if (!allowOutsideRoot && !isInsideRoot(root, canonicalFileLocation)) {
      diagnostics.push({
        level: 'warning',
        code: 'skill_outside_root',
        rootId: root.id,
        locationUri: locationUriFromFilePath(canonicalFileLocation),
        message: 'Resolved SKILL.md path is outside its bounded skill root',
      });
      return undefined;
    }
    return {
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      dev: fileStat.dev,
      ino: fileStat.ino,
    };
  } catch (error) {
    const code = errorCode(error);
    diagnostics.push({
      level: 'warning',
      code: code === 'ELOOP' ? 'skill_symlink_rejected' : 'skill_stat_failed',
      rootId: root.id,
      locationUri: locationUriFromFilePath(fileLocation),
      message:
        code === 'ELOOP'
          ? 'SKILL.md symlinks are not allowed inside bounded skill roots'
          : `Unable to stat SKILL.md during refresh: ${error instanceof Error ? error.message : String(error)}`,
    });
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isInsideRoot(root: CanonicalRoot, fileLocation: string): boolean {
  return (
    fileLocation === root.canonicalPath ||
    fileLocation.startsWith(`${root.canonicalPath}${path.sep}`)
  );
}

async function parseSkillFile(
  root: CanonicalRoot,
  candidate: SkillFileCandidate,
  stat: SkillFileStat,
  key: string,
): Promise<CachedSkillFile> {
  const { fileLocation, contentDir, entryDir } = candidate;
  const diagnostics: SkillDiagnostic[] = [];
  const readResult = await readStableSkillFile(root, fileLocation, stat);
  diagnostics.push(...readResult.diagnostics);
  const content = readResult.content;
  if (content === undefined) {
    return { key, diagnostics };
  }

  const { frontmatter, displayNames, descriptions, body } = parseFrontmatter(
    content,
    diagnostics,
    root.id,
    fileLocation,
  );
  const title = stringValue(frontmatter.title) ?? firstHeading(body);
  const description = stringValue(frontmatter.description) ?? firstDescription(body);
  const name = stringValue(frontmatter.name) ?? path.basename(path.dirname(fileLocation));

  if (!title) {
    diagnostics.push({
      level: 'warning',
      code: 'missing_title',
      rootId: root.id,
      locationUri: locationUriFromFilePath(fileLocation),
      message: 'Skill is missing frontmatter title and markdown heading',
    });
  }
  if (!description) {
    diagnostics.push({
      level: 'warning',
      code: 'missing_description',
      rootId: root.id,
      locationUri: locationUriFromFilePath(fileLocation),
      message: 'Skill is missing frontmatter description and body description',
    });
  }
  if (!name) {
    diagnostics.push({
      level: 'error',
      code: 'missing_name',
      rootId: root.id,
      locationUri: locationUriFromFilePath(fileLocation),
      message: 'Skill name could not be inferred',
    });
    return { key, diagnostics };
  }

  return {
    key,
    diagnostics,
    entry: {
      id: `${root.id}:${name}:${locationUriFromFilePath(fileLocation)}`,
      name,
      title: title || name,
      description: resolveSkillContentVariables(description || ''),
      firstDescriptionLine: firstNonEmptyLine(resolveSkillContentVariables(description || '')),
      content: resolveSkillContentVariables(content),
      locationUri: locationUriFromFilePath(fileLocation),
      skillDir: contentDir,
      entryDir,
      rootId: root.id,
      rootKind: root.kind,
      rootScope: root.scope,
      rootPriority: root.priority ?? 0,
      sourceExternal: root.external ?? isExternalUserHomeSource(root),
      frontmatter,
      ...(displayNames ? { displayNames } : {}),
      ...(descriptions ? { descriptions } : {}),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    },
  };
}

async function readStableSkillFile(
  root: CanonicalRoot,
  fileLocation: string,
  expectedStat: SkillFileStat,
): Promise<{ content?: string; diagnostics: SkillDiagnostic[] }> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(fileLocation, OPEN_SKILL_FILE_FLAGS);
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) {
      return {
        diagnostics: [
          {
            level: 'warning',
            code: 'skill_file_not_file',
            rootId: root.id,
            locationUri: locationUriFromFilePath(fileLocation),
            message: 'Skill path is no longer a file',
          },
        ],
      };
    }
    if (!sameSkillFileStat(expectedStat, openedStat)) {
      return {
        diagnostics: [
          {
            level: 'warning',
            code: 'skill_changed_during_read',
            rootId: root.id,
            locationUri: locationUriFromFilePath(fileLocation),
            message: 'SKILL.md changed between stat and read; retry on next refresh',
          },
        ],
      };
    }
    return { content: await handle.readFile({ encoding: 'utf8' }), diagnostics: [] };
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ELOOP') {
      return {
        diagnostics: [
          {
            level: 'warning',
            code: 'skill_symlink_rejected',
            rootId: root.id,
            locationUri: locationUriFromFilePath(fileLocation),
            message: 'SKILL.md symlinks are not allowed inside bounded skill roots',
          },
        ],
      };
    }
    return {
      diagnostics: [
        {
          level: 'error',
          code: 'skill_read_failed',
          rootId: root.id,
          locationUri: locationUriFromFilePath(fileLocation),
          message: `Unable to read SKILL.md: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function sameSkillFileStat(expected: SkillFileStat, actual: SkillFileStat): boolean {
  return (
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.size === actual.size &&
    expected.mtimeMs === actual.mtimeMs
  );
}

function listWatchableSkillDirs(root: SkillSourceRoot): string[] {
  const { rootPath } = root;
  try {
    return readdirSync(rootPath, { withFileTypes: true })
      .filter((child) => {
        if (child.isDirectory()) return true;
        if (!child.isSymbolicLink() || !allowsDirectorySymlinkOutsideRoot(root)) return false;
        try {
          // Watch linked directories even before they contain a SKILL.md.
          return statSync(path.join(rootPath, child.name)).isDirectory();
        } catch {
          return false;
        }
      })
      .map((child) => path.join(rootPath, child.name))
      .sort();
  } catch {
    return [];
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function parseFrontmatter(
  content: string,
  diagnostics: SkillDiagnostic[],
  rootId: string,
  fileLocation: string,
): {
  frontmatter: Record<string, string | number | boolean>;
  displayNames?: Record<string, string>;
  descriptions?: Record<string, string>;
  body: string;
} {
  const startMatch = /^---\r?\n/.exec(content);
  if (!startMatch) {
    return { frontmatter: {}, body: content };
  }

  const frontmatterStart = startMatch[0].length;
  const closingMatch = /(?:^|\r?\n)---(?:\r?\n|$)/.exec(content.slice(frontmatterStart));
  if (!closingMatch || closingMatch.index === undefined) {
    diagnostics.push({
      level: 'error',
      code: 'frontmatter_unclosed',
      rootId,
      locationUri: locationUriFromFilePath(fileLocation),
      message: 'Frontmatter starts with --- but never closes',
    });
    return { frontmatter: {}, body: '' };
  }

  const closingPrefixLength = closingMatch[0].startsWith('\r\n')
    ? 2
    : closingMatch[0].startsWith('\n')
      ? 1
      : 0;
  const frontmatterEnd = frontmatterStart + closingMatch.index + closingPrefixLength;
  const delimiterEnd = frontmatterEnd + 3;
  const bodyStart = content.startsWith('\r\n', delimiterEnd)
    ? delimiterEnd + 2
    : content.startsWith('\n', delimiterEnd)
      ? delimiterEnd + 1
      : delimiterEnd;

  const rawFrontmatter = content.slice(frontmatterStart, frontmatterEnd).trim();
  const body = content.slice(bodyStart);

  let parsed: unknown;
  try {
    parsed = yaml.load(rawFrontmatter);
  } catch (error) {
    diagnostics.push({
      level: 'warning',
      code: 'frontmatter_invalid_yaml',
      rootId,
      locationUri: locationUriFromFilePath(fileLocation),
      message: `Invalid frontmatter YAML: ${error instanceof Error ? error.message : String(error)}`,
    });
    return { frontmatter: {}, body };
  }

  if (parsed === undefined || parsed === null) {
    return { frontmatter: {}, body };
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    diagnostics.push({
      level: 'warning',
      code: 'frontmatter_not_mapping',
      rootId,
      locationUri: locationUriFromFilePath(fileLocation),
      message: 'Frontmatter YAML must be a mapping',
    });
    return { frontmatter: {}, body };
  }

  const frontmatter: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(parsed)) {
    const scalar = frontmatterScalar(value);
    if (scalar !== undefined) {
      frontmatter[key] = scalar;
    }
  }
  const record = parsed as Record<string, unknown>;
  const displayNames = normalizeLocaleTextMap(record.displayNames);
  const descriptions = normalizeLocaleTextMap(record.descriptions);
  return {
    frontmatter,
    ...(displayNames ? { displayNames } : {}),
    ...(descriptions ? { descriptions } : {}),
    body,
  };
}

/**
 * Normalize a nested `{ <locale>: <text> }` frontmatter map. Non-object inputs
 * yield `undefined`; non-string or blank locale values are dropped so a
 * malformed optional translation cannot break skill loading. Returns
 * `undefined` when no valid entry remains so callers can omit the field.
 */
function normalizeLocaleTextMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [locale, text] of Object.entries(value as Record<string, unknown>)) {
    if (typeof text === 'string' && text.trim() !== '') {
      out[locale] = text;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function frontmatterScalar(value: unknown): string | number | boolean | undefined {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

function stringValue(value: string | number | boolean | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function firstHeading(body: string): string | undefined {
  const match = body.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim();
}

function firstDescription(body: string): string | undefined {
  const lines = body.split(/\r?\n/);
  let pastHeading = false;
  const description: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!pastHeading && line.startsWith('# ')) {
      pastHeading = true;
      continue;
    }
    if (!line) {
      if (description.length > 0) {
        break;
      }
      continue;
    }
    if (line.startsWith('#')) {
      if (description.length > 0) {
        break;
      }
      continue;
    }
    description.push(line);
  }
  return description.join('\n').trim() || undefined;
}

function firstNonEmptyLine(value: string): string {
  return (
    value
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.trim() ?? ''
  );
}

function isExternalUserHomeSource(root: CanonicalRoot): boolean {
  if (!['global', 'user'].includes(root.kind)) {
    return false;
  }
  return homeDirectories().some(
    (home) => root.canonicalPath === home || root.canonicalPath.startsWith(`${home}${path.sep}`),
  );
}

function homeDirectories(): string[] {
  const driveHome =
    process.env.HOMEDRIVE && process.env.HOMEPATH
      ? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`
      : undefined;
  const homes = [process.env.HOME, process.env.USERPROFILE, driveHome]
    .filter((value): value is string => Boolean(value))
    .map((value) => path.resolve(value));
  return Array.from(new Set(homes));
}

function resolvePrecedence(entries: SkillEntry[]): {
  winners: SkillViewEntry[];
  losers: SkillLoser[];
} {
  const byName = new Map<string, SkillEntry[]>();
  for (const entry of entries) {
    const group = byName.get(entry.name) ?? [];
    group.push(entry);
    byName.set(entry.name, group);
  }

  const winners: SkillViewEntry[] = [];
  const losers: SkillLoser[] = [];
  for (const group of byName.values()) {
    const sorted = sortEntries(group);
    const [winner, ...shadowed] = sorted;
    if (!winner) {
      continue;
    }
    const winnerLosers: SkillLoser[] = shadowed.map((entry) => ({
      entry,
      reason: `Shadowed by ${winner.rootKind} source ${winner.locationUri}`,
      winnerLocationUri: winner.locationUri,
    }));
    losers.push(...winnerLosers);
    winners.push({ ...winner, losers: winnerLosers });
  }
  return { winners: sortEntries(winners) as SkillViewEntry[], losers: sortLosers(losers) };
}

function sortEntries<T extends SkillEntry>(entries: T[]): T[] {
  return [...entries].sort((left, right) => {
    const rank = SOURCE_RANK[left.rootKind] - SOURCE_RANK[right.rootKind];
    if (rank !== 0) {
      return rank;
    }
    const priority = right.rootPriority - left.rootPriority;
    if (priority !== 0) {
      return priority;
    }
    const name = left.name.localeCompare(right.name);
    if (name !== 0) {
      return name;
    }
    return left.locationUri.localeCompare(right.locationUri);
  });
}

function sortLosers(losers: SkillLoser[]): SkillLoser[] {
  return [...losers].sort((left, right) =>
    left.entry.locationUri.localeCompare(right.entry.locationUri),
  );
}

function locationUriFromFilePath(filePath: string): string {
  return pathToFileURL(filePath).href.replace(/^file:/u, 'files:');
}

function normalizeLocationUri(locationUri: string): string {
  if (!locationUri.startsWith('files://')) {
    throw new Error(`Unsupported skill location_uri: ${locationUri}`);
  }
  return locationUriFromFilePath(fileURLToPath(locationUri.replace(/^files:/u, 'file:')));
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function joinCatalog(existing: string[], next: string): string {
  return existing.length === 0 ? next : `${existing.join('\n')}\n${next}`;
}
