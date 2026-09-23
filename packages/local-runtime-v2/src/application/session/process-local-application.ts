import type { GlobalEvent } from '@mavis/shared/global-events';
import { isLegacyManagedMinimaxProvider } from '@mavis/config';

import {
  annotateModelFavorites,
  modelFavoriteRefs,
  type CodexOAuthManager,
  type LocalModelProviderService,
  type ModelFavoritesPreference,
  type ModelSystemOwner,
  type ModelProviderView,
  type UserModelInputView,
} from '../../service/model-system/index.js';
import { watchGlobalEvents, watchProcessEvents } from '../events.js';
import type { ModelProviderApplication } from './model-provider-application.js';
import type {
  LocalRuntimeApplication,
  ProcessLocalModelInput,
} from './process-local-application-contract.js';
import type { SessionReportCapability } from '../../service/session-system/index.js';

export interface ProcessLocalApplicationOptions {
  readonly eventBus: {
    subscribe(subscriber: { next(event: GlobalEvent): void }): () => void;
  };
  readonly usageCommits?: {
    subscribe(listener: (sessionId: string) => void): () => void;
  };
  readonly skills: LocalRuntimeApplication['skills'];
  readonly plugins: LocalRuntimeApplication['plugins'];
  readonly miniApps?: LocalRuntimeApplication['miniApps'];
  readonly workspace: NonNullable<LocalRuntimeApplication['workspace']>;
  readonly plan: NonNullable<LocalRuntimeApplication['plan']>;
  readonly sessionReports?: SessionReportCapability;
  readonly instructions?: LocalRuntimeApplication['instructions'];
  readonly modelProvider: {
    readonly application: Pick<ModelProviderApplication, 'list' | 'select'>;
    readonly providers: LocalModelProviderService;
    readonly listProviderPresets: ModelSystemOwner['listProviderPresets'];
    readonly oauth: Pick<CodexOAuthManager, 'getStatus' | 'startLogin' | 'cancelLogin'>;
    readonly favorites?: Pick<ModelFavoritesPreference, 'list' | 'set'>;
  };
  readonly peripherals: Required<
    Pick<
      LocalRuntimeApplication,
      | 'mcp'
      | 'goals'
      | 'questionnaires'
      | 'permissions'
      | 'account'
      | 'diagnostics'
      | 'configuration'
      | 'backgroundTasks'
    >
  >;
}

/** Composes peripheral product capabilities for process-local delivery. */
export function createProcessLocalApplication(
  options: ProcessLocalApplicationOptions,
): LocalRuntimeApplication {
  const sessionReports = options.sessionReports;
  return {
    events: {
      watch: (signal) =>
        watchGlobalEvents((subscriber) => options.eventBus.subscribe({ next: subscriber }), signal),
    },
    ...(options.usageCommits
      ? {
          usage: {
            watchCommits: (signal?: AbortSignal) =>
              watchProcessEvents(
                (subscriber) => options.usageCommits?.subscribe(subscriber) ?? (() => undefined),
                signal,
              ),
          },
        }
      : {}),
    skills: {
      listSkills: (input) => options.skills.listSkills(input),
      listRuntimeSkills: (input) => options.skills.listRuntimeSkills(input),
    },
    plugins: options.plugins,
    ...(options.miniApps ? { miniApps: options.miniApps } : {}),
    mcp: options.peripherals.mcp,
    goals: options.peripherals.goals,
    questionnaires: options.peripherals.questionnaires,
    plan: options.plan,
    backgroundTasks: options.peripherals.backgroundTasks,
    permissions: options.peripherals.permissions,
    account: {
      getStatus: async (input) => {
        let status = await options.peripherals.account.getStatus(input);
        if (isLegacyManagedMinimaxProvider(selectedProviderId(status) ?? '')) {
          const selected = (await options.modelProvider.application.list(input)).find(
            (model) => model.selected,
          );
          if (selected?.providerId === 'minimax') {
            status = {
              ...status,
              selection: {
                defaultModel: `minimax/${selected.modelId}`,
                providerId: selected.providerId,
                modelId: selected.modelId,
              },
              provider: {
                id: selected.providerId,
                authMode: selected.providerKind === 'minimax-managed' ? 'managed-login' : 'api-key',
              },
            };
          }
        }
        if (selectedProviderId(status) !== 'minimax') return status;
        const source = options.modelProvider.providers.getMinimaxModelSource();
        return {
          ...status,
          modelSource: source === 'minimax_api_key' ? 'byok' : 'token-plan',
        };
      },
    },
    diagnostics: {
      getRuntimeSnapshot: () => options.peripherals.diagnostics.getRuntimeSnapshot(),
      ...(sessionReports
        ? {
            collectSessionReport: (sessionId: string) => sessionReports.collect(sessionId),
          }
        : {}),
    },
    ...(options.instructions ? { instructions: options.instructions } : {}),
    configuration: options.peripherals.configuration,
    models: createModelsApplication(options.modelProvider),
    modelProviders: {
      listProviderPresets: () => options.modelProvider.listProviderPresets(),
      getCodexOAuthStatus: async () => options.modelProvider.oauth.getStatus(),
      startCodexOAuthLogin: (input) => options.modelProvider.oauth.startLogin(input),
      cancelCodexOAuthLogin: async (loginId) => options.modelProvider.oauth.cancelLogin(loginId),
      listUser: async () =>
        options.modelProvider.providers.listUserProviders().map(toProviderRecord),
      getMiniMaxApiKeyStatus: async () => options.modelProvider.providers.getMinimaxApiKeyStatus(),
      getMiniMaxModelSource: async () => options.modelProvider.providers.getMinimaxModelSource(),
      setMiniMaxModelSource: async ({ source }) => {
        await options.modelProvider.providers.setMinimaxModelSource(source);
        return source;
      },
      upsertMiniMaxApiKey: async (request) =>
        options.modelProvider.providers.upsertMinimaxApiKey(request),
      create: async ({ models, ...request }) =>
        options.modelProvider.providers.createUserProvider({
          ...request,
          ...(models ? { models: toUserModelInputs(models) } : {}),
        }),
      discoverCandidate: (candidate) =>
        options.modelProvider.providers.discoverUserModelsCandidate(candidate),
      saveCandidate: async ({ candidate: { models, ...candidate }, ...request }) => {
        const outcome = await options.modelProvider.providers.saveUserModelProviderCandidate({
          ...request,
          candidate: {
            ...candidate,
            ...(models ? { models: toUserModelInputs(models) } : {}),
          },
        });
        return {
          success: outcome.ok,
          ...(outcome.status ? { status: { ...outcome.status } } : {}),
          ...(outcome.provider ? { provider: toProviderRecord(outcome.provider) } : {}),
        };
      },
      update: async ({ models, ...request }) =>
        options.modelProvider.providers.updateUserProvider({
          ...request,
          ...(models ? { models: toUserModelInputs(models) } : {}),
        }),
      delete: ({ providerId }) =>
        options.modelProvider.providers.deleteUserProvider({ providerId }),
      testProvider: async ({ providerId }) => {
        const outcome = await options.modelProvider.providers.testProvider(providerId);
        return { success: outcome.ok, status: outcome.status };
      },
      testModel: async ({ providerId, modelId }) => {
        const outcome = await options.modelProvider.providers.testModel(providerId, modelId);
        return { success: outcome.ok, status: outcome.status };
      },
    },
    workspace: options.workspace,
  };
}

function selectedProviderId(status: Record<string, unknown>): string | undefined {
  const selection = asRecord(status.selection);
  const provider = asRecord(status.provider);
  if (typeof selection?.providerId === 'string') {
    return selection.providerId;
  }
  return typeof provider?.id === 'string' ? provider.id : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toProviderRecord(provider: ModelProviderView): Record<string, unknown> {
  return { ...provider };
}

function toUserModelInputs(
  models: readonly ProcessLocalModelInput[],
): UserModelInputView[] {
  return models.map(({ modalities, ...model }) => ({
    ...model,
    ...(modalities
      ? {
          modalities: {
            ...(modalities.input ? { input: [...modalities.input] } : {}),
            ...(modalities.output ? { output: [...modalities.output] } : {}),
          },
        }
      : {}),
  }));
}

function createModelsApplication(
  modelProvider: ProcessLocalApplicationOptions['modelProvider'],
): NonNullable<LocalRuntimeApplication['models']> {
  const favorites = modelProvider.favorites;
  const list = (request: { sessionId?: string } = {}) =>
    modelProvider.application.list(request);
  if (!favorites) {
    return { list, select: (request) => modelProvider.application.select(request) };
  }
  return {
    list: async (request = {}) => {
      const models = await list(request);
      // A broken preference row must never hide the catalog.
      let saved: ReturnType<typeof favorites.list> = [];
      try {
        saved = favorites.list();
      } catch {
        saved = [];
      }
      return annotateModelFavorites(models, saved);
    },
    select: (request) => modelProvider.application.select(request),
    setFavorite: async (request) => {
      // Prune stale favorites only against a catalog we actually read.
      let catalog: ReturnType<typeof modelFavoriteRefs> | undefined;
      try {
        catalog = modelFavoriteRefs(await list({}));
      } catch {
        catalog = undefined;
      }
      if (catalog && catalog.length === 0) catalog = undefined;
      favorites.set(request, catalog);
      return true;
    },
  };
}
