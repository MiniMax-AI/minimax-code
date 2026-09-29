import {
  LocalTurnDiffCapability,
  LocalTurnDiffRewindCapability,
  registerLocalAsset,
  registerSessionLocalAsset,
  resolveSessionLocalAsset,
  SqliteSessionAssetStore,
  SqliteLocalCommunicationMessageStore,
  SqliteLocalTurnDiffStore,
  readPreviewTrainPinnedItemsOrderPreference,
  type CopyPendingQuestionnaireForForkInput,
  type CreatedLocalRuntimeHost,
} from '@mavis/local-runtime';

import type {
  LegacyImportedAssetPort,
  SessionInputNavigationDiffReader,
} from '../../service/session-system/index.js';

type LegacyTurnDiffCapability = Pick<
  LocalTurnDiffCapability,
  'getSessionDiff' | 'getTurnDiff' | 'mutateTurnDiff'
> & {
  forkPrefix(input: {
    readonly operationId: string;
    readonly sourceSessionId: string;
    readonly targetSessionId: string;
    readonly targetWorkspaceDir: string;
    readonly retainedTurnIds: readonly string[];
    readonly rewindTargetWorkspace?: boolean;
    readonly excludedFilePaths?: readonly string[];
  }): Promise<void>;
};

type LegacyTurnDiffRewindCapability = Pick<
  LocalTurnDiffRewindCapability,
  'preview' | 'preflight' | 'apply' | 'deleteTurns'
>;

export interface V1SessionCompatibility {
  bindSessionPinReader(reader: (sessionId: string) => Promise<boolean>): void;
  /** Product file owner used only while the v2 importer copies legacy attachments. */
  readonly legacyMigration: {
    readonly primaryAgentName: string;
    readonly assets: LegacyImportedAssetPort;
    /** One-time source for pin refs persisted by preview_train before v2 cutover. */
    readonly readPinnedItemsOrder?: () => Promise<
      readonly { readonly type: 'agent' | 'session'; readonly id: string }[]
    >;
  };
  readonly canvasAssets: {
    importDeliverable(input: {
      readonly sessionId: string;
      readonly path: string;
    }): Promise<V1SessionAssetResolution | undefined>;
    importExternal(input: {
      readonly sessionId: string;
      readonly path: string;
    }): Promise<V1SessionAssetResolution | undefined>;
    resolve(input: {
      readonly sessionId: string;
      readonly assetId: string;
    }): Promise<V1SessionAssetResolution | undefined>;
  };
  readonly diff: {
    readonly capability: LegacyTurnDiffCapability;
    readonly rewind: LegacyTurnDiffRewindCapability;
    readonly inputNavigation: SessionInputNavigationDiffReader;
    pruneExpired(cutoffMs: number, batchSize: number): Promise<void>;
    deleteSession(sessionId: string): Promise<void>;
  };
  readonly communication: {
    deleteSession(sessionId: string): Promise<void>;
  };
  readonly channelBindings: {
    listSessionIds(): Promise<readonly string[]>;
    deleteSession(sessionId: string): Promise<void>;
  };
  readonly questionnaires: {
    copyPendingForFork(input: CopyPendingQuestionnaireForForkInput): Promise<void>;
    deleteSession(sessionId: string): Promise<void>;
  };
  readonly permissions: {
    copyForFork(input: {
      readonly sourceSessionId: string;
      readonly targetSessionId: string;
    }): Promise<void>;
    deleteSession(sessionId: string): Promise<void>;
  };
  readonly goals: {
    deleteSession(sessionId: string): Promise<void>;
    getBySession(sessionId: string): Promise<
      | {
          readonly goalId: string;
          readonly status: string;
        }
      | undefined
    >;
    classifyQueuedItem: CreatedLocalRuntimeHost['apiHost']['classifyThreadGoalQueuedItem'];
    prepareTurnAdmission?: CreatedLocalRuntimeHost['apiHost']['prepareThreadGoalTurnAdmission'];
    pauseActiveForAbort(sessionId: string): Promise<void>;
    bindAutomationOwnerConflictReader?(
      reader: (sessionId: string) => Promise<boolean> | boolean,
    ): void;
    bindVerifier?: CreatedLocalRuntimeHost['apiHost']['bindThreadGoalVerifier'];
    /** Builds the v1-owned delegation runner the subagent verifier backend dispatches into. */
    createSubagentExecution?: CreatedLocalRuntimeHost['apiHost']['createThreadGoalVerifierExecution'];
  };
  readonly workspace: {
    defaultDirectory(): string;
  };
}

interface V1SessionAssetResolution {
  readonly assetId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly absolutePath: string;
}

/** Constructs concrete v1 stores once and exposes only Session-owner-shaped capabilities. */
export function createV1SessionCompatibility(
  host: CreatedLocalRuntimeHost,
): V1SessionCompatibility {
  const api = host.apiHost;
  const diffStore = new SqliteLocalTurnDiffStore(host.dataDir);
  const communicationStore = new SqliteLocalCommunicationMessageStore(host.dataDir);
  const sessionAssets = new SqliteSessionAssetStore(host.dataDir);
  const diffCapability = new LocalTurnDiffCapability(diffStore, api.nowMs);
  const diffRewind = new LocalTurnDiffRewindCapability(diffStore);

  return {
    legacyMigration: {
      primaryAgentName: api.agentName,
      assets: {
        register: (input) => registerLocalAsset({ ...input, dataDir: host.dataDir }),
      },
      readPinnedItemsOrder: () => readPreviewTrainPinnedItemsOrderPreference(host.dataDir),
    },
    bindSessionPinReader: (reader) => {
      api.readSessionPinned = reader;
    },
    canvasAssets: {
      importDeliverable: async ({ sessionId, path }) => {
        if (!(await isRegisteredDeliverablePath(sessionAssets, sessionId, path))) return undefined;
        return toSessionAssetResolution(
          await registerSessionLocalAsset({
            dataDir: host.dataDir,
            sessionId,
            sourcePath: path,
            generatedBy: 'canvas',
          }),
        );
      },
      importExternal: async ({ sessionId, path }) => {
        try {
          return toSessionAssetResolution(
            await registerSessionLocalAsset({
              dataDir: host.dataDir,
              sessionId,
              sourcePath: path,
              generatedBy: 'canvas-external-file',
            }),
          );
        } catch {
          return undefined;
        }
      },
      resolve: async ({ sessionId, assetId }) => {
        const record = await resolveSessionLocalAsset({
          dataDir: host.dataDir,
          sessionId,
          assetId,
        });
        return record ? toSessionAssetResolution(record) : undefined;
      },
    },
    diff: {
      capability: diffCapability,
      rewind: diffRewind,
      inputNavigation: {
        listSessionDiffs: (sessionId) => diffStore.listFilePathsBySession(sessionId),
      },
      pruneExpired: async (cutoffMs, batchSize) => {
        await diffStore.pruneExpired(cutoffMs, batchSize);
      },
      deleteSession: (sessionId) => diffStore.deleteSession(sessionId),
    },
    communication: {
      deleteSession: (sessionId) => communicationStore.deleteSession(sessionId),
    },
    channelBindings: {
      listSessionIds: () => api.listChannelSessionIds(),
      deleteSession: async (sessionId) => {
        await api.deleteChannelBindingsForSession(sessionId);
      },
    },
    questionnaires: {
      copyPendingForFork: (input) => api.copyPendingQuestionnaireForFork(input),
      deleteSession: async (sessionId) => {
        await api.deleteQuestionnairesForSession(sessionId);
      },
    },
    permissions: {
      copyForFork: (input) => api.copyPermissionStateForFork(input),
      deleteSession: (sessionId) => api.deletePermissionStateForSession(sessionId),
    },
    goals: {
      deleteSession: async (sessionId) => {
        await api.deleteThreadGoalForSession(sessionId);
      },
      getBySession: async (sessionId) => {
        const goal = await api.threadGoal.store.getBySession(sessionId);
        return goal ? { goalId: goal.goalId, status: goal.status } : undefined;
      },
      classifyQueuedItem: (item, hasPendingPlan) =>
        api.classifyThreadGoalQueuedItem(item, hasPendingPlan),
      prepareTurnAdmission: (input) => api.prepareThreadGoalTurnAdmission(input),
      pauseActiveForAbort: (sessionId) => api.threadGoal.pauseActiveGoalForAbort(sessionId),
      bindAutomationOwnerConflictReader: (reader) =>
        api.bindThreadGoalAutomationOwnerConflictReader(reader),
      bindVerifier: (verifier, transcriptWindowReader) =>
        api.bindThreadGoalVerifier(verifier, transcriptWindowReader),
      createSubagentExecution: (registry) => api.createThreadGoalVerifierExecution(registry),
    },
    workspace: {
      defaultDirectory: () => api.resolveDefaultWorkspaceDir(),
    },
  };
}

async function isRegisteredDeliverablePath(
  store: SqliteSessionAssetStore,
  sessionId: string,
  path: string,
): Promise<boolean> {
  const expectedPath = path.trim();
  if (!expectedPath) return false;
  await store.ensureIndexed(sessionId);
  let cursor: string | undefined;
  do {
    const page = await store.listAssets(sessionId, { limit: 1000, cursor });
    if (page.assets.some((asset) => asset.path.trim() === expectedPath)) return true;
    cursor = page.nextCursor;
  } while (cursor);
  return false;
}

function toSessionAssetResolution(input: {
  readonly assetId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly absolutePath: string;
}): V1SessionAssetResolution {
  return {
    assetId: input.assetId,
    fileName: input.fileName,
    mimeType: input.mimeType,
    bytes: input.bytes,
    sha256: input.sha256,
    absolutePath: input.absolutePath,
  };
}
