import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

import * as acp from '@agentclientprotocol/sdk';

import { executeTuiInteractiveTurn } from '../application/interactive-turn-delivery.js';
import { TuiLoginRequiredError, requireTuiAgentAccess } from '../application/login-gate.js';
import type { TuiPermissionMode } from '../application/permission-mode.js';
import { TuiRunCoordinator } from '../application/run-coordinator.js';
import type { TuiRunResult } from '../application/run-coordinator.js';
import { isTuiInternalSubagentSession } from '../runtime/delegation.js';
import type {
  TuiPlanClientIntent,
  TuiRuntimeEvent,
  TuiModel,
  TuiSession,
  TuiSessionMcpServer,
} from '../runtime/port.js';
import { buildTuiMessageParts } from '../runtime/stream-events.js';
import type { TuiMessage, TuiStreamEvent } from '../runtime/stream-events.js';
import type { TuiAcpRuntime } from './runtime.js';
import { availableSkillCommands, executeTuiAcpCommand, TUI_ACP_AVAILABLE_COMMANDS } from './commands.js';
import {
  ACP_CONFIG_MODEL,
  ACP_CONFIG_PERMISSION_MODE,
  ACP_CONFIG_THINKING_EFFORT,
  ACP_MODE_DEFAULT,
  ACP_MODE_PLAN,
  getTuiAcpSessionControlState,
  parseModelConfigValue,
  usageUpdate,
} from './control-state.js';
import {
  registerTuiAcpExtensions,
  resolveRootSessionId,
  supportsTuiAcpExtensionNotifications,
  TUI_ACP_EXTENSION_VERSION,
  tuiAcpExtensionCapabilities,
} from './extensions.js';
import { runTuiAcpInteractions, type TuiAcpRuntimeProjection } from './interactions.js';
import { modelSupportsVariant } from './model-selection.js';
import { TuiAcpPromptContinuation } from './prompt-continuation.js';
import { TuiAcpUpdateProjector } from './updates.js';

const AUTH_METHOD_ID = 'minimax-code-login';
const AVAILABLE_COMMANDS_RETRY_DELAY_MS = 100;
const ACP_HISTORY_PAGE_SIZE = 100;
const MAX_DETACHED_LIFECYCLES_PER_SESSION = 2;
const MAX_DETACHED_LIFECYCLES_TOTAL = 32;
const MAX_ADMITTED_LIFECYCLES_PER_SESSION = 64;
const MAX_ADMITTED_LIFECYCLES_TOTAL = 256;
const MAX_ACTIVE_NEW_OPERATIONS = 8;
const MAX_ACTIVE_FORK_OPERATIONS = 8;

interface AcpSession {
  session: TuiSession;
  mcpServers: readonly TuiSessionMcpServer[];
  coordinator: TuiRunCoordinator;
  readonly attachmentController: AbortController;
  pendingModeIntent?: TuiPlanClientIntent;
  activePrompt?: {
    readonly controller: AbortController;
    readonly continuation: TuiAcpPromptContinuation;
    readonly targetModeId: typeof ACP_MODE_DEFAULT | typeof ACP_MODE_PLAN;
    steerableTurnId?: string;
  };
}

export interface CreateTuiAcpAgentOptions {
  readonly runtime: TuiAcpRuntime;
  readonly version: string;
  readonly createTurnId?: () => string;
  readonly runtimeEventProjectionTimeoutMs?: number;
}

export function createTuiAcpAgent(options: CreateTuiAcpAgentOptions): acp.AgentApp {
  const sessions = new Map<string, AcpSession>();
  const provisionalNewSessions = new Map<
    string,
    { readonly token: symbol; readonly settled: Promise<void> }
  >();
  const runtimeParentSessionIds = new Map<string, string>();
  const activePlans = new Map<
    string,
    { readonly delivered: Promise<boolean>; readonly attachment: AcpSession }
  >();
  const planAttachments = new Map<string, AcpSession>();
  const runSessionLifecycle = createKeyedSerialExecutor();
  const runSessionMcpMutation = createKeyedSerialExecutor();
  const runSessionConfigMutation = createKeyedSerialExecutor();
  const runPermissionMutation = createKeyedSerialExecutor();
  const promptCancelEpochs = new Map<string, number>();
  const promptCancelLatches = new Set<string>();
  const createTurnId = options.createTurnId ?? randomUUID;
  let activeAcpSessionId: string | undefined;
  let activeNewOperations = 0;
  let activeForkOperations = 0;
  let hasConnected = false;
  let activeConnection: acp.AgentConnection | undefined;
  let clientCapabilities: acp.ClientCapabilities = {};
  let pendingPermissionBroadcast: readonly (readonly [string, AcpSession])[] | undefined;
  let permissionBroadcastRunning = false;
  const app = acp.agent({ name: 'minimax-code' });

  const advertiseAvailableCommands = (client: acp.AgentContext, sessionId: string): void => {
    const attachment = sessions.get(sessionId);
    if (!attachment) return;
    let commands: acp.AvailableCommand[] = [...TUI_ACP_AVAILABLE_COMMANDS];
    const isCurrent = () =>
      sessions.get(sessionId) === attachment && !attachment.attachmentController.signal.aborted;
    const notify = () => {
      if (!isCurrent()) return;
      void client
        .notify(acp.methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: commands,
          },
        })
        .catch(() => undefined);
    };

    // Preserve immediate native command discovery even if Skill discovery fails or stalls.
    setImmediate(() => {
      if (!isCurrent()) return;
      notify();
      void (async () => {
        const skills = await options.runtime.listSkills(
          attachment.session.agentName,
          undefined,
          attachment.session.workspaceDir,
        );
        if (!isCurrent()) return;
        commands = [...TUI_ACP_AVAILABLE_COMMANDS, ...availableSkillCommands(skills)];
        notify();
      })().catch(() => undefined);
    });
    // Some clients attach their notification listener after receiving the Session response.
    // Retry the latest roster, so a late native-only update cannot erase discovered Skills.
    const retry = setTimeout(notify, AVAILABLE_COMMANDS_RETRY_DELAY_MS);
    retry.unref();
  };

  const schedulePermissionBroadcast = (
    client: acp.AgentContext,
    attachments: readonly (readonly [string, AcpSession])[],
  ) => {
    pendingPermissionBroadcast = attachments;
    if (permissionBroadcastRunning) return;
    permissionBroadcastRunning = true;
    void (async () => {
      try {
        while (pendingPermissionBroadcast) {
          const pending = pendingPermissionBroadcast;
          pendingPermissionBroadcast = undefined;
          try {
            await notifyPermissionConfigUpdates(
              options.runtime,
              client,
              sessions,
              pending,
              options.runtimeEventProjectionTimeoutMs ?? 5_000,
            );
          } catch (error) {
            pendingPermissionBroadcast = undefined;
            activeConnection?.close(
              error instanceof Error ? error : new Error('ACP permission state broadcast failed.'),
            );
            return;
          }
        }
      } finally {
        permissionBroadcastRunning = false;
        if (pendingPermissionBroadcast) {
          schedulePermissionBroadcast(client, pendingPermissionBroadcast);
        }
      }
    })().catch(() => undefined);
  };

  const retireAttachmentPlans = (
    sessionId: string,
    attachment: AcpSession,
    client: acp.AgentContext,
  ) => {
    const prefix = `${sessionId}\0`;
    const connection = activeConnection;
    for (const [key, candidate] of planAttachments) {
      if (key.startsWith(prefix) && candidate === attachment) planAttachments.delete(key);
    }
    for (const [key, record] of activePlans) {
      if (!key.startsWith(prefix) || record.attachment !== attachment) continue;
      activePlans.delete(key);
      const planId = key.slice(prefix.length);
      void notifyWithDeadline(
        record.delivered.then(async (delivered) => {
          if (!delivered) return;
          await client.notify(acp.methods.client.session.update, {
            sessionId,
            update: { sessionUpdate: 'plan_removed', planId },
          });
        }),
        options.runtimeEventProjectionTimeoutMs ?? 5_000,
      ).catch((error) => {
        connection?.close(
          error instanceof Error ? error : new Error('ACP required Plan removal delivery failed.'),
        );
      });
    }
  };

  const clearDetachedClientState = (
    sessionId: string,
    client: acp.AgentContext,
    attachment?: AcpSession,
  ) => {
    if (attachment) retireAttachmentPlans(sessionId, attachment, client);
    else {
      deleteActivePlansForSession(activePlans, sessionId);
      deletePlanAttachmentsForSession(planAttachments, sessionId);
    }
    if (activeAcpSessionId !== sessionId) return;
    activeAcpSessionId = undefined;
    if (supportsTuiAcpExtensionNotifications(clientCapabilities)) {
      void client
        .notify('mcode/session/current_session_update', { sessionId: null })
        .catch(() => undefined);
    }
  };

  const detachAttachment = (
    sessionId: string,
    attachment: AcpSession | undefined,
    reason: string,
    client: acp.AgentContext,
  ): boolean => {
    if (!attachment) return false;
    attachment.attachmentController.abort(new Error(reason));
    if (sessions.get(sessionId) !== attachment) return false;
    sessions.delete(sessionId);
    clearDetachedClientState(sessionId, client, attachment);
    return true;
  };

  registerTuiAcpExtensions({
    app,
    runtime: options.runtime,
    resolveSession: (sessionId) => sessions.get(sessionId)?.session,
    activateSession: (sessionId) => {
      activeAcpSessionId = sessionId;
    },
    extensionNotificationsEnabled: () => supportsTuiAcpExtensionNotifications(clientCapabilities),
    activePromptTurnId: (sessionId) => {
      const prompt = sessions.get(sessionId)?.activePrompt;
      return prompt && !prompt.controller.signal.aborted ? prompt.steerableTurnId : undefined;
    },
  });

  const attachPersistedSession = async (
    params: acp.LoadSessionRequest | acp.ResumeSessionRequest,
    signal: AbortSignal,
    client: acp.AgentContext,
    onOverlayMutationStart?: (attachment: AcpSession | undefined, runtimeSessionId: string) => void,
    onAttachmentPrepared?: (attachment: AcpSession) => void,
  ): Promise<AcpSession> => {
    assertLifecycleActive(signal);
    assertNoAdditionalDirectories(params.additionalDirectories);
    await assertAuthenticated(options.runtime);
    assertLifecycleActive(signal);
    for (
      let provisionalNewSession = provisionalNewSessions.get(params.sessionId);
      provisionalNewSession;
      provisionalNewSession = provisionalNewSessions.get(params.sessionId)
    ) {
      await provisionalNewSession.settled;
      assertLifecycleActive(signal);
    }
    await runSessionMcpMutation(params.sessionId, async (mcpSignal) => {
      assertLifecycleActive(signal);
      assertLifecycleActive(mcpSignal);
    });
    assertLifecycleActive(signal);
    await runSessionConfigMutation(params.sessionId, async (configSignal) => {
      assertLifecycleActive(signal);
      assertLifecycleActive(configSignal);
    });
    assertLifecycleActive(signal);
    const existing = sessions.get(params.sessionId);
    if (existing?.activePrompt) {
      throw acp.RequestError.invalidParams(
        undefined,
        'A prompt is already active for this session.',
      );
    }
    const session = await getPersistedSession(options.runtime, params.sessionId);
    assertLifecycleActive(signal);
    assertAcpSessionUsable(session);
    assertMatchingCwd(session, params.cwd);
    await hydrateRuntimeAncestry(
      options.runtime,
      runtimeParentSessionIds,
      session.sessionId,
      signal,
    );
    const mcpServers = mapClientMcpServers(params.mcpServers ?? []);
    try {
      await runSessionMcpMutation(params.sessionId, async (mcpSignal) => {
        try {
          assertLifecycleActive(signal);
          assertLifecycleActive(mcpSignal);
          onOverlayMutationStart?.(existing, session.sessionId);
          await options.runtime.clearSessionMcpServers(session.sessionId);
          assertLifecycleActive(signal);
          assertLifecycleActive(mcpSignal);
          if (mcpServers.length > 0) {
            await options.runtime.configureSessionMcpServers(session.sessionId, mcpServers);
            assertLifecycleActive(signal);
            assertLifecycleActive(mcpSignal);
          }
        } catch (error) {
          detachAttachment(
            params.sessionId,
            existing,
            'ACP Session attachment invalidated by MCP overlay failure.',
            client,
          );
          await options.runtime.clearSessionMcpServers(session.sessionId).catch(() => undefined);
          throw error;
        }
      });
    } catch (error) {
      detachAttachment(
        params.sessionId,
        existing,
        'ACP Session attachment invalidated by MCP overlay failure.',
        client,
      );
      throw error;
    }
    const active = {
      session,
      mcpServers,
      coordinator: new TuiRunCoordinator(options.runtime),
      attachmentController: new AbortController(),
    };
    onAttachmentPrepared?.(active);
    assertLifecycleActive(signal);
    if (existing) {
      existing.attachmentController.abort(new Error('ACP Session attachment replaced.'));
      retireAttachmentPlans(params.sessionId, existing, client);
    }
    sessions.set(params.sessionId, active);
    return active;
  };

  app.onConnect((connection) => {
    if (hasConnected) {
      connection.close(new Error('MCode ACP supports exactly one Client connection per process.'));
      return;
    }
    hasConnected = true;
    activeConnection = connection;
    void runTuiAcpInteractions({
      runtime: options.runtime,
      connection,
      resolveSession: (runtimeSessionId) => {
        const resolved = resolveOwnedRuntimeSession(
          sessions,
          runtimeParentSessionIds,
          runtimeSessionId,
        );
        if (!resolved) return undefined;
        const [acpSessionId, active] = resolved;
        return {
          acpSessionId,
          session: active.session,
          attachmentSignal: active.attachmentController.signal,
          isCurrent: () =>
            !active.attachmentController.signal.aborted && sessions.get(acpSessionId) === active,
        };
      },
      clientCapabilities: () => clientCapabilities,
      onRuntimeEvent: (event) => {
        if (event.type === 'session.created' && event.sessionId && event.parentSessionId) {
          runtimeParentSessionIds.set(event.sessionId, event.parentSessionId);
        } else if (event.type === 'session.deleted' && event.sessionId) {
          runtimeParentSessionIds.delete(event.sessionId);
        }
        for (const session of sessions.values()) session.activePrompt?.continuation.observe(event);
      },
      createRuntimeEventProjections: (event) =>
        createRuntimeControlProjections({
          runtime: options.runtime,
          client: connection.client,
          clientCapabilities,
          sessions,
          activePlans,
          planAttachments,
          runtimeParentSessionIds,
          event,
        }),
      projectionTimeoutMs: options.runtimeEventProjectionTimeoutMs,
      onQuestionnaireSettled: ({ sessionId, requestId, continued }) => {
        sessions
          .get(sessionId)
          ?.activePrompt?.continuation.settleQuestionnaire(requestId, continued);
        const key = planKey(sessionId, requestId);
        const attachment = planAttachments.get(key);
        if (!attachment) return [];
        planAttachments.delete(key);
        const activePlan = activePlans.get(key);
        if (!activePlan) return [];
        activePlans.delete(key);
        return [
          {
            key: planProjectionKey(sessionId, requestId),
            required: true,
            run: async (signal: AbortSignal) => {
              const delivered = await activePlan.delivered;
              if (!delivered || signal.aborted) return;
              await connection.client.notify(acp.methods.client.session.update, {
                sessionId,
                update: { sessionUpdate: 'plan_removed', planId: requestId },
              });
            },
          },
        ];
      },
    });
  });

  app.onRequest(acp.methods.agent.initialize, ({ params }) => {
    clientCapabilities = params.clientCapabilities ?? {};
    const extensionCapabilities = tuiAcpExtensionCapabilities(options.runtime);
    const supportsTerminalAuth =
      clientCapabilities.auth?.terminal === true ||
      clientCapabilities._meta?.['terminal-auth'] === true;
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: {
          http: true,
          sse: true,
        },
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: false,
        },
        sessionCapabilities: {
          list: {},
          fork: {},
          resume: {},
          close: {},
        },
      },
      ...(supportsTerminalAuth
        ? {
            authMethods: [
              {
                type: 'terminal' as const,
                id: AUTH_METHOD_ID,
                name: 'Sign in to MiniMax Code',
                args: ['login'],
              },
            ],
          }
        : {}),
      agentInfo: {
        name: 'minimax-code',
        title: 'MiniMax Code',
        version: options.version,
      },
      _meta: {
        'minimax-code/extensions': {
          version: TUI_ACP_EXTENSION_VERSION,
          methods: [...extensionCapabilities.methods],
          notifications: [...extensionCapabilities.notifications],
        },
      },
    };
  });

  app.onRequest(acp.methods.agent.authenticate, async ({ params }) => {
    if (params.methodId !== AUTH_METHOD_ID) {
      throw acp.RequestError.invalidParams(undefined, 'Unknown authentication method.');
    }
    await assertAuthenticated(options.runtime);
    return {};
  });

  app.onRequest(acp.methods.agent.session.new, async (context) => {
    if (activeNewOperations >= MAX_ACTIVE_NEW_OPERATIONS) {
      throw acp.RequestError.requestCancelled(
        undefined,
        'Too many ACP Session creation operations are already running.',
      );
    }
    activeNewOperations += 1;
    const { params } = context;
    let session: TuiSession | undefined;
    let attachment: AcpSession | undefined;
    let provisional: { readonly token: symbol; readonly settle: () => void } | undefined;
    let delivered = false;
    let cleanupPromise: Promise<void> | undefined;
    const settleProvisional = () => {
      if (!session || !provisional) return;
      if (provisionalNewSessions.get(session.sessionId)?.token === provisional.token) {
        provisionalNewSessions.delete(session.sessionId);
      }
      provisional.settle();
      provisional = undefined;
    };
    const cleanup = (): Promise<void> => {
      if (cleanupPromise) return cleanupPromise;
      if (!session) return Promise.resolve();
      const current = sessions.get(session.sessionId);
      if (current && current !== attachment) {
        cleanupPromise = Promise.resolve();
        return cleanupPromise;
      }
      detachAttachment(
        session.sessionId,
        attachment,
        'ACP Session creation was cancelled or failed.',
        context.client,
      );
      cleanupPromise = options.runtime.deleteSession(session.sessionId);
      return cleanupPromise;
    };
    let rejectCancelled!: (error: unknown) => void;
    const cancelled = new Promise<never>((_, reject) => {
      rejectCancelled = reject;
    });
    const onAbort = () => {
      if (delivered) return;
      if (session) {
        void cleanup().then(settleProvisional, (error) => {
          activeConnection?.close(
            error instanceof Error
              ? error
              : new Error('Failed to clean up a cancelled ACP Session creation.'),
          );
        });
      }
      rejectCancelled(
        acp.RequestError.requestCancelled(undefined, 'ACP Session creation was cancelled.'),
      );
    };
    context.signal.addEventListener('abort', onAbort, { once: true });
    const operation = (async () => {
      try {
        assertLifecycleActive(context.signal);
        assertNoAdditionalDirectories(params.additionalDirectories);
        await assertAuthenticated(options.runtime);
        assertLifecycleActive(context.signal);
        const mcpServers = mapClientMcpServers(params.mcpServers);
        session = await options.runtime.createSession({
          workspaceDir: params.cwd,
          ...(mcpServers.length > 0 ? { mcpServers } : {}),
        });
        const provisionalToken = Symbol(session.sessionId);
        let resolveProvisional!: () => void;
        const provisionalSettled = new Promise<void>((settle) => {
          resolveProvisional = settle;
        });
        provisional = { token: provisionalToken, settle: resolveProvisional };
        provisionalNewSessions.set(session.sessionId, {
          token: provisionalToken,
          settled: provisionalSettled,
        });
        assertLifecycleActive(context.signal);
        attachment = {
          session,
          mcpServers,
          coordinator: new TuiRunCoordinator(options.runtime),
          attachmentController: new AbortController(),
        };
        const control = await getTuiAcpSessionControlState(options.runtime, session);
        assertLifecycleActive(context.signal);
        if (sessions.has(session.sessionId)) {
          throw acp.RequestError.invalidParams(
            undefined,
            `Session ${session.sessionId} was attached before creation completed.`,
          );
        }
        sessions.set(session.sessionId, attachment);
        advertiseAvailableCommands(context.client, session.sessionId);
        delivered = true;
        settleProvisional();
        return { sessionId: session.sessionId, ...control };
      } catch (error) {
        try {
          await cleanup();
          settleProvisional();
        } catch {
          throw acp.RequestError.internalError(
            undefined,
            session
              ? `Failed to complete new Session ${session.sessionId}, and cleanup failed.`
              : 'Failed to create a new ACP Session.',
          );
        }
        throw error;
      }
    })();
    void operation.then(
      () => {
        activeNewOperations -= 1;
      },
      () => {
        activeNewOperations -= 1;
      },
    );
    if (context.signal.aborted) onAbort();
    try {
      return await Promise.race([operation, cancelled]);
    } finally {
      context.signal.removeEventListener('abort', onAbort);
    }
  });

  app.onRequest(acp.methods.agent.session.list, async ({ params }) => {
    await assertAuthenticated(options.runtime);
    if (params.cwd && !isAbsolute(params.cwd)) {
      throw acp.RequestError.invalidParams(undefined, 'Session list cwd must be absolute.');
    }
    const page = await options.runtime.listSessionPage({
      includeArchived: true,
      ...(params.cwd ? { workspaceDir: params.cwd } : {}),
      ...(params.cursor ? { cursor: params.cursor } : {}),
    });
    return {
      sessions: page.sessions.flatMap(toAcpSessionInfo),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  });

  app.onRequest(acp.methods.agent.session.fork, async (context) => {
    if (activeForkOperations >= MAX_ACTIVE_FORK_OPERATIONS) {
      throw acp.RequestError.requestCancelled(
        undefined,
        'Too many ACP Session fork operations are already running.',
      );
    }
    activeForkOperations += 1;
    const operation = (async () => {
      const { params } = context;
      assertNoAdditionalDirectories(params.additionalDirectories);
      await assertAuthenticated(options.runtime);
      assertLifecycleActive(context.signal);
      const source = await getPersistedSession(options.runtime, params.sessionId);
      assertLifecycleActive(context.signal);
      assertAcpSessionUsable(source);
      assertMatchingCwd(source, params.cwd);
      const mcpServers =
        params.mcpServers === undefined
          ? (sessions.get(source.sessionId)?.mcpServers ?? [])
          : mapClientMcpServers(params.mcpServers);
      const forkOptions = await options.runtime.getSessionForkOptions(source.sessionId);
      assertLifecycleActive(context.signal);
      if (!forkOptions.canFork) {
        throw acp.RequestError.invalidParams(
          undefined,
          forkOptions.unavailableReason ?? 'Runtime rejected this Session fork.',
        );
      }
      const result = await options.runtime.forkSession({
        sessionId: source.sessionId,
        clientRequestId: randomUUID(),
        useSuggestedTitle: true,
        createIsolatedWorktree: false,
      });
      return runSessionLifecycle.reserved(result.session.sessionId, async (lifecycleSignal) => {
        const existing = sessions.get(result.session.sessionId);
        let existingOverlayTouched = false;
        try {
          const requestSignal = AbortSignal.any([lifecycleSignal, context.signal]);
          assertLifecycleActive(requestSignal);
          if (existing?.activePrompt) {
            throw acp.RequestError.invalidParams(
              undefined,
              'A prompt is already active for the forked session.',
            );
          }
          await runSessionMcpMutation(result.session.sessionId, async (mcpSignal) => {
            const mutationSignal = AbortSignal.any([requestSignal, mcpSignal]);
            assertLifecycleActive(mutationSignal);
            if (existing) {
              existingOverlayTouched = true;
              await options.runtime.clearSessionMcpServers(result.session.sessionId);
              assertLifecycleActive(mutationSignal);
            }
            if (mcpServers.length > 0) {
              await options.runtime.configureSessionMcpServers(
                result.session.sessionId,
                mcpServers,
              );
              assertLifecycleActive(mutationSignal);
            }
          });
          const control = await getTuiAcpSessionControlState(options.runtime, result.session);
          assertLifecycleActive(requestSignal);
          const active = {
            session: result.session,
            mcpServers,
            coordinator: new TuiRunCoordinator(options.runtime),
            attachmentController: new AbortController(),
          };
          if (existing) {
            existing.attachmentController.abort(new Error('ACP Session attachment replaced.'));
            retireAttachmentPlans(result.session.sessionId, existing, context.client);
          }
          sessions.set(result.session.sessionId, active);
          advertiseAvailableCommands(context.client, result.session.sessionId);
          return { sessionId: result.session.sessionId, ...control };
        } catch (error) {
          if (!existing) {
            try {
              await options.runtime.deleteSession(result.session.sessionId);
            } catch {
              throw acp.RequestError.internalError(
                undefined,
                `Failed to complete forked Session ${result.session.sessionId}, and cleanup failed.`,
              );
            }
            throw error;
          }
          if (existingOverlayTouched) {
            const detached = detachAttachment(
              result.session.sessionId,
              existing,
              'ACP fork initialization invalidated a concurrent attachment.',
              context.client,
            );
            if (detached) {
              void runSessionMcpMutation(result.session.sessionId, async () => {
                await options.runtime.clearSessionMcpServers(result.session.sessionId);
              }).catch(() => undefined);
            }
          }
          throw error;
        }
      });
    })();
    void operation.then(
      () => {
        activeForkOperations -= 1;
      },
      () => {
        activeForkOperations -= 1;
      },
    );
    return raceRequestWithCancellation(
      operation,
      context.signal,
      'ACP Session fork was cancelled while waiting for Runtime I/O.',
    );
  });

  app.onRequest(acp.methods.agent.session.load, async (context) => {
    return runSessionLifecycle(context.params.sessionId, async (signal) => {
      const requestSignal = AbortSignal.any([signal, context.signal]);
      let active: AcpSession | undefined;
      let overlayAttachment: AcpSession | undefined;
      let overlayMutationStarted = false;
      let runtimeSessionId = context.params.sessionId;
      let cleanupQueued = false;
      const invalidateAttachment = (reason: string, cleanupStartedOverlay = false) => {
        if (cleanupQueued) return;
        const current = sessions.get(context.params.sessionId);
        const attachment =
          current === active ? active : current === overlayAttachment ? current : undefined;
        const detached = detachAttachment(
          context.params.sessionId,
          attachment,
          reason,
          context.client,
        );
        if (!detached && !(cleanupStartedOverlay && overlayMutationStarted)) return;
        cleanupQueued = true;
        void runSessionMcpMutation(context.params.sessionId, async () => {
          await options.runtime.clearSessionMcpServers(runtimeSessionId);
        }).catch(() => undefined);
      };
      const onAbort = () => invalidateAttachment('ACP Session load was cancelled.', true);
      requestSignal.addEventListener('abort', onAbort, { once: true });
      try {
        return await runSessionLifecycle.race(
          context.params.sessionId,
          async () => {
            active = await attachPersistedSession(
              context.params,
              requestSignal,
              context.client,
              (attachment, attachedRuntimeSessionId) => {
                overlayMutationStarted = true;
                overlayAttachment = attachment;
                runtimeSessionId = attachedRuntimeSessionId;
                if (requestSignal.aborted) onAbort();
              },
              (attachment) => {
                active = attachment;
                if (requestSignal.aborted) onAbort();
              },
            );
            runtimeSessionId = active.session.sessionId;
            const attachment = active;
            const messages = await loadCompleteHistory(
              options.runtime,
              attachment.session.sessionId,
              requestSignal,
            );
            assertLifecycleActive(requestSignal);
            await replayHistory(context.client, context.params.sessionId, messages, () =>
              isCurrentAttachment(sessions, context.params.sessionId, attachment, requestSignal),
            );
            assertLifecycleActive(requestSignal);
            advertiseAvailableCommands(context.client, context.params.sessionId);
            const control = await getTuiAcpSessionControlState(options.runtime, attachment.session);
            assertLifecycleActive(requestSignal);
            return control;
          },
          requestSignal,
        );
      } catch (error) {
        invalidateAttachment('ACP Session load failed.');
        throw error;
      } finally {
        requestSignal.removeEventListener('abort', onAbort);
      }
    });
  });

  app.onRequest(acp.methods.agent.session.resume, async (context) => {
    return runSessionLifecycle(context.params.sessionId, async (signal) => {
      const requestSignal = AbortSignal.any([signal, context.signal]);
      let active: AcpSession | undefined;
      let overlayAttachment: AcpSession | undefined;
      let overlayMutationStarted = false;
      let runtimeSessionId = context.params.sessionId;
      let cleanupQueued = false;
      const invalidateAttachment = (reason: string, cleanupStartedOverlay = false) => {
        if (cleanupQueued) return;
        const current = sessions.get(context.params.sessionId);
        const attachment =
          current === active ? active : current === overlayAttachment ? current : undefined;
        const detached = detachAttachment(
          context.params.sessionId,
          attachment,
          reason,
          context.client,
        );
        if (!detached && !(cleanupStartedOverlay && overlayMutationStarted)) return;
        cleanupQueued = true;
        void runSessionMcpMutation(context.params.sessionId, async () => {
          await options.runtime.clearSessionMcpServers(runtimeSessionId);
        }).catch(() => undefined);
      };
      const onAbort = () => invalidateAttachment('ACP Session resume was cancelled.', true);
      requestSignal.addEventListener('abort', onAbort, { once: true });
      try {
        return await runSessionLifecycle.race(
          context.params.sessionId,
          async () => {
            active = await attachPersistedSession(
              context.params,
              requestSignal,
              context.client,
              (attachment, attachedRuntimeSessionId) => {
                overlayMutationStarted = true;
                overlayAttachment = attachment;
                runtimeSessionId = attachedRuntimeSessionId;
                if (requestSignal.aborted) onAbort();
              },
              (attachment) => {
                active = attachment;
                if (requestSignal.aborted) onAbort();
              },
            );
            runtimeSessionId = active.session.sessionId;
            advertiseAvailableCommands(context.client, context.params.sessionId);
            const control = await getTuiAcpSessionControlState(options.runtime, active.session);
            assertLifecycleActive(requestSignal);
            return control;
          },
          requestSignal,
        );
      } catch (error) {
        invalidateAttachment('ACP Session resume failed.');
        throw error;
      } finally {
        requestSignal.removeEventListener('abort', onAbort);
      }
    });
  });

  app.onRequest(acp.methods.agent.session.close, async ({ params, client }) => {
    const reason = new Error('ACP Session attachment closed.');
    const hadLifecycleWork = runSessionLifecycle.reset(params.sessionId, reason);
    const active = sessions.get(params.sessionId);
    if (!active && !hadLifecycleWork) {
      throw acp.RequestError.resourceNotFound(params.sessionId);
    }
    promptCancelEpochs.delete(params.sessionId);
    promptCancelLatches.delete(params.sessionId);
    if (active) {
      active.attachmentController.abort(new Error('ACP Session attachment closed.'));
      active.activePrompt?.controller.abort(new Error('ACP session closed.'));
      void active.coordinator.abort().catch(() => false);
      if (sessions.get(params.sessionId) === active) sessions.delete(params.sessionId);
    }
    clearDetachedClientState(params.sessionId, client, active);
    if (active) {
      void runSessionMcpMutation(params.sessionId, async () => {
        await options.runtime.clearSessionMcpServers(active.session.sessionId);
      }).catch(() => undefined);
    }
    return {};
  });

  app.onRequest(acp.methods.agent.session.setMode, async ({ params }) => {
    return runSessionLifecycle(params.sessionId, async (signal) => {
      assertLifecycleActive(signal);
      const active = requireAttachedSession(sessions, params.sessionId);
      const refreshed = await options.runtime.getSession(active.session.sessionId);
      assertLifecycleActive(signal);
      active.session = refreshed;
      const state = await getTuiAcpSessionControlState(options.runtime, refreshed);
      assertLifecycleActive(signal);
      if (!state.modes.availableModes.some((mode) => mode.id === params.modeId)) {
        throw acp.RequestError.invalidParams(
          undefined,
          `Unsupported Session mode: ${params.modeId}`,
        );
      }
      const currentMode = state.modes.currentModeId;
      const activePromptTarget = active.activePrompt?.targetModeId;
      if (activePromptTarget && params.modeId !== activePromptTarget) {
        active.pendingModeIntent = params.modeId === ACP_MODE_PLAN ? 'plan-entry' : 'plan-exit';
      } else if (params.modeId === currentMode || params.modeId === activePromptTarget) {
        active.pendingModeIntent = undefined;
      } else {
        active.pendingModeIntent = params.modeId === ACP_MODE_PLAN ? 'plan-entry' : 'plan-exit';
      }
      return {
        _meta: {
          'minimax-code/transition': active.pendingModeIntent ? 'next_prompt' : 'settled',
        },
      };
    });
  });

  app.onRequest(acp.methods.agent.session.setConfigOption, async (context) => {
    return runSessionLifecycle(context.params.sessionId, async (signal) => {
      assertLifecycleActive(signal);
      const { params } = context;
      const active = requireAttachedSession(sessions, params.sessionId);
      if (typeof params.value !== 'string') {
        throw acp.RequestError.invalidParams(
          undefined,
          'MiniMax Code ACP configuration options are select controls.',
        );
      }

      if (params.configId === ACP_CONFIG_PERMISSION_MODE) {
        const permissionMode = parsePermissionMode(params.value);
        await runPermissionMutation('permission-mode', async (mutationSignal) => {
          assertLifecycleActive(signal);
          assertLifecycleActive(mutationSignal);
          await options.runtime.setPermissionMode(permissionMode);
        });
        schedulePermissionBroadcast(context.client, [...sessions.entries()]);
        assertLifecycleActive(signal);
      } else if (params.configId === ACP_CONFIG_MODEL) {
        let selection;
        try {
          selection = parseModelConfigValue(params.value);
        } catch (error) {
          throw acp.RequestError.invalidParams(
            undefined,
            error instanceof Error ? error.message : 'Invalid model selection.',
          );
        }
        await runSessionConfigMutation(params.sessionId, async (mutationSignal) => {
          assertLifecycleActive(signal);
          assertLifecycleActive(mutationSignal);
          const models = await options.runtime.listModels(active.session.sessionId);
          assertLifecycleActive(signal);
          if (!isAdvertisedModelSelection(models, selection)) {
            throw acp.RequestError.invalidParams(undefined, 'Model selection is not advertised.');
          }
          if (!(await options.runtime.selectSessionModel(selection, active.session.sessionId))) {
            throw acp.RequestError.invalidParams(
              undefined,
              'Runtime rejected the model selection.',
            );
          }
        });
        assertLifecycleActive(signal);
      } else if (params.configId === ACP_CONFIG_THINKING_EFFORT) {
        await runSessionConfigMutation(params.sessionId, async (mutationSignal) => {
          assertLifecycleActive(signal);
          assertLifecycleActive(mutationSignal);
          const session = await options.runtime.getSession(active.session.sessionId);
          assertLifecycleActive(signal);
          if (!session.model?.providerId || !session.model.modelId) {
            throw acp.RequestError.invalidParams(
              undefined,
              'Select a Session model before changing thinking effort.',
            );
          }
          const models = await options.runtime.listModels(session.sessionId);
          assertLifecycleActive(signal);
          const selectedModel = models.find(
            (model) =>
              model.providerId === session.model?.providerId &&
              model.modelId === session.model.modelId &&
              modelSupportsVariant(model, session.model.variant),
          );
          if (!selectedModel?.effortOptions?.includes(params.value)) {
            throw acp.RequestError.invalidParams(
              undefined,
              `Thinking effort is not advertised for the selected model: ${params.value}`,
            );
          }
          if (
            !(await options.runtime.selectSessionModel(
              {
                providerId: session.model.providerId,
                modelId: session.model.modelId,
                ...(session.model.variant !== undefined ? { variant: session.model.variant } : {}),
                thinking: { effort: params.value },
              },
              session.sessionId,
            ))
          ) {
            throw acp.RequestError.invalidParams(undefined, 'Runtime rejected thinking effort.');
          }
        });
        assertLifecycleActive(signal);
      } else {
        throw acp.RequestError.invalidParams(
          undefined,
          `Unsupported Session configuration option: ${params.configId}`,
        );
      }

      active.session = await options.runtime.getSession(active.session.sessionId);
      assertLifecycleActive(signal);
      const control = await getTuiAcpSessionControlState(options.runtime, active.session);
      assertLifecycleActive(signal);
      if (params.configId !== ACP_CONFIG_PERMISSION_MODE) {
        await context.client.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'config_option_update',
            configOptions: control.configOptions,
          },
        });
      }
      return { configOptions: control.configOptions };
    });
  });

  app.onRequest(acp.methods.agent.session.prompt, async (context) => {
    if (promptCancelLatches.delete(context.params.sessionId)) {
      return { stopReason: 'cancelled' };
    }
    const admissionCancelEpoch = promptCancelEpochs.get(context.params.sessionId) ?? 0;
    const admission = await runSessionLifecycle(context.params.sessionId, async (signal) => {
      const isCancelled = () =>
        signal.aborted ||
        context.signal.aborted ||
        (promptCancelEpochs.get(context.params.sessionId) ?? 0) !== admissionCancelEpoch;
      if (isCancelled()) return { cancelled: true as const };
      const active = sessions.get(context.params.sessionId);
      if (!active) {
        throw acp.RequestError.resourceNotFound(context.params.sessionId);
      }
      if (active.activePrompt) {
        throw acp.RequestError.invalidParams(
          undefined,
          'A prompt is already active for this session.',
        );
      }

      const command = await executeTuiAcpCommand({
        runtime: options.runtime,
        sessionId: active.session.sessionId,
        agentName: active.session.agentName,
        workspaceDir: active.session.workspaceDir,
        prompt: context.params.prompt,
      });
      if (isCancelled()) return { cancelled: true as const };
      if (command.handled) {
        await context.client.notify(acp.methods.client.session.update, {
          sessionId: context.params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: command.output },
          },
        });
        return { handled: true as const };
      }

      const submittedModeIntent = active.pendingModeIntent;
      const previousMode =
        active.session.interactionMode === 'plan' ? ACP_MODE_PLAN : ACP_MODE_DEFAULT;
      const turnId = createTurnId();
      const promptController = new AbortController();
      const activePrompt: NonNullable<AcpSession['activePrompt']> = {
        controller: promptController,
        continuation: new TuiAcpPromptContinuation(active.session.sessionId, turnId),
        targetModeId:
          submittedModeIntent === 'plan-entry'
            ? ACP_MODE_PLAN
            : submittedModeIntent === 'plan-exit'
              ? ACP_MODE_DEFAULT
              : previousMode,
      };
      active.activePrompt = activePrompt;
      return {
        handled: false as const,
        active,
        activePrompt,
        previousMode,
        promptController,
        submittedModeIntent,
        turnId,
      };
    });
    if ('cancelled' in admission) {
      return { stopReason: 'cancelled' };
    }
    if (admission.handled) {
      return { stopReason: 'end_turn' };
    }

    const { active, activePrompt, previousMode, promptController, submittedModeIntent, turnId } =
      admission;
    let modeIntentAccepted = false;
    const cancel = () => {
      promptController.abort(context.signal.reason);
      void active.coordinator.abort();
    };
    context.signal.addEventListener('abort', cancel, { once: true });
    if (context.signal.aborted) cancel();
    const pendingUpdates: Promise<void>[] = [];
    const projector = new TuiAcpUpdateProjector();
    const onSessionEvent = (event: TuiStreamEvent) => {
      for (const update of projector.project(event)) {
        pendingUpdates.push(
          context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update,
          }),
        );
      }
    };

    try {
      if (promptController.signal.aborted) return { stopReason: 'cancelled' };
      const result = await executeTuiInteractiveTurn({
        request: {
          turnId,
          session: Promise.resolve(active.session),
          content: promptToText(context.params.prompt),
          workspace: active.session.workspaceDir ?? process.cwd(),
          version: options.version,
          ...(submittedModeIntent ? { clientIntent: submittedModeIntent } : {}),
        },
        coordinator: active.coordinator,
        isActive: () =>
          !promptController.signal.aborted &&
          sessions.get(context.params.sessionId) === active &&
          active.activePrompt === activePrompt,
        onSessionEvent,
        onRunAccepted: () => {
          modeIntentAccepted = true;
          if (!promptController.signal.aborted && active.activePrompt === activePrompt) {
            activePrompt.steerableTurnId = turnId;
          }
        },
      });
      activePrompt.steerableTurnId = undefined;
      if (isQuestionnaireContinuation(result)) {
        const stopReason = await followQuestionnaireContinuations({
          runtime: options.runtime,
          sessionId: active.session.sessionId,
          initialTurnId: turnId,
          signal: promptController.signal,
          continuation: activePrompt.continuation,
          onSessionEvent,
          onSteerableTurnChange: (continuationTurnId) => {
            if (!promptController.signal.aborted && active.activePrompt === activePrompt) {
              activePrompt.steerableTurnId = continuationTurnId;
            }
          },
        });
        await Promise.all(pendingUpdates);
        return { stopReason };
      }
      await Promise.all(pendingUpdates);
      if (result.status === 'succeeded') return { stopReason: 'end_turn' };
      if (result.status === 'cancelled') return { stopReason: 'cancelled' };
      if (result.status === 'limit_exceeded') return { stopReason: 'max_turn_requests' };
      throw acp.RequestError.internalError(
        undefined,
        result.error
          ? `MiniMax Code Runtime failed: ${result.error}`
          : 'MiniMax Code Runtime failed.',
      );
    } finally {
      context.signal.removeEventListener('abort', cancel);
      if (active.activePrompt === activePrompt) active.activePrompt = undefined;
      if (modeIntentAccepted && active.pendingModeIntent === submittedModeIntent) {
        active.pendingModeIntent = undefined;
      }
      try {
        const refreshed = await options.runtime.getSession(active.session.sessionId);
        const isCurrent = () => sessions.get(context.params.sessionId) === active;
        if (isCurrent()) active.session = refreshed;
        const currentMode = refreshed.interactionMode === 'plan' ? ACP_MODE_PLAN : ACP_MODE_DEFAULT;
        if (isCurrent() && currentMode !== previousMode) {
          await context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update: { sessionUpdate: 'current_mode_update', currentModeId: currentMode },
          });
        }
        await notifyUsageUpdate(
          options.runtime,
          context.client,
          context.params.sessionId,
          active.session.sessionId,
          isCurrent,
        );
      } catch {
        // Control-plane refresh is fail-open after the Prompt has already settled.
      }
    }
  });

  app.onNotification(acp.methods.agent.session.cancel, async ({ params }) => {
    const active = sessions.get(params.sessionId);
    if (!active && !runSessionLifecycle.has(params.sessionId)) return;
    promptCancelEpochs.set(params.sessionId, (promptCancelEpochs.get(params.sessionId) ?? 0) + 1);
    if (!active?.activePrompt) {
      promptCancelLatches.add(params.sessionId);
      const clear = setImmediate(() => promptCancelLatches.delete(params.sessionId));
      clear.unref();
      return;
    }
    active.activePrompt.controller.abort(new Error('ACP session cancelled.'));
    await active.coordinator.abort();
  });

  return app;
}

function createRuntimeControlProjections(options: {
  readonly runtime: TuiAcpRuntime;
  readonly client: acp.AgentContext;
  readonly clientCapabilities: acp.ClientCapabilities;
  readonly sessions: Map<string, AcpSession>;
  readonly activePlans: Map<
    string,
    { readonly delivered: Promise<boolean>; readonly attachment: AcpSession }
  >;
  readonly planAttachments: Map<string, AcpSession>;
  readonly runtimeParentSessionIds: ReadonlyMap<string, string>;
  readonly event: TuiRuntimeEvent;
}): readonly TuiAcpRuntimeProjection[] {
  const projections: TuiAcpRuntimeProjection[] = [];
  const resolved = resolveAttachedRuntimeSession(options.sessions, options.event.sessionId);
  if (resolved) {
    const [acpSessionId, active] = resolved;
    if (options.event.type === 'session.title_updated' || isSessionActivityEvent(options.event)) {
      const event = options.event;
      projections.push({
        key:
          event.type === 'session.title_updated'
            ? `${acpSessionId}\0session-title`
            : `${acpSessionId}\0session-activity`,
        run: async (signal) => {
          if (!isCurrentAttachment(options.sessions, acpSessionId, active, signal)) return;
          if (event.type === 'session.title_updated') {
            active.session = { ...active.session, title: event.title };
          }
          await options.client.notify(acp.methods.client.session.update, {
            sessionId: acpSessionId,
            update: {
              sessionUpdate: 'session_info_update',
              ...(event.type === 'session.title_updated' ? { title: event.title } : {}),
              updatedAt: new Date(event.timestampMs).toISOString(),
            },
          });
        },
      });
    }
    if (shouldRefreshMode(options.event)) {
      projections.push({
        key: `${acpSessionId}\0session-state`,
        run: (signal) =>
          refreshAttachedMode(options.runtime, options.client, acpSessionId, active, () =>
            isCurrentAttachment(options.sessions, acpSessionId, active, signal),
          ),
      });
    }
    if (
      options.event.type === 'session.finish' ||
      options.event.type === 'session.compaction.completed'
    ) {
      const runtimeSessionId = active.session.sessionId;
      projections.push({
        key: `${acpSessionId}\0usage`,
        run: (signal) =>
          notifyUsageUpdate(options.runtime, options.client, acpSessionId, runtimeSessionId, () =>
            isCurrentAttachment(options.sessions, acpSessionId, active, signal),
          ),
      });
    }
  }

  if (
    options.clientCapabilities.plan &&
    options.event.type === 'questionnaire.ask' &&
    options.event.request.mode === 'plan' &&
    options.event.request.modePayload?.planReview
  ) {
    const planResolved = resolveOwnedRuntimeSession(
      options.sessions,
      options.runtimeParentSessionIds,
      options.event.request.requester?.sessionId ?? options.event.sessionId,
    );
    if (planResolved) {
      const [sessionId, attachment] = planResolved;
      const planId = options.event.request.id;
      const key = planKey(sessionId, planId);
      const markdown = options.event.request.modePayload.planReview.markdown;
      options.planAttachments.set(key, attachment);
      projections.push({
        key: planProjectionKey(sessionId, planId),
        run: async (signal) => {
          if (
            !isCurrentAttachment(options.sessions, sessionId, attachment, signal) ||
            options.planAttachments.get(key) !== attachment
          ) {
            return;
          }
          const record = {
            attachment,
            delivered: options.client
              .notify(acp.methods.client.session.update, {
                sessionId,
                update: {
                  sessionUpdate: 'plan_update',
                  plan: { type: 'markdown', planId, content: markdown },
                },
              })
              .then(
                () => true,
                () => false,
              ),
          };
          options.activePlans.set(key, record);
          if (!(await record.delivered) && options.activePlans.get(key) === record) {
            options.activePlans.delete(key);
          }
        },
      });
    }
  }

  if (!supportsTuiAcpExtensionNotifications(options.clientCapabilities)) return projections;
  if (resolved && options.event.type === 'session.queue.updated') {
    const [acpSessionId, active] = resolved;
    const runtimeSessionId = active.session.sessionId;
    projections.push({
      key: `${acpSessionId}\0queue`,
      run: async (signal) => {
        const isCurrent = () => isCurrentAttachment(options.sessions, acpSessionId, active, signal);
        if (!isCurrent()) return;
        const items = await options.runtime.listQueuedMessages(runtimeSessionId);
        if (!isCurrent()) return;
        await options.client.notify('mcode/session/queue_update', {
          sessionId: acpSessionId,
          items,
        });
      },
    });
  }
  const goalEnabled = options.runtime.isGoalEnabled();
  if (goalEnabled && resolved && options.event.type === 'thread_goal.updated') {
    const [acpSessionId, active] = resolved;
    const goal = options.event.goal;
    projections.push({
      key: `${acpSessionId}\0goal`,
      run: async (signal) => {
        if (!isCurrentAttachment(options.sessions, acpSessionId, active, signal)) return;
        await options.client.notify('mcode/session/goal_update', {
          sessionId: acpSessionId,
          goal,
        });
      },
    });
  }
  if (goalEnabled && resolved && options.event.type === 'thread_goal.cleared') {
    const [acpSessionId, active] = resolved;
    const goalId = options.event.goalId;
    projections.push({
      key: `${acpSessionId}\0goal`,
      run: async (signal) => {
        if (!isCurrentAttachment(options.sessions, acpSessionId, active, signal)) return;
        await options.client.notify('mcode/session/goal_update', {
          sessionId: acpSessionId,
          goal: null,
          goalId,
        });
      },
    });
  }
  if (isDelegationRefreshEvent(options.event)) {
    const attachments = [...options.sessions.entries()];
    projections.push({
      key: 'delegation',
      run: (signal) =>
        notifyDelegationUpdates(
          options.runtime,
          options.client,
          options.sessions,
          attachments,
          signal,
        ),
    });
  }
  return projections;
}

function planKey(sessionId: string, planId: string): string {
  return `${sessionId}\0${planId}`;
}

function planProjectionKey(sessionId: string, planId: string): string {
  return `${sessionId}\0plan\0${planId}`;
}

async function notifyDelegationUpdates(
  runtime: TuiAcpRuntime,
  client: acp.AgentContext,
  sessions: ReadonlyMap<string, AcpSession>,
  attachments: readonly (readonly [string, AcpSession])[],
  signal: AbortSignal,
): Promise<void> {
  const snapshots = new Map<string, Awaited<ReturnType<TuiAcpRuntime['getDelegationSnapshot']>>>();
  for (const [acpSessionId, active] of attachments) {
    const isCurrent = () => !signal.aborted && sessions.get(acpSessionId) === active;
    if (!isCurrent()) continue;
    const rootSessionId = await resolveRootSessionId(runtime, active.session);
    if (!isCurrent()) continue;
    let snapshot = snapshots.get(rootSessionId);
    if (!snapshot) {
      snapshot = await runtime.getDelegationSnapshot(rootSessionId);
      snapshots.set(rootSessionId, snapshot);
    }
    if (!isCurrent()) continue;
    await client.notify('mcode/session/delegation_update', {
      sessionId: acpSessionId,
      snapshot,
    });
  }
}

async function notifyPermissionConfigUpdates(
  runtime: TuiAcpRuntime,
  client: acp.AgentContext,
  sessions: ReadonlyMap<string, AcpSession>,
  attachments: readonly (readonly [string, AcpSession])[],
  timeoutMs: number,
): Promise<void> {
  for (const [sessionId, attached] of attachments) {
    if (sessions.get(sessionId) !== attached) continue;
    await notifyWithDeadline(
      (async () => {
        if (sessions.get(sessionId) !== attached) return;
        const control = await getTuiAcpSessionControlState(runtime, attached.session);
        if (sessions.get(sessionId) !== attached) return;
        await client.notify(acp.methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: 'config_option_update',
            configOptions: control.configOptions,
          },
        });
      })(),
      timeoutMs,
    );
  }
}

async function notifyWithDeadline(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('ACP required notification delivery timed out.')),
          Math.max(0, timeoutMs),
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function refreshAttachedMode(
  runtime: TuiAcpRuntime,
  client: acp.AgentContext,
  acpSessionId: string,
  active: AcpSession,
  isCurrent: () => boolean,
): Promise<void> {
  if (!isCurrent()) return;
  const previous = active.session.interactionMode === 'plan' ? ACP_MODE_PLAN : ACP_MODE_DEFAULT;
  const session = await runtime.getSession(active.session.sessionId);
  if (!isCurrent()) return;
  active.session = { ...active.session, interactionMode: session.interactionMode };
  const current = session.interactionMode === 'plan' ? ACP_MODE_PLAN : ACP_MODE_DEFAULT;
  if (current === previous) return;
  if (!isCurrent()) return;
  await client.notify(acp.methods.client.session.update, {
    sessionId: acpSessionId,
    update: { sessionUpdate: 'current_mode_update', currentModeId: current },
  });
}

async function notifyUsageUpdate(
  runtime: TuiAcpRuntime,
  client: acp.AgentContext,
  acpSessionId: string,
  runtimeSessionId: string,
  isCurrent: () => boolean,
): Promise<void> {
  if (!isCurrent()) return;
  const snapshot = await runtime.getContextSnapshot(runtimeSessionId);
  if (!isCurrent()) return;
  const usage = await runtime.getSessionUsage(runtimeSessionId);
  if (!isCurrent()) return;
  const update = usageUpdate(snapshot, usage);
  if (!update) return;
  if (!isCurrent()) return;
  await client.notify(acp.methods.client.session.update, {
    sessionId: acpSessionId,
    update: { sessionUpdate: 'usage_update', ...update },
  });
}

function resolveAttachedRuntimeSession(
  sessions: ReadonlyMap<string, AcpSession>,
  runtimeSessionId: string | undefined,
): [string, AcpSession] | undefined {
  if (!runtimeSessionId) return undefined;
  for (const entry of sessions) {
    if (entry[1].session.sessionId === runtimeSessionId) return entry;
  }
  return undefined;
}

function resolveOwnedRuntimeSession(
  sessions: ReadonlyMap<string, AcpSession>,
  runtimeParentSessionIds: ReadonlyMap<string, string>,
  runtimeSessionId: string | undefined,
): [string, AcpSession] | undefined {
  const visited = new Set<string>();
  let current = runtimeSessionId;
  while (current && !visited.has(current)) {
    visited.add(current);
    const resolved = resolveAttachedRuntimeSession(sessions, current);
    if (resolved) return resolved;
    current = runtimeParentSessionIds.get(current);
  }
  return undefined;
}

async function hydrateRuntimeAncestry(
  runtime: TuiAcpRuntime,
  runtimeParentSessionIds: Map<string, string>,
  rootSessionId: string,
  signal: AbortSignal,
): Promise<void> {
  const snapshot = await runtime.getDelegationSnapshot(rootSessionId);
  assertLifecycleActive(signal);
  const staleDescendants = [...runtimeParentSessionIds.keys()].filter((sessionId) =>
    hasRuntimeAncestor(runtimeParentSessionIds, sessionId, rootSessionId),
  );
  for (const sessionId of staleDescendants) runtimeParentSessionIds.delete(sessionId);
  for (const member of snapshot.members) {
    runtimeParentSessionIds.set(member.sessionId, member.parentSessionId);
  }
}

function hasRuntimeAncestor(
  runtimeParentSessionIds: ReadonlyMap<string, string>,
  sessionId: string,
  ancestorSessionId: string,
): boolean {
  const visited = new Set<string>();
  let current: string | undefined = sessionId;
  while (current && !visited.has(current)) {
    if (current === ancestorSessionId) return true;
    visited.add(current);
    current = runtimeParentSessionIds.get(current);
  }
  return false;
}

function isCurrentAttachment(
  sessions: ReadonlyMap<string, AcpSession>,
  acpSessionId: string,
  active: AcpSession,
  signal: AbortSignal,
): boolean {
  return !signal.aborted && sessions.get(acpSessionId) === active;
}

function requireAttachedSession(
  sessions: ReadonlyMap<string, AcpSession>,
  sessionId: string,
): AcpSession {
  const active = sessions.get(sessionId);
  if (!active) throw acp.RequestError.resourceNotFound(sessionId);
  return active;
}

function parsePermissionMode(value: string): TuiPermissionMode {
  if (value === 'default' || value === 'auto' || value === 'bypassPermissions') return value;
  throw acp.RequestError.invalidParams(undefined, `Unsupported permission mode: ${value}`);
}

function isAdvertisedModelSelection(
  models: readonly TuiModel[],
  selection: { readonly providerId: string; readonly modelId: string; readonly variant?: string },
): boolean {
  return models.some(
    (model) =>
      model.providerId === selection.providerId &&
      model.modelId === selection.modelId &&
      modelSupportsVariant(model, selection.variant),
  );
}

function isSessionActivityEvent(event: TuiRuntimeEvent): boolean {
  return (
    event.type === 'session.start' ||
    event.type === 'session.finish' ||
    event.type === 'session.error' ||
    event.type === 'session.abort' ||
    event.type === 'session.queue.updated' ||
    event.type === 'session.compaction.completed'
  );
}

function shouldRefreshMode(event: TuiRuntimeEvent): boolean {
  return (
    event.type === 'session.start' ||
    event.type === 'session.finish' ||
    event.type === 'session.abort' ||
    event.type === 'questionnaire.ask' ||
    event.type === 'questionnaire.dismiss' ||
    event.type === 'questionnaire.superseded'
  );
}

function isDelegationRefreshEvent(event: TuiRuntimeEvent): boolean {
  return (
    event.type === 'session.created' ||
    event.type === 'session.start' ||
    event.type === 'session.finish' ||
    event.type === 'session.error' ||
    event.type === 'session.abort' ||
    event.type === 'session.active_run.action' ||
    event.type === 'permission.ask' ||
    event.type === 'permission.resolved' ||
    event.type === 'questionnaire.ask' ||
    event.type === 'questionnaire.dismiss' ||
    event.type === 'questionnaire.superseded'
  );
}

function assertNoAdditionalDirectories(directories: readonly string[] | undefined): void {
  if (!directories?.length) return;
  throw acp.RequestError.invalidParams(
    undefined,
    'Additional directories are not supported by MiniMax Code ACP.',
  );
}

async function getPersistedSession(runtime: TuiAcpRuntime, sessionId: string): Promise<TuiSession> {
  try {
    return await runtime.getSession(sessionId);
  } catch {
    throw acp.RequestError.resourceNotFound(sessionId);
  }
}

function assertMatchingCwd(session: TuiSession, requestedCwd: string): void {
  const storedCwd = session.workspaceDir;
  if (
    !isAbsolute(requestedCwd) ||
    !storedCwd ||
    normalizeComparablePath(storedCwd) !== normalizeComparablePath(requestedCwd)
  ) {
    throw acp.RequestError.invalidParams(
      undefined,
      `Requested cwd does not match the persisted session workspace: ${requestedCwd}.`,
    );
  }
}

function assertAcpSessionUsable(session: TuiSession): void {
  if (!isTuiInternalSubagentSession(session)) return;
  throw acp.RequestError.invalidParams(
    undefined,
    'Sub-agent Sessions are internal and cannot be opened.',
  );
}

function normalizeComparablePath(value: string): string {
  const normalized = resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function toAcpSessionInfo(session: TuiSession): acp.SessionInfo[] {
  if (isTuiInternalSubagentSession(session)) return [];
  const cwd = session.workspaceDir;
  if (!cwd || !isAbsolute(cwd)) return [];
  const updatedAt = toIsoTimestamp(session.updatedAt);
  return [
    {
      sessionId: session.sessionId,
      cwd,
      ...(session.title ? { title: session.title } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    },
  ];
}

function toIsoTimestamp(value: number | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const numeric = typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  const timestamp =
    typeof value === 'number' ? value : Number.isFinite(numeric) ? numeric : Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return new Date(timestamp).toISOString();
}

async function loadCompleteHistory(
  runtime: TuiAcpRuntime,
  sessionId: string,
  signal: AbortSignal,
): Promise<TuiMessage[]> {
  const pages: TuiMessage[][] = [];
  const seenCursors = new Set<string>();
  let before: string | undefined;
  for (;;) {
    assertLifecycleActive(signal);
    const page = await runtime.listMessagePage(sessionId, {
      limit: ACP_HISTORY_PAGE_SIZE,
      ...(before ? { before } : {}),
    });
    assertLifecycleActive(signal);
    pages.unshift(page.messages);
    if (!page.hasMore || !page.nextCursor || seenCursors.has(page.nextCursor)) break;
    seenCursors.add(page.nextCursor);
    before = page.nextCursor;
  }
  return pages.flat();
}

async function replayHistory(
  client: acp.AgentContext,
  sessionId: string,
  messages: readonly TuiMessage[],
  isCurrent: () => boolean,
): Promise<void> {
  const projector = new TuiAcpUpdateProjector();
  for (const message of messages) {
    const updates =
      message.role === 'user'
        ? buildTuiMessageParts(message).flatMap((part): acp.SessionUpdate[] =>
            part.type === 'text'
              ? [
                  {
                    sessionUpdate: 'user_message_chunk',
                    ...(message.id ? { messageId: message.id } : {}),
                    content: { type: 'text', text: part.content },
                  },
                ]
              : [],
          )
        : projector.project({ type: 'message', message });
    for (const update of updates) {
      assertReplayCurrent(isCurrent);
      await client.notify(acp.methods.client.session.update, { sessionId, update });
      assertReplayCurrent(isCurrent);
    }
  }
}

function assertReplayCurrent(isCurrent: () => boolean): void {
  if (!isCurrent()) {
    throw acp.RequestError.requestCancelled(undefined, 'ACP Session history replay was cancelled.');
  }
}

function mapClientMcpServers(servers: readonly acp.McpServer[]): readonly TuiSessionMcpServer[] {
  return servers.map((server) => {
    if ('command' in server) {
      return {
        name: server.name,
        type: 'stdio',
        command: server.command,
        args: [...server.args],
        ...(server.env.length > 0
          ? { env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])) }
          : {}),
      };
    }
    if (server.type === 'http' || server.type === 'sse') {
      return {
        name: server.name,
        type: server.type,
        url: server.url,
        ...(server.headers.length > 0
          ? { headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])) }
          : {}),
      };
    }
    throw acp.RequestError.invalidParams(
      undefined,
      `Unsupported client MCP transport: ${server.type}.`,
    );
  });
}

interface KeyedSerialExecutor {
  <T>(key: string, task: (signal: AbortSignal) => Promise<T>): Promise<T>;
  reserved<T>(key: string, task: (signal: AbortSignal) => Promise<T>): Promise<T>;
  race<T>(key: string, task: () => Promise<T>, signal: AbortSignal): Promise<T>;
  abort(key: string, reason: Error): boolean;
  reset(key: string, reason: Error): boolean;
  has(key: string): boolean;
}

function createKeyedSerialExecutor(): KeyedSerialExecutor {
  const tails = new Map<string, Promise<void>>();
  const controllers = new Map<string, Set<AbortController>>();
  const detachedGenerations = new Map<string, number>();
  let detachedGenerationCount = 0;
  const admittedByKey = new Map<string, number>();
  let admittedCount = 0;
  const canDetach = (key: string) =>
    (detachedGenerations.get(key) ?? 0) < MAX_DETACHED_LIFECYCLES_PER_SESSION &&
    detachedGenerationCount < MAX_DETACHED_LIFECYCLES_TOTAL;
  const releaseDetached = (key: string) => {
    const remaining = (detachedGenerations.get(key) ?? 1) - 1;
    if (remaining > 0) detachedGenerations.set(key, remaining);
    else detachedGenerations.delete(key);
    detachedGenerationCount -= 1;
  };
  const trackDetached = (key: string, operation: Promise<unknown>) => {
    detachedGenerations.set(key, (detachedGenerations.get(key) ?? 0) + 1);
    detachedGenerationCount += 1;
    void operation.then(
      () => releaseDetached(key),
      () => releaseDetached(key),
    );
  };
  const execute = async <T>(
    key: string,
    task: (signal: AbortSignal) => Promise<T>,
    reserved: boolean,
  ): Promise<T> => {
    if (!reserved) {
      if (
        (detachedGenerations.get(key) ?? 0) >= MAX_DETACHED_LIFECYCLES_PER_SESSION ||
        detachedGenerationCount >= MAX_DETACHED_LIFECYCLES_TOTAL
      ) {
        throw acp.RequestError.requestCancelled(
          undefined,
          'Too many cancelled ACP Session operations are still waiting for Runtime I/O.',
        );
      }
      if (
        (admittedByKey.get(key) ?? 0) >= MAX_ADMITTED_LIFECYCLES_PER_SESSION ||
        admittedCount >= MAX_ADMITTED_LIFECYCLES_TOTAL
      ) {
        throw acp.RequestError.requestCancelled(
          undefined,
          'Too many ACP Session operations are already waiting for admission.',
        );
      }
    }
    admittedByKey.set(key, (admittedByKey.get(key) ?? 0) + 1);
    admittedCount += 1;
    const previous = tails.get(key);
    const controller = new AbortController();
    const keyedControllers = controllers.get(key) ?? new Set<AbortController>();
    keyedControllers.add(controller);
    controllers.set(key, keyedControllers);
    let release!: () => void;
    const current = new Promise<void>((complete) => {
      release = complete;
    });
    tails.set(key, current);
    try {
      await previous;
      return await task(controller.signal);
    } finally {
      release();
      keyedControllers.delete(controller);
      if (keyedControllers.size === 0 && controllers.get(key) === keyedControllers) {
        controllers.delete(key);
      }
      if (tails.get(key) === current) tails.delete(key);
      const remainingAdmitted = (admittedByKey.get(key) ?? 1) - 1;
      if (remainingAdmitted > 0) admittedByKey.set(key, remainingAdmitted);
      else admittedByKey.delete(key);
      admittedCount -= 1;
    }
  };
  const run = (<T>(key: string, task: (signal: AbortSignal) => Promise<T>) =>
    execute(key, task, false)) as KeyedSerialExecutor;
  run.reserved = <T>(key: string, task: (signal: AbortSignal) => Promise<T>) =>
    execute(key, task, true);
  run.abort = (key: string, reason: Error) => {
    const keyedControllers = controllers.get(key);
    if (!keyedControllers) return false;
    for (const controller of keyedControllers) controller.abort(reason);
    return true;
  };
  run.race = async <T>(key: string, task: () => Promise<T>, signal: AbortSignal) => {
    assertLifecycleActive(signal);
    const operation = Promise.resolve().then(task);
    const settled = operation.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    let onAbort!: () => void;
    const aborted = new Promise<{ status: 'aborted' }>((resolveAbort) => {
      onAbort = () => resolveAbort({ status: 'aborted' });
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try {
      const outcome = await Promise.race([settled, aborted]);
      if (outcome.status === 'fulfilled') return outcome.value;
      if (outcome.status === 'rejected') throw outcome.error;
      if (canDetach(key)) trackDetached(key, operation);
      else await settled;
      throw acp.RequestError.requestCancelled(
        undefined,
        'ACP Session operation was cancelled while waiting for Runtime I/O.',
      );
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  };
  run.reset = (key: string, reason: Error) => {
    const detachedTail = tails.get(key);
    const hadWork = detachedTail !== undefined || controllers.has(key);
    run.abort(key, reason);
    tails.delete(key);
    controllers.delete(key);
    if (detachedTail) trackDetached(key, detachedTail);
    return hadWork;
  };
  run.has = (key: string) => tails.has(key) || controllers.has(key);
  return run;
}

function assertLifecycleActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw acp.RequestError.requestCancelled(undefined, 'ACP Session operation was cancelled.');
  }
}

async function raceRequestWithCancellation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  message: string,
): Promise<T> {
  assertLifecycleActive(signal);
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(acp.RequestError.requestCancelled(undefined, message));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function deleteActivePlansForSession(
  activePlans: Map<
    string,
    { readonly delivered: Promise<boolean>; readonly attachment: AcpSession }
  >,
  sessionId: string,
): void {
  const prefix = `${sessionId}\0`;
  for (const key of activePlans.keys()) {
    if (key.startsWith(prefix)) activePlans.delete(key);
  }
}

function deletePlanAttachmentsForSession(
  planAttachments: Map<string, AcpSession>,
  sessionId: string,
): void {
  const prefix = `${sessionId}\0`;
  for (const key of planAttachments.keys()) {
    if (key.startsWith(prefix)) planAttachments.delete(key);
  }
}

async function followQuestionnaireContinuations(options: {
  readonly runtime: TuiAcpRuntime;
  readonly sessionId: string;
  readonly initialTurnId: string;
  readonly signal: AbortSignal;
  readonly continuation: TuiAcpPromptContinuation;
  readonly onSessionEvent: (event: TuiStreamEvent) => void;
  readonly onSteerableTurnChange: (turnId: string | undefined) => void;
}): Promise<'end_turn' | 'cancelled'> {
  let turnId = options.initialTurnId;
  let requireQuestion = true;
  try {
    while (!options.signal.aborted) {
      const transition = await options.continuation.waitForTransition(turnId, options.signal, {
        requireQuestion,
      });
      requireQuestion = false;
      if (transition.kind === 'end') return 'end_turn';
      if (transition.kind === 'cancelled') return 'cancelled';
      if (transition.kind === 'failed') {
        throw acp.RequestError.internalError(
          undefined,
          transition.message
            ? `MiniMax Code Runtime continuation failed: ${transition.message}`
            : 'MiniMax Code Runtime continuation failed.',
        );
      }

      turnId = transition.turnId;
      options.onSteerableTurnChange(turnId);
      try {
        for await (const event of options.runtime.watchSessionTurn(
          options.sessionId,
          turnId,
          options.signal,
        )) {
          options.onSessionEvent(event);
          if (isSessionTurnTerminal(event)) break;
        }
      } finally {
        options.onSteerableTurnChange(undefined);
      }
    }
    return 'cancelled';
  } catch (error) {
    if (options.signal.aborted) return 'cancelled';
    if (error instanceof acp.RequestError) throw error;
    throw acp.RequestError.internalError(
      undefined,
      `MiniMax Code Runtime continuation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isQuestionnaireContinuation(result: TuiRunResult): boolean {
  if (result.status !== 'awaiting-user-continuation') return false;
  const error = result.outcome.error;
  return (
    error?.code === 'QUESTIONNAIRE_REQUIRED' ||
    error?.code === 'QUESTION_REQUIRED' ||
    error?.message.includes('Questionnaire requires user input') === true
  );
}

function isSessionTurnTerminal(event: TuiStreamEvent): boolean {
  if (event.type === 'done' || event.type === 'error') return true;
  return (
    event.type === 'session-status' &&
    (event.status === 'finished' ||
      event.status === 'error' ||
      event.status === 'aborted' ||
      event.status === 'interrupted')
  );
}

async function assertAuthenticated(runtime: TuiAcpRuntime): Promise<void> {
  try {
    await requireTuiAgentAccess(runtime);
  } catch (error) {
    if (error instanceof TuiLoginRequiredError) {
      throw acp.RequestError.authRequired(undefined, 'Run `mcode login` and try again.');
    }
    throw error;
  }
}

function promptToText(blocks: readonly acp.ContentBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === 'text') return block.text;
      if (block.type === 'resource_link') {
        return `Referenced resource: ${block.title ?? block.name} (${block.uri})`;
      }
      throw acp.RequestError.invalidParams(
        undefined,
        `Prompt content type ${block.type} is not supported in ACP P0.`,
      );
    })
    .join('\n\n');
}
