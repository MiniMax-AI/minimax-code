import type {
  SessionFileAsset,
  SessionFilesPage,
  SessionFilesServiceOptions,
} from './contracts.js';
import { isSessionAssetIndexCurrent } from './index-policy.js';
import type { SessionAssetRecord } from './repo/contract.js';

export class SessionFilesService {
  private readonly nowMs: () => number;
  private readonly indexing = new Map<string, Promise<void>>();
  private readonly deleted = new Set<string>();

  constructor(private readonly options: SessionFilesServiceOptions) {
    this.nowMs = options.nowMs ?? Date.now;
  }

  async listSessionFiles(input: {
    readonly sessionId: string;
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<SessionFilesPage> {
    await this.ensureSessionFilesReady(input.sessionId);
    if (!(await this.isQueryable(input.sessionId))) return emptyPage();
    const page = await this.options.assets.listPage(input);
    return {
      files: page.assets.map(toSessionFileAsset),
      hasMore: page.hasMore,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  async ensureSessionFilesReady(sessionId: string): Promise<void> {
    if (!(await this.isQueryable(sessionId))) return;
    await this.ensureIndexed(sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.deleted.add(sessionId);
    const activeIndex = this.indexing.get(sessionId);
    if (activeIndex) {
      try {
        await activeIndex;
      } catch {
        // A failed rebuild must not prevent idempotent Session cleanup.
      }
    }
    await this.options.assets.deleteSession(sessionId);
  }

  private async ensureIndexed(sessionId: string): Promise<void> {
    const current = this.indexing.get(sessionId);
    if (current) return current;
    const operation = this.runIndex(sessionId);
    this.indexing.set(sessionId, operation);
    return operation;
  }

  private async runIndex(sessionId: string): Promise<void> {
    try {
      await this.buildIndex(sessionId);
    } finally {
      this.indexing.delete(sessionId);
    }
  }

  private async buildIndex(sessionId: string): Promise<void> {
    if (!(await this.isQueryable(sessionId))) return;
    const latestRowId = await this.options.messages.latestDisplayRowId(sessionId);
    if (!(await this.isQueryable(sessionId))) return;
    const state = await this.options.assets.getIndexState(sessionId);
    if (isSessionAssetIndexCurrent(state, latestRowId)) return;
    await this.options.assets.rebuild(sessionId, this.nowMs());
  }

  private async isQueryable(sessionId: string): Promise<boolean> {
    return !this.deleted.has(sessionId) && (await this.options.sessions.has(sessionId));
  }
}

export type {
  SessionFileAsset,
  SessionFilesPage,
  SessionFilesServiceOptions,
} from './contracts.js';

function emptyPage(): SessionFilesPage {
  return { files: [], hasMore: false };
}

function toSessionFileAsset(asset: SessionAssetRecord): SessionFileAsset {
  return {
    messageId: asset.messageId,
    messageCreatedAtMs: asset.messageCreatedAtMs,
    assetKey: asset.assetKey,
    sourceTag: asset.sourceTag,
    path: asset.path,
    name: asset.name,
    assetType: asset.assetType,
    dataJson: asset.dataJson,
  };
}
