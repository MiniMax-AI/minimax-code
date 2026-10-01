import type { MessageRepository } from '../messages/repo/contract.js';
import type { SessionRepository } from '../sessions/repo/contract.js';
import type { SessionAssetRepository } from './repo/contract.js';

export interface SessionFilesServiceOptions {
  readonly messages: Pick<MessageRepository, 'latestDisplayRowId'>;
  readonly assets: SessionAssetRepository;
  readonly sessions: Pick<SessionRepository, 'has'>;
  readonly nowMs?: () => number;
}

export interface SessionFileAsset {
  readonly messageId: string;
  readonly messageCreatedAtMs: number;
  readonly assetKey: string;
  readonly sourceTag: string;
  readonly path: string;
  readonly name: string | null;
  readonly assetType: string | null;
  readonly dataJson: string;
}

export interface SessionFilesPage {
  readonly files: readonly SessionFileAsset[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}
