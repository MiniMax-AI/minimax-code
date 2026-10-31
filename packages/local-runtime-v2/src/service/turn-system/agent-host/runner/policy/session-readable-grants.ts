import path from 'node:path';

/**
 * Session read grants: the paths inside the runtime's private data directory
 * that the runtime itself hands the Agent.
 *
 * The permission engine refuses read-only tools anywhere under `dataDir` /
 * `~/.minimax` (private runtime data) and that ask cannot be auto-approved.
 * Several runtime features nevertheless place files the Agent must read inside
 * that tree and tell the Agent their path. Each such feature registers one
 * source here; the gate resolves all of them once per tool call and passes the
 * result to the engine as `sessionOwnedReadablePaths`.
 *
 * Rule: a feature that hands the Agent a path under the private data directory
 * must register a source, or every read of that path becomes an ask nobody
 * expects (MCT-202610-E6ZLNV7Z: tool outputs; MCT-202610-A2VA9DM3: attachments
 * and the default Session workspace).
 *
 * Sources only name candidate paths. The engine enforces the boundary: a grant
 * must be strictly inside the private tree and reached without a symlink, and
 * a grant is read-only.
 */
type SessionReadableGrantKind =
  | 'tool-outputs'
  | 'compaction-snapshots'
  | 'session-workspace'
  | 'session-attachments';

interface SessionReadableGrantSubject {
  readonly sessionId: string;
  /** The Session's recorded working directory, when known. */
  readonly workspaceDir?: string;
  /** This Session first, then its parent Sessions, nearest first. */
  readonly lineage: readonly string[];
}

export interface SessionReadableGrantSource {
  readonly kind: SessionReadableGrantKind;
  resolve(subject: SessionReadableGrantSubject): Promise<readonly string[]>;
}

interface SessionReadableGrantSessionView {
  readonly workspaceDir?: string;
  readonly parentSessionId?: string | null;
}

interface SessionReadableGrantLogger {
  warn?(fields: Record<string, unknown>, message: string): void;
}

export interface SessionReadableGrantResolverOptions {
  readonly loadSession: (sessionId: string) => Promise<SessionReadableGrantSessionView | undefined>;
  readonly sources: readonly SessionReadableGrantSource[];
  readonly logger?: SessionReadableGrantLogger;
}

/** Child Sessions (subagents, verifiers) rarely nest deeper; the cap bounds lookups. */
const MAX_LINEAGE_DEPTH = 8;

/**
 * Resolves every registered source for one Session. A failing source is
 * logged and contributes nothing; the others still apply, so one broken
 * lookup never widens access and never removes unrelated grants.
 */
export function createSessionReadableGrantResolver(
  options: SessionReadableGrantResolverOptions,
): (sessionId: string) => Promise<readonly string[]> {
  return async (sessionId) => {
    const subject = await loadSubject(options, sessionId);
    const resolved = await Promise.all(
      options.sources.map(async (source) => {
        try {
          return await source.resolve(subject);
        } catch (error) {
          options.logger?.warn?.(
            {
              session_id: sessionId,
              grant_kind: source.kind,
              error: error instanceof Error ? error.message : String(error),
            },
            'permission.session_readable_grant_source_failed',
          );
          return [];
        }
      }),
    );
    return [...new Set(resolved.flat().filter((grant) => grant.length > 0))];
  };
}

async function loadSubject(
  options: SessionReadableGrantResolverOptions,
  sessionId: string,
): Promise<SessionReadableGrantSubject> {
  const lineage = [sessionId];
  const current = await options.loadSession(sessionId);
  let parentId = current?.parentSessionId ?? undefined;
  while (parentId && lineage.length < MAX_LINEAGE_DEPTH && !lineage.includes(parentId)) {
    lineage.push(parentId);
    parentId = (await options.loadSession(parentId))?.parentSessionId ?? undefined;
  }
  return {
    sessionId,
    lineage,
    ...(current?.workspaceDir ? { workspaceDir: current.workspaceDir } : {}),
  };
}

/** The Session's externalized oversized tool results (read back by the Agent). */
export function toolOutputGrantSource(input: {
  readonly readableDirectory: (sessionId: string) => Promise<string | undefined>;
}): SessionReadableGrantSource {
  return {
    kind: 'tool-outputs',
    resolve: async ({ sessionId }) => {
      const directory = await input.readableDirectory(sessionId);
      return directory ? [directory] : [];
    },
  };
}

/** Compaction tells the Agent to read the full history it replaced. */
export function compactionSnapshotGrantSource(input: {
  readonly inspectSnapshotsDirectory: (sessionId: string) => Promise<string | undefined>;
}): SessionReadableGrantSource {
  return {
    kind: 'compaction-snapshots',
    resolve: async ({ sessionId }) => {
      const directory = await input.inspectSnapshotsDirectory(sessionId);
      return directory ? [directory] : [];
    },
  };
}

/**
 * The Session's working directory when the runtime allocated it inside its
 * own data directory: the per-Session default `sessions/<id>/workspace`, the
 * runtime-wide `workspace` used by cron / IM Sessions, or an Agent's internal
 * `agents/<name>/workspace`. Writes there already follow the working-directory
 * rule; reads were refused as private data.
 *
 * Only these runtime-allocated shapes qualify. A user project that happens to
 * point elsewhere inside the data directory (e.g. `v2/`) is not granted.
 */
export function runtimeWorkspaceGrantSource(input: {
  readonly dataDir: () => string;
  readonly platform?: NodeJS.Platform;
}): SessionReadableGrantSource {
  return {
    kind: 'session-workspace',
    resolve: async ({ workspaceDir }) =>
      workspaceDir &&
      isRuntimeAllocatedWorkspace(workspaceDir, input.dataDir(), input.platform ?? process.platform)
        ? [workspaceDir]
        : [],
  };
}

/**
 * Attachments and generated media registered by this Session or a parent
 * Session (a subagent receives its parent's attachment paths in its task).
 * Exact files only: the asset store is shared by every Session.
 */
export function sessionAttachmentGrantSource(input: {
  readonly listSessionReadablePaths: (sessionIds: readonly string[]) => Promise<readonly string[]>;
}): SessionReadableGrantSource {
  return {
    kind: 'session-attachments',
    resolve: ({ lineage }) => input.listSessionReadablePaths(lineage),
  };
}

function isRuntimeAllocatedWorkspace(
  workspaceDir: string,
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const parts = relativeSegments(workspaceDir, dataDir, platform);
  if (!parts) return false;
  const shape = parts.map((part) => (platform === 'win32' ? part.toLowerCase() : part));
  if (shape.length === 1) return shape[0] === 'workspace';
  return (
    shape.length === 3 &&
    (shape[0] === 'sessions' || shape[0] === 'agents') &&
    shape[2] === 'workspace'
  );
}

/** Segments of `target` strictly below `root`, or `undefined` when it is not below it. */
function relativeSegments(
  target: string,
  root: string,
  platform: NodeJS.Platform,
): string[] | undefined {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(target) || !pathApi.isAbsolute(root)) return undefined;
  const relative = pathApi.relative(pathApi.resolve(root), pathApi.resolve(target));
  if (!relative || relative.startsWith('..') || pathApi.isAbsolute(relative)) return undefined;
  return relative.split(pathApi.sep);
}
