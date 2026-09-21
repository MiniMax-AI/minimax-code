import { randomUUID } from 'node:crypto';
import { isDefaultAgentAvatarMarker } from '@mavis/shared/agent-avatar';
import {
  BoundedInternalTurnPromptReadRegistry,
  isPromptSnapshotInvalidError,
  type InternalTurnPromptReadRegistry,
  type PromptReadScope,
  type PromptSnapshotSource,
} from '@mavis/agent-runtime';
import type {
  NativeSessionAgentDirectory,
  RootAgentPort,
  RootAgentRecord,
  SessionRecord,
} from '../../service/session-system/index.js';
import {
  AgentServiceError,
  type AgentCreateInput,
  type AgentConfiguredDefinition,
  type AgentConfigDocument,
  AgentImportService,
  type AgentImportFormat,
  type LocalAgentService,
  type AgentUpdateInput,
  type AgentView,
} from '../../service/agent/index.js';
import { SAFETY_SCENE, type ContentSafetyService } from '../../service/content-safety/index.js';
import { type GlobalEventPublisher, publishBestEffort } from '../events.js';
import type { PinService } from '../../service/pin/index.js';
import {
  previewAgentModelSelection,
  type LocalRuntimeConfig,
} from '../../service/model-system/index.js';
import { parseCanonicalAgentMarkdown } from '../../service/agent/storage/canonical-agent-config.js';
import { asAgentConfigServiceError } from '../../service/agent/application/agent-profile.js';
import { isUnmanagedConfigModel } from '../config-field-review-policy.js';
import { isCommandLineRuntimeOwner } from './profile-source.js';

/** The Agent being saved owns this selection; the active Session is irrelevant. */
type AgentConfigReviewTarget =
  | { readonly kind: 'definition'; readonly model?: string }
  | { readonly kind: 'document'; readonly content: string; readonly requestRef: string }
  | { readonly kind: 'existing'; readonly requestRef: string };

/** The only Session-facing Agent read/write surface assembled by V2. */
export interface AgentSessionPorts {
  readonly directory: NativeSessionAgentDirectory;
  readonly roots: RootAgentPort;
  readonly resolveWriteTarget: (requestRef: string) => Promise<string>;
  readonly requireExactAgentKey: (requestRef: string) => Promise<string>;
}

/** Existing Root application API; AgentApplication never reimplements root promotion. */
export interface AgentRootApplicationPort {
  getRootSessionByAgent(agentName: string): Promise<SessionRecord>;
}

export interface AgentApplicationOptions {
  readonly service: LocalAgentService;
  readonly root: AgentRootApplicationPort;
  /** Product-event publisher borrowed from the V2 service composition. */
  readonly publish?: GlobalEventPublisher;
  readonly deleteAgentCronTasks?: (agentName: string) => Promise<void>;
  readonly removeAgentPin?: (agentName: string) => Promise<void>;
  /** Compatibility content-safety gate for persisted, user-controlled fields. */
  readonly reviewConfigFields?: (
    values: ReadonlyArray<string | null | undefined>,
    target: AgentConfigReviewTarget,
  ) => Promise<void>;
  readonly greeting?: {
    readonly enabled: boolean;
    readonly canSend?: () => boolean;
    /** Shared with Turn preparation so a Greeting Turn cannot mix prompt versions. */
    readonly promptSnapshots?: PromptSnapshotSource;
    readonly promptReads?: InternalTurnPromptReadRegistry;
    readonly sendSystemReminder: (input: {
      readonly agentName: string;
      readonly sessionId: string;
      readonly content: string;
      readonly requestedTurnId: string;
    }) => Promise<'finished' | { readonly status: 'accepted'; readonly turnId: string }>;
  };
}

interface RuntimeAgentApplicationCompositionInput {
  readonly pinService: Pick<PinService, 'removeAgent'>;
  readonly agentService: LocalAgentService;
  readonly safety: ContentSafetyService;
  readonly config: () => LocalRuntimeConfig;
  readonly writeGlobalEvent: GlobalEventPublisher;
  readonly internalTurnPromptReads: InternalTurnPromptReadRegistry;
  readonly product: {
    readonly promptSnapshots?: PromptSnapshotSource;
  };
  readonly options: {
    readonly runtimeOwnerKind?: string;
    readonly greetingEnabled?: boolean;
    readonly compatibility: {
      readonly cron: {
        readonly deleteAgentTasks: NonNullable<AgentApplicationOptions['deleteAgentCronTasks']>;
      };
      readonly greeting: {
        readonly canSend: NonNullable<NonNullable<AgentApplicationOptions['greeting']>['canSend']>;
        readonly sendSystemReminder: NonNullable<
          AgentApplicationOptions['greeting']
        >['sendSystemReminder'];
      };
    };
  };
}

interface RuntimeAgentApplicationRoot {
  readonly session: {
    readonly root: AgentRootApplicationPort;
  };
}

/** Binds the runtime-owned safety and lifecycle capabilities to Agent workflows. */
export function createRuntimeAgentApplication(
  input: RuntimeAgentApplicationCompositionInput,
  applications: RuntimeAgentApplicationRoot,
): AgentApplication {
  const { options, safety } = input;
  return new AgentApplication({
    service: input.agentService,
    root: applications.session.root,
    publish: input.writeGlobalEvent,
    deleteAgentCronTasks: (agentName) => options.compatibility.cron.deleteAgentTasks(agentName),
    removeAgentPin: (agentName) => input.pinService.removeAgent(agentName),
    reviewConfigFields: async (values, target) => {
      if (
        isCommandLineRuntimeOwner(options.runtimeOwnerKind) &&
        values.some((value) => value?.trim())
      ) {
        const configuredModel = await agentConfigReviewModel(input.agentService, target);
        const config = input.config();
        const model = previewAgentModelSelection({
          config,
          sources: configuredModel === undefined ? [] : [
            {
              source: 'agent-config-review',
              selection: { model: configuredModel },
              requireCatalog: true,
              allowCustomProviderPrefixFallback: true,
              defaultMissingEffortOff: true,
            },
          ],
        });
        if (model && isUnmanagedConfigModel(config, `${model.providerId}/${model.modelId}`)) return;
      }
      await reviewAgentConfigFields(safety, values);
    },
    greeting: {
      enabled: options.greetingEnabled === true,
      canSend: () => options.compatibility.greeting.canSend(),
      sendSystemReminder: (reminder) => options.compatibility.greeting.sendSystemReminder(reminder),
      promptReads: input.internalTurnPromptReads,
      ...(input.product.promptSnapshots ? { promptSnapshots: input.product.promptSnapshots } : {}),
    },
  });
}

/**
 * Cross-capability Agent workflows. The Agent service remains the Agent owner;
 * this class only sequences Agent persistence with the existing Root owner.
 */
export class AgentApplication {
  private closed = false;
  private ensureBuiltinPromise: Promise<readonly AgentView[]> | undefined;
  private ensureBuiltinDefinitionsPromise: Promise<readonly AgentView[]> | undefined;
  private readonly greetingInFlight = new Set<string>();
  private readonly pendingGreetingByTurn = new Map<string, string>();
  /** Ephemeral only: opaque scopes never enter queue storage, history, or public APIs. */
  private readonly promptReads: InternalTurnPromptReadRegistry;

  constructor(private readonly options: AgentApplicationOptions) {
    this.promptReads = options.greeting?.promptReads ?? new BoundedInternalTurnPromptReadRegistry();
  }

  /** Consumed by TurnPreflight once an internally rendered Turn owns its lease. */
  takeInternalTurnPromptRead(turnId: string): PromptReadScope | undefined {
    return this.promptReads.take(turnId);
  }

  close(): void {
    this.closed = true;
    this.promptReads.close();
    this.pendingGreetingByTurn.clear();
    this.greetingInFlight.clear();
  }

  list(options?: Parameters<LocalAgentService['list']>[0]): Promise<readonly AgentView[]> {
    return this.options.service.list(options);
  }

  get(
    requestRef: string,
    options?: Parameters<LocalAgentService['get']>[1],
  ): ReturnType<LocalAgentService['get']> {
    return this.options.service.get(requestRef, options);
  }

  getConfigDocument(requestRef: string): ReturnType<LocalAgentService['getConfigDocument']> {
    return this.options.service.getConfigDocument(requestRef);
  }

  async putConfigDocument(
    input: Parameters<LocalAgentService['putConfigDocument']>[0],
  ): ReturnType<LocalAgentService['putConfigDocument']> {
    await this.reviewConfigFields([input.content], {
      kind: 'document',
      content: input.content,
      requestRef: input.requestRef,
    });
    return this.options.service.putConfigDocument(input);
  }

  resolveAgentWriteTarget(requestRef: string): Promise<string> {
    return this.options.service.resolveAgentWriteTarget(requestRef);
  }

  getLegacyHistoryNotice(
    requestRef: string,
  ): ReturnType<LocalAgentService['getLegacyHistoryNotice']> {
    return this.options.service.getLegacyHistoryNotice(requestRef);
  }

  /**
   * Definition-only creation: no Root, no Session, no greeting (product
   * decision 2026-09-04; the legacy Root-materializing `create` path was
   * removed after the V2 HTTP endpoint retired it). The management page
   * creates a regular top-level Session only when the user explicitly
   * chooses Chat.
   */
  async createDefinition(input: AgentCreateInput): Promise<AgentView> {
    await this.reviewConfigFields(createDefinitionReviewFields(input), {
      kind: 'definition',
      model: input.initialDefinition?.model,
    });
    const created = await this.options.service.create(input);
    publishBestEffort(this.options.publish ?? (() => undefined), {
      type: 'agent.created',
      payload: { agentName: created.exactOwnerName },
    });
    return created;
  }

  /**
   * Creates an imported Custom Agent definition only. In particular this must
   * not ask the Root application to materialize a Root/Session: Chat owns that
   * later, explicit action.
   */
  async createImportedDefinition(input: {
    readonly format: AgentImportFormat;
    readonly content: string;
    readonly expectedDigest: string;
    readonly targetName: string;
    readonly acceptedIssueIds?: readonly string[];
  }): Promise<{ readonly agent: AgentView; readonly config: AgentConfigDocument }> {
    const preview = new AgentImportService().create(input);
    await this.reviewConfigFields([preview.canonicalContent], {
      kind: 'definition',
      model: preview.candidate.model,
    });
    const created = await this.options.service.create({
      name: preview.proposedName,
      displayName: preview.candidate.name,
      description: preview.candidate.description,
      systemPrompt: preview.candidate.systemPrompt,
    });
    let createdOwnerInstanceId: string | undefined;
    try {
      createdOwnerInstanceId = await this.options.service.getOrCreateCustomAgentInstanceId(
        `agent:${created.exactOwnerName}`,
      );
      const current = await this.options.service.getConfigDocument(
        `agent:${created.exactOwnerName}`,
      );
      const config = await this.options.service.putConfigDocument({
        requestRef: `agent:${created.exactOwnerName}`,
        content: preview.canonicalContent,
        expectedRevision: current.revision,
        expectedOwnerInstanceId: createdOwnerInstanceId,
      });
      publishBestEffort(this.options.publish ?? (() => undefined), {
        type: 'agent.created',
        payload: { agentName: created.exactOwnerName },
      });
      return { agent: created, config };
    } catch (error) {
      return rollbackImportedAgent(
        this.options.service,
        created.exactOwnerName,
        createdOwnerInstanceId,
        error,
      );
    }
  }

  async update(input: AgentUpdateInput): Promise<AgentView> {
    await this.reviewConfigFields(
      [
        input.displayName,
        input.description,
        input.persona,
        input.systemPrompt,
        ...(isNonTextAgentAvatar(input.avatar) ? [] : [input.avatar]),
      ],
      { kind: 'existing', requestRef: input.requestRef },
    );
    return this.options.service.update(input);
  }

  setRootSession(requestRef: string, sessionId: string): Promise<boolean> {
    return this.options.service.setRootSession(requestRef, sessionId);
  }

  listLegacyPinnedAgentRefs(): Promise<readonly { id: string; pinnedAt: number | null }[]> {
    return this.options.service.listLegacyPinnedAgentRefs?.() ?? Promise.resolve([]);
  }

  async delete(requestRef: string): Promise<void> {
    const exactOwnerName = await this.options.service.requireExactAgentKey(requestRef);
    await this.options.service.delete(`agent:${exactOwnerName}`);
    // Product decision 2026-09-04: cron tasks are intentionally NOT cascaded
    // on Agent delete (desktop and cloud agree). Orphaned tasks stay listed
    // and fail at trigger time; users manage them from the scheduled-tasks UI.
    await this.options.removeAgentPin?.(exactOwnerName);
  }

  ensureBuiltinAgents(): Promise<readonly AgentView[]> {
    this.ensureBuiltinPromise ??= this.runEnsureBuiltinAgents();
    return this.ensureBuiltinPromise;
  }

  /**
   * Phase-2 startup deliberately does not materialize legacy Root sessions.
   * Keep this separate from ensureBuiltinAgents(), which is the V1 facade
   * contract and therefore still repairs or creates each builtin Root.
   */
  ensureBuiltinDefinitionsForPhase2(): Promise<readonly AgentView[]> {
    this.ensureBuiltinDefinitionsPromise ??= this.runEnsureBuiltinDefinitionsForPhase2();
    return this.ensureBuiltinDefinitionsPromise;
  }

  /** Startup-only canonicalization, deliberately after builtin rows exist. */
  materializeLegacyCustomAgents(): Promise<{
    readonly materialized: number;
    readonly alreadyCanonical: number;
    readonly notLegacy: number;
  }> {
    return this.options.service.materializeLegacyCustomAgents();
  }

  /** Schedules V2-owned greeting turns; CLI composition leaves this disabled. */
  async scheduleBuiltinGreetings(): Promise<void> {
    if (this.closed) return;
    const greeting = this.options.greeting;
    if (!greeting?.enabled || greeting.canSend?.() === false) return;
    const agents = await this.options.service.list();
    if (this.closed) return;
    await Promise.all(
      agents
        .filter((agent) => agent.creationSource === 'builtin')
        .map((agent) => this.scheduleGreeting(agent)),
    );
  }

  async retryBuiltinGreetings(): Promise<void> {
    await this.scheduleBuiltinGreetings();
  }

  async notifyGreetingTurnTerminal(
    turnId: string,
    status: 'completed' | 'failed' | 'cancelled',
  ): Promise<void> {
    const agentName = this.pendingGreetingByTurn.get(turnId);
    if (!agentName) return;
    this.promptReads.discard(turnId);
    this.pendingGreetingByTurn.delete(turnId);
    this.greetingInFlight.delete(agentName);
    if (status === 'completed') await this.options.service.markGreetingSent(agentName);
  }

  private async ensureBuiltinRowsOnly(): Promise<readonly AgentView[]> {
    return this.ensureBuiltinRows({ ensureRoots: false });
  }

  private async ensureBuiltinRowsAndRoots(): Promise<readonly AgentView[]> {
    return this.ensureBuiltinRows({ ensureRoots: true });
  }

  private async ensureBuiltinRows(options: {
    readonly ensureRoots: boolean;
  }): Promise<readonly AgentView[]> {
    const seeded = await this.options.service.ensureBuiltinRows();
    if (!options.ensureRoots) return this.options.service.list();
    for (const agent of seeded) {
      if (agent.creationSource !== 'builtin') continue;
      await this.options.root.getRootSessionByAgent(agent.exactOwnerName);
    }
    return this.options.service.list();
  }

  private async runEnsureBuiltinAgents(): Promise<readonly AgentView[]> {
    try {
      return await this.ensureBuiltinRowsAndRoots();
    } finally {
      this.ensureBuiltinPromise = undefined;
    }
  }

  private async runEnsureBuiltinDefinitionsForPhase2(): Promise<readonly AgentView[]> {
    try {
      return await this.ensureBuiltinRowsOnly();
    } finally {
      this.ensureBuiltinDefinitionsPromise = undefined;
    }
  }

  private async reviewConfigFields(
    values: ReadonlyArray<string | null | undefined>,
    target: AgentConfigReviewTarget,
  ): Promise<void> {
    await this.options.reviewConfigFields?.(values, target);
  }

  private async scheduleGreeting(agent: AgentView): Promise<void> {
    if (this.closed) return;
    const greeting = this.options.greeting;
    if (!greeting || !greeting.enabled || greeting.canSend?.() === false) return;
    if (this.greetingInFlight.has(agent.exactOwnerName)) return;
    const state = await this.options.service.getGreetingState(agent.exactOwnerName);
    if (!state || state.greetingSent || !state.rootSessionId) return;
    await this.dispatchGreeting(agent, state.rootSessionId, greeting);
  }

  private async dispatchGreeting(
    agent: AgentView,
    rootSessionId: string,
    greeting: NonNullable<AgentApplicationOptions['greeting']>,
  ): Promise<void> {
    if (this.closed) return;
    this.greetingInFlight.add(agent.exactOwnerName);
    const requestedTurnId = `turn_greeting_${randomUUID()}`;
    this.pendingGreetingByTurn.set(requestedTurnId, agent.exactOwnerName);
    if (greeting.promptSnapshots && !this.promptReads.reserve(requestedTurnId)) {
      this.pendingGreetingByTurn.delete(requestedTurnId);
      this.greetingInFlight.delete(agent.exactOwnerName);
      return;
    }
    try {
      const rendered = await this.renderGreeting(agent.exactOwnerName, greeting);
      if (this.closed) {
        this.clearGreetingDispatch(agent.exactOwnerName, requestedTurnId);
        return;
      }
      if (rendered.promptRead) this.promptReads.remember(requestedTurnId, rendered.promptRead);
      const result = await greeting.sendSystemReminder({
        agentName: agent.exactOwnerName,
        sessionId: rootSessionId,
        content: rendered.content,
        requestedTurnId,
      });
      if (this.closed) {
        this.clearGreetingDispatch(agent.exactOwnerName, requestedTurnId);
        return;
      }
      if (result === 'finished') {
        this.promptReads.discard(requestedTurnId);
        this.pendingGreetingByTurn.delete(requestedTurnId);
        this.greetingInFlight.delete(agent.exactOwnerName);
        await this.options.service.markGreetingSent(agent.exactOwnerName);
      } else if (result.turnId !== requestedTurnId) {
        this.promptReads.rebind(requestedTurnId, result.turnId);
        this.pendingGreetingByTurn.delete(requestedTurnId);
        this.pendingGreetingByTurn.set(result.turnId, agent.exactOwnerName);
      }
    } catch {
      this.clearGreetingDispatch(agent.exactOwnerName, requestedTurnId);
      // Keep greetingSent=false so the next ensure/retry can try again.
    }
  }

  private async renderGreeting(
    agentName: string,
    greeting: NonNullable<AgentApplicationOptions['greeting']>,
  ): Promise<{ readonly content: string; readonly promptRead?: PromptReadScope }> {
    const source = greeting.promptSnapshots;
    if (!source) {
      const content = await this.options.service.buildGreetingReminder(agentName);
      if (this.closed) throw new GreetingDispatchClosedError();
      return { content };
    }
    const promptRead = { source, snapshot: await source.capture() };
    if (this.closed) throw new GreetingDispatchClosedError();
    try {
      const content = await this.options.service.buildGreetingReminder(agentName, promptRead);
      if (this.closed) throw new GreetingDispatchClosedError();
      return {
        content,
        promptRead,
      };
    } catch (error) {
      if (!isPromptSnapshotInvalidError(error)) throw error;
      const builtinPromptRead = { source, snapshot: await source.captureBuiltin() };
      if (this.closed) throw new GreetingDispatchClosedError();
      const content = await this.options.service.buildGreetingReminder(
        agentName,
        builtinPromptRead,
      );
      if (this.closed) throw new GreetingDispatchClosedError();
      return {
        content,
        promptRead: builtinPromptRead,
      };
    }
  }

  private clearGreetingDispatch(agentName: string, turnId: string): void {
    this.promptReads.discard(turnId);
    this.pendingGreetingByTurn.delete(turnId);
    this.greetingInFlight.delete(agentName);
  }
}

/** Local Electron image bytes are validated and materialized by AgentFiles, not text-reviewed. */
function isLocalAgentImageDataUrl(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith('data:image/');
}

function isNonTextAgentAvatar(value: string | null | undefined): boolean {
  return isLocalAgentImageDataUrl(value) || isDefaultAgentAvatarMarker(value);
}

function createDefinitionReviewFields(
  input: AgentCreateInput,
): ReadonlyArray<string | null | undefined> {
  const definition = input.initialDefinition;
  return definition === undefined
    ? legacyCreateDefinitionReviewFields(input)
    : initialDefinitionReviewFields(input, definition);
}

function legacyCreateDefinitionReviewFields(
  input: AgentCreateInput,
): ReadonlyArray<string | null | undefined> {
  return [
    ...(input.name === undefined ? [] : [input.name]),
    input.displayName,
    input.description,
    input.persona,
    input.systemPrompt,
    ...reviewableAvatar(input.avatar),
  ];
}

function initialDefinitionReviewFields(
  input: AgentCreateInput,
  definition: AgentConfiguredDefinition,
): ReadonlyArray<string | null | undefined> {
  const mavis = definition.mavis;
  return [
    input.name ?? definition.name,
    definition.description,
    definition.model,
    definition.effort,
    ...(definition.tools ?? []),
    ...(definition.disallowedTools ?? []),
    ...(definition.mcpServers ?? []),
    ...(definition.skills ?? []),
    mavis?.displayName ?? input.displayName,
    ...reviewableAvatar(mavis?.avatar ?? input.avatar),
    mavis?.defaultWorkspaceDir ?? input.defaultWorkspaceDir,
    ...(mavis?.extensionSkills ?? []),
    definition.systemPrompt,
  ];
}

function reviewableAvatar(
  value: string | null | undefined,
): readonly (string | null | undefined)[] {
  return isNonTextAgentAvatar(value) ? [] : [value];
}

class GreetingDispatchClosedError extends Error {}

async function agentConfigReviewModel(
  service: LocalAgentService,
  target: AgentConfigReviewTarget,
): Promise<string | undefined> {
  if (target.kind === 'definition') return target.model;
  if (target.kind === 'existing') {
    return (await service.getConfigDocument(target.requestRef)).configured.model;
  }
  try {
    // Review the candidate, including model changes/removal, rather than the
    // persisted definition or its cached effective-model preview.
    return parseCanonicalAgentMarkdown(target.content, target.requestRef).model;
  } catch (error) {
    throw asAgentConfigServiceError(error);
  }
}

async function reviewAgentConfigFields(
  safety: ContentSafetyService,
  values: ReadonlyArray<string | null | undefined>,
): Promise<void> {
  for (const raw of values) {
    const value = raw?.trim() ?? '';
    if (!value) continue;
    if (await safety.blocks(value, SAFETY_SCENE.ConfigField)) {
      throw new AgentServiceError('CONTENT_POLICY_VIOLATION', 'Content validation failed');
    }
  }
}

export function createAgentSessionPorts(service: LocalAgentService): AgentSessionPorts {
  const roots: RootAgentPort = {
    clearRootSession: (agentName, sessionId) => service.clearRootSessionByExactOwner(agentName, sessionId),
    get: async (agentName) => {
      const view = await service.getPersistedOwner(agentName);
      return view ? toRootAgentRecord(view) : undefined;
    },
    setRootSession: (agentName, sessionId) =>
      service.setRootSessionByExactOwner(agentName, sessionId),
  };
  return {
    roots,
    resolveWriteTarget: (requestRef) => service.resolveAgentWriteTarget(requestRef),
    requireExactAgentKey: (requestRef) => service.requireExactAgentKey(requestRef),
    directory: {
      get: async (agentName) => {
        const view = await service.getPersistedOwner(agentName);
        if (!view) return undefined;
        return view.defaultWorkspaceDir ? { defaultWorkspaceDir: view.defaultWorkspaceDir } : {};
      },
    },
  };
}

function toRootAgentRecord(agent: AgentView): RootAgentRecord {
  return {
    agentName: agent.exactOwnerName,
    ...(agent.rootSessionId ? { rootSessionId: agent.rootSessionId } : {}),
    ...(agent.displayName ? { displayName: agent.displayName } : {}),
    ...(agent.defaultWorkspaceDir ? { defaultWorkspaceDir: agent.defaultWorkspaceDir } : {}),
  };
}

async function rollbackImportedAgent(
  service: LocalAgentService,
  exactOwnerName: string,
  createdOwnerInstanceId: string | undefined,
  originalError: unknown,
): Promise<never> {
  if (createdOwnerInstanceId === undefined) {
    throw new AggregateError(
      [originalError],
      `Agent import failed before conditional cleanup became available: ${exactOwnerName}`,
    );
  }
  try {
    await service.deleteIfOwnerInstanceId(`agent:${exactOwnerName}`, createdOwnerInstanceId);
  } catch (cleanupError) {
    throw new AggregateError(
      [originalError, cleanupError],
      `Agent import failed and conditional cleanup did not complete: ${exactOwnerName}`,
    );
  }
  throw originalError;
}
