import type { createSessionAssetRepository } from '../files/repo/assets.js';
import type { SessionHistoryMutationCapability } from '../messages/history/mutation/session-history-mutation-adapter.js';
import type { MessageRepository } from '../messages/repo/contract.js';
import type { SessionRecordService } from '../sessions/lifecycle/record-service.js';
import type { SessionRepository } from '../sessions/repo/contract.js';
import { isTaskSession } from '../sessions/repo/drizzle/normalization.js';
import type { SessionRecord } from '../sessions/index.js';
import { CURRENT_SESSION_DATA_VERSION } from '../sessions/support/version.js';
import { createSessionForkDisplayCapability } from './display-data-capability.js';

/** Session-owned metadata, Display and asset operations used by Application Fork. */
export function createSessionForkDataCapability(input: {
  readonly sessions: SessionRepository;
  readonly records: SessionRecordService;
  readonly messages: MessageRepository;
  readonly assets: ReturnType<typeof createSessionAssetRepository>;
  readonly historyMutation: SessionHistoryMutationCapability;
}) {
  const display = createSessionForkDisplayCapability(input.messages, input.historyMutation);
  return {
    sessionDataVersion: CURRENT_SESSION_DATA_VERSION,
    boundary: display.boundary,
    sessions: {
      get: (sessionId: string) => input.sessions.get(sessionId),
      titleExists: async ({
        agentName,
        title,
      }: {
        readonly agentName: string;
        readonly title: string;
      }) =>
        (
          await input.sessions.list({
            agentName,
            parentSessionId: null,
            includeHidden: true,
            includeSessionKinds: ['conversation', 'cron'],
          })
        ).some((session) => session.title === title),
      probe: async ({
        sessionId,
        visibility,
      }: {
        readonly sessionId: string;
        readonly visibility: 'hidden' | 'visible';
      }) => {
        const session = await input.sessions.get(sessionId);
        return session?.visibility === visibility ? session : undefined;
      },
      create: async (session: ForkSessionInput) => {
        return input.records.createInternalSession({
          agentName: session.agentName,
          workspaceDir: session.workspaceDir,
          title: session.title,
          sessionType: 'branch',
          sessionKind: session.sessionKind ?? 'conversation',
          parentSessionId: session.parentSessionId ?? null,
          visibility: session.visibility ?? 'hidden',
          ...(session.isDefaultWorkspace !== undefined
            ? {
                isDefaultWorkspace: session.isDefaultWorkspace,
                preserveDefaultWorkspaceIdentity: true,
              }
            : {}),
          ...(session.appMode ? { appMode: session.appMode } : {}),
          // ForkService always sets it from the source; no branch keeps create() under budget.
          toolCallMode: session.toolCallMode,
          ...(session.runLocation ? { runLocation: session.runLocation } : {}),
          ...(await readForkedBindingFields(input.records, session)),
          ...(session.effectiveModel !== undefined
            ? { effectiveModel: session.effectiveModel }
            : {}),
          ...(session.effectiveModelVariant !== undefined
            ? { effectiveModelVariant: session.effectiveModelVariant }
            : {}),
          effectiveModelThinking: session.effectiveModelThinking,
          effectiveModelContextWindow: session.effectiveModelContextWindow,
          effectiveModelMaxOutputTokens: session.effectiveModelMaxOutputTokens,
          ...(session.purpose ? { purpose: session.purpose } : {}),
          origin: 'user',
        });
      },
      update: (sessionId: string, fields: { readonly visibility?: 'hidden' | 'visible' }) =>
        input.records.mutateSession(sessionId, fields),
      delete: (sessionId: string) => input.records.discardCreatedSession(sessionId),
    },
    display,
    assets: {
      copyPrefix: async (
        request: {
          readonly sourceSessionId: string;
          readonly targetSessionId: string;
          readonly messageIds: readonly string[];
        } & (
          | { readonly mode: 'records-only' }
          | {
              readonly mode: 'workspace-copy';
              readonly sourceWorkspaceDir: string;
              readonly targetWorkspaceDir: string;
            }
        ),
      ) => input.assets.copyForMessagePrefix(request),
      probe: (probe: {
        readonly targetSessionId: string;
        readonly mode?: 'records-only' | 'workspace-copy';
        readonly targetRoot?: string;
        readonly copiedPaths: readonly string[];
      }) =>
        input.assets.probeCopy({
          sessionId: probe.targetSessionId,
          ...(probe.mode ? { mode: probe.mode } : {}),
          ...(probe.targetRoot ? { targetRoot: probe.targetRoot } : {}),
          copiedPaths: probe.copiedPaths,
        }),
      compensate: (cleanup: {
        readonly targetSessionId: string;
        readonly mode?: 'records-only' | 'workspace-copy';
        readonly targetRoot?: string;
        readonly copiedPaths?: readonly string[];
      }) =>
        input.assets.compensateCopy({
          sessionId: cleanup.targetSessionId,
          ...(cleanup.mode ? { mode: cleanup.mode } : {}),
          ...(cleanup.targetRoot ? { targetRoot: cleanup.targetRoot } : {}),
          ...(cleanup.copiedPaths ? { copiedPaths: cleanup.copiedPaths } : {}),
        }),
    },
  };
}

type ForkSessionInput = {
  readonly sourceSessionId: string;
  readonly agentName: string;
  readonly workspaceDir: string;
  readonly isDefaultWorkspace?: SessionRecord['isDefaultWorkspace'];
  readonly title: string;
  readonly appMode?: SessionRecord['appMode'];
  readonly toolCallMode?: SessionRecord['toolCallMode'];
  readonly runLocation?: Parameters<
    SessionRecordService['createInternalSession']
  >[0]['runLocation'];
  readonly effectiveModel?: SessionRecord['effectiveModel'];
  readonly effectiveModelVariant?: SessionRecord['effectiveModelVariant'];
  readonly effectiveModelThinking?: SessionRecord['effectiveModelThinking'];
  readonly effectiveModelContextWindow?: SessionRecord['effectiveModelContextWindow'];
  readonly effectiveModelMaxOutputTokens?: SessionRecord['effectiveModelMaxOutputTokens'];
  readonly parentSessionId?: string;
  readonly visibility?: 'hidden' | 'visible';
  readonly purpose?: string;
  readonly sessionKind?: SessionRecord['sessionKind'];
};

async function readForkedBindingFields(records: SessionRecordService, session: ForkSessionInput) {
  const target = {
    sessionKind: session.sessionKind ?? 'conversation',
    sessionType: 'branch' as const,
    parentSessionId: session.parentSessionId ?? null,
    visibility: session.visibility ?? 'hidden',
    ...(session.purpose ? { purpose: session.purpose } : {}),
  };
  if (!isTaskSession(target)) return {};
  const source = await records.ensureSessionAgentDefinition(session.sourceSessionId);
  return source ? { forkedAgentDefinition: { definition: source.definition } } : {};
}
