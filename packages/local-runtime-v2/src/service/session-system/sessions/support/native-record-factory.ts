import { getConfig } from '@mavis/config';

import { mkdir } from 'node:fs/promises';

import type { SessionRepository } from '../repo/contract.js';
import type { ProjectRepository } from '../../projects/repo/contract.js';
import { SessionServiceError } from '../errors.js';
import {
  SessionRecordService,
  type SessionBackfillDiagnostics,
  type SessionRecordServiceDeps,
} from '../lifecycle/record-service.js';
import { SessionUniqueViolation } from '../repo/contract.js';
import { applyLocalRunLocation, readLocalRunLocationInput } from './run-location.js';
import { CURRENT_SESSION_DATA_VERSION } from './version.js';

export interface NativeSessionAgentRecord {
  readonly defaultWorkspaceDir?: string;
}

export interface NativeSessionAgentDirectory {
  get(agentName: string): Promise<NativeSessionAgentRecord | undefined>;
}

export interface NativeSessionRecordFactoryOptions {
  readonly sessionRepository: Pick<
    SessionRepository,
    | 'get'
    | 'list'
    | 'create'
    | 'update'
    | 'delete'
    | 'listPage'
    | 'getSessionAgentDefinition'
    | 'backfillSessionAgentDefinitionIfAbsent'
    | 'replaceSessionAgentDefinitionIfLegacy'
    | 'getTaskAgentBinding'
    | 'backfillTaskAgentBindingIfAbsent'
  >;
  readonly projectRepository: Pick<ProjectRepository, 'ensureByWorkspaceDir' | 'ensureDefault'>;
  readonly agentDirectory: NativeSessionAgentDirectory;
  readonly titlePolicy: SessionRecordServiceDeps['titlePolicy'];
  readonly resolveRequestedModel?: SessionRecordServiceDeps['resolveRequestedModel'];
  readonly artifacts: NonNullable<SessionRecordServiceDeps['artifacts']>;
  readonly facts: SessionRecordServiceDeps['facts'];
  readonly defaultWorkspaceDir?: () => string;
  readonly agentInternalWorkspaceDir?: (agentName: string) => string;
  readonly sessionDefaultWorkspaceDir?: (sessionId: string) => string;
  readonly workspace?: NonNullable<SessionRecordServiceDeps['workspace']>;
  readonly makeSessionId?: () => string;
  readonly nowMs?: () => number;
  readonly runLocation?: SessionRecordServiceDeps['runLocation'];
  readonly backfillDiagnostics?: SessionBackfillDiagnostics;
}

export function createNativeSessionRecordService(
  options: NativeSessionRecordFactoryOptions,
): SessionRecordService {
  const { sessionRepository, projectRepository, agentDirectory, nowMs = Date.now } = options;
  return new SessionRecordService({
    sessions: sessionRepository,
    agentBindings: sessionRepository,
    metadata: {
      create: async (input) => {
        try {
          const project = input.isDefaultWorkspace
            ? await projectRepository.ensureDefault(nowMs())
            : await projectRepository.ensureByWorkspaceDir(input.workspaceDir, nowMs());
          if (!project) {
            throw new SessionServiceError(
              'workspace-required',
              'Session Project could not be resolved',
            );
          }
          return await sessionRepository.create({
            ...input,
            projectId: project.projectId,
            runtime: 'pi-agent',
            status: 'idle',
            archived: false,
            sessionDataVersion: CURRENT_SESSION_DATA_VERSION,
            sessionOrigin: 'local-runtime',
          });
        } catch (error) {
          if (error instanceof SessionUniqueViolation) {
            throw new SessionServiceError(
              'session-id-conflict',
              `Session already exists: ${input.sessionId}`,
            );
          }
          throw error;
        }
      },
      update: (sessionId, fields, expectedModel, expectedTitle) =>
        sessionRepository.update(sessionId, fields, expectedModel, expectedTitle),
      delete: (sessionId) => sessionRepository.delete(sessionId),
    },
    agents: {
      getDefaults: async (agentName) => {
        const agent = await agentDirectory.get(agentName);
        if (!agent) return undefined;
        return agent.defaultWorkspaceDir ? { defaultWorkspaceDir: agent.defaultWorkspaceDir } : {};
      },
    },
    runLocation: options.runLocation ?? {
      resolve: async (value, workspaceDir) => {
        const input = readLocalRunLocationInput(value);
        return input
          ? applyLocalRunLocation(
              input,
              workspaceDir,
              nowMs,
              getConfig().worktreeRefreshBeforeCreate,
            )
          : undefined;
      },
    },
    titlePolicy: options.titlePolicy,
    ...(options.resolveRequestedModel
      ? { resolveRequestedModel: options.resolveRequestedModel }
      : {}),
    artifacts: options.artifacts,
    facts: options.facts,
    workspace: options.workspace ?? {
      initialize: async (workspaceDir) => {
        await mkdir(workspaceDir, { recursive: true, mode: 0o700 });
      },
    },
    ...(options.defaultWorkspaceDir ? { defaultWorkspaceDir: options.defaultWorkspaceDir } : {}),
    ...(options.agentInternalWorkspaceDir
      ? { agentInternalWorkspaceDir: options.agentInternalWorkspaceDir }
      : {}),
    ...(options.sessionDefaultWorkspaceDir
      ? { sessionDefaultWorkspaceDir: options.sessionDefaultWorkspaceDir }
      : {}),
    ...(options.makeSessionId ? { makeSessionId: options.makeSessionId } : {}),
    ...(options.backfillDiagnostics ? { backfillDiagnostics: options.backfillDiagnostics } : {}),
  });
}
