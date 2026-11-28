import {
  TUI_REVIEW_STATUSES,
  type TuiReviewLink,
  type TuiReviewStatus,
  type TuiWorkspaceFileCandidate,
  type TuiWorkspaceFileEntry,
  type TuiWorkspaceGitMetadata,
  type TuiWorkspaceRoot,
  type TuiWorkspaceTreeCandidate,
} from '../port.js';
import type { TuiRuntimeAccessContext } from './access-context.js';
import { interleave, normalizeWorkspaceRoots } from './normalizers.js';

export class TuiWorkspaceAccess {
  constructor(private readonly context: TuiRuntimeAccessContext) {}

  async getWorkspaceGitMetadata(workspaceDir: string): Promise<TuiWorkspaceGitMetadata> {
    const metadata = await this.context
      .service('workspace.git.metadata')
      .getWorkspaceGitMetadata(workspaceDir);
    if (!metadata) {
      return {
        isGitRepo: false,
        branch: '',
        detached: false,
        isWorktree: false,
      };
    }
    const isGitRepo = metadata.isGitRepo === true;
    const branch = typeof metadata.branch === 'string' ? metadata.branch.trim() : '';
    const hasHead = metadata.hasHead === true;
    const reviewLink = branch ? await this.readReviewLink(workspaceDir, branch) : undefined;
    return {
      isGitRepo,
      branch,
      detached: isGitRepo && hasHead && branch.length === 0,
      isWorktree: metadata.isWorktree === true,
      ...(reviewLink ? { reviewLink } : {}),
    };
  }

  /**
   * Reads the recorded review link for a branch.
   *
   * Failures are swallowed: the review link is an optional embellishment of the
   * status line, and losing it must never cost the caller its git metadata.
   */
  private async readReviewLink(
    workspaceDir: string,
    branch: string,
  ): Promise<TuiReviewLink | undefined> {
    try {
      const raw = await this.context
        .service('workspace.git.review-link')
        .getWorkspaceReviewLink(workspaceDir, branch);
      return normalizeReviewLink(raw);
    } catch {
      return undefined;
    }
  }

  async listWorkspaceFileTree(
    workspaceDir: string,
    path?: string,
    signal?: AbortSignal,
  ): Promise<TuiWorkspaceFileEntry[]> {
    const entries = await this.context.service('workspace.tree.list').listWorkspaceFileTree({
      workspaceDir,
      ...(path ? { path } : {}),
      ...(signal ? { signal } : {}),
    });
    return normalizeFileTreeEntries(entries);
  }

  async searchWorkspaceFiles(
    workspaceDir: string,
    query: string,
    limit = 20,
    signal?: AbortSignal,
  ): Promise<string[]> {
    return [
      ...(await this.context.service('workspace.search').searchWorkspaceFiles({
        workspaceDir,
        query,
        limit,
        ...(signal ? { signal } : {}),
      })),
    ];
  }

  async listWorkspaceFileTreeCandidates(
    request: {
      roots: readonly TuiWorkspaceRoot[];
      path?: string;
    },
    signal?: AbortSignal,
  ): Promise<TuiWorkspaceTreeCandidate[]> {
    const roots = normalizeWorkspaceRoots(request.roots);
    const results = await Promise.all(
      roots.map(async (root) => {
        const entries = await this.listWorkspaceFileTree(root.path, request.path, signal);
        return entries.map((entry) => ({ ...entry, workspaceDir: root.path }));
      }),
    );
    return results.flat();
  }

  async searchWorkspaceFileCandidates(
    request: {
      roots: readonly TuiWorkspaceRoot[];
      query: string;
      limit?: number;
    },
    signal?: AbortSignal,
  ): Promise<TuiWorkspaceFileCandidate[]> {
    const roots = normalizeWorkspaceRoots(request.roots);
    const limit = Math.max(1, Math.floor(request.limit ?? 20));
    const results = await Promise.all(
      roots.map(async (root) => {
        const paths = await this.searchWorkspaceFiles(root.path, request.query, limit, signal);
        return paths.map((path) => ({ workspaceDir: root.path, path }));
      }),
    );
    const seen = new Set<string>();
    return interleave(results)
      .flatMap((candidate) => {
        const key = `${candidate.workspaceDir}\u0000${candidate.path}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [candidate];
      })
      .slice(0, limit);
  }
}

function normalizeFileTreeEntries(entries: readonly unknown[]): TuiWorkspaceFileEntry[] {
  return entries.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const entry = candidate as Record<string, unknown>;
    if (
      typeof entry.name !== 'string' ||
      typeof entry.path !== 'string' ||
      (entry.type !== 'file' && entry.type !== 'directory')
    ) {
      return [];
    }
    return [
      {
        name: entry.name,
        path: entry.path,
        type: entry.type,
        ...(typeof entry.ignored === 'boolean' ? { ignored: entry.ignored } : {}),
      },
    ];
  });
}

/**
 * Validates the Runtime's untyped review-link payload.
 *
 * Vendor, URL and number are required: a half-known review would render a
 * status line entry the user cannot act on, so such a payload is dropped
 * whole. A status the TUI does not know only loses its color.
 */
function normalizeReviewLink(value: unknown): TuiReviewLink | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const { vendor, url } = record;
  const reviewNumber = record.number;
  if (vendor !== 'github' && vendor !== 'gitlab') return undefined;
  if (typeof url !== 'string' || !url) return undefined;
  if (typeof reviewNumber !== 'number' || !Number.isInteger(reviewNumber) || reviewNumber <= 0) {
    return undefined;
  }
  return { vendor, url, number: reviewNumber, ...readReviewStatus(record.status) };
}

const REVIEW_STATUSES: ReadonlySet<string> = new Set(TUI_REVIEW_STATUSES);

function readReviewStatus(value: unknown): { status?: TuiReviewStatus } {
  return typeof value === 'string' && REVIEW_STATUSES.has(value)
    ? { status: value as TuiReviewStatus }
    : {};
}
