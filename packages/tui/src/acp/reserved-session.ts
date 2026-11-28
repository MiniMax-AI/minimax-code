import * as acp from '@agentclientprotocol/sdk';

import type {
  TuiModel,
  TuiModelSelection,
  TuiSession,
  TuiSessionMcpServer,
} from '../runtime/port.js';
import type { TuiAcpRuntime } from './runtime.js';

/**
 * session/new only reserves an ID. The Runtime Session is written by the first operation that
 * needs Runtime state, so a client that opens a thread and never uses it (an IDE or launcher
 * starting `mcode acp` per worktree) leaves no empty untitled Session in every Session list.
 */
export interface PendingRuntimeSession {
  readonly workspaceDir: string;
  /** Model and thinking effort chosen before creation; applied right after it. */
  model?: TuiModelSelection;
  creation?: Promise<TuiSession>;
  /**
   * Set when an earlier attempt wrote the Session but could not remove it after a later step
   * failed; the next attempt finishes that Session instead of colliding with its ID.
   */
  written?: boolean;
}

/** The part of an ACP attachment that creating its reserved Runtime Session reads and updates. */
export interface ReservedSessionAttachment {
  session: TuiSession;
  pending?: PendingRuntimeSession;
  readonly mcpServers: readonly TuiSessionMcpServer[];
  readonly attachmentController: AbortController;
}

type MaterializeRuntime = Pick<
  TuiAcpRuntime,
  | 'createSession'
  | 'configureSessionMcpServers'
  | 'selectSessionModel'
  | 'getSession'
  | 'deleteSession'
>;

/**
 * Returns the function that creates the Runtime Session an attachment reserved at session/new;
 * concurrent callers share one creation. Choices made before it (MCP servers, model, effort)
 * are applied here. If a step after the write fails or the client detached meanwhile, the
 * just-written Session is removed again and the reservation stays, so a later use can retry.
 *
 * Callers must run it in the Session's lifecycle lane, the lane session/set_config_option uses,
 * so a model chosen while the Session is being created is never applied to the reservation
 * after creation already read it.
 */
export function createRuntimeSessionMaterializer(
  runtime: MaterializeRuntime,
): (attachment: ReservedSessionAttachment) => Promise<TuiSession> {
  return (attachment) => {
    const pending = attachment.pending;
    if (!pending) return Promise.resolve(attachment.session);
    if (pending.creation) return pending.creation;
    const creation = createReservedSession(runtime, attachment, pending);
    pending.creation = creation;
    void creation.catch(() => {
      if (attachment.pending === pending && pending.creation === creation) {
        pending.creation = undefined;
      }
    });
    return creation;
  };
}

async function createReservedSession(
  runtime: MaterializeRuntime,
  attachment: ReservedSessionAttachment,
  pending: PendingRuntimeSession,
): Promise<TuiSession> {
  const sessionId = attachment.session.sessionId;
  if (attachment.attachmentController.signal.aborted) {
    throw acp.RequestError.resourceNotFound(sessionId);
  }
  // MCP servers are configured as a separate step inside the rollback scope: creating the Session
  // with them could write it and then fail on the overlay, leaving it behind.
  const created = pending.written
    ? await runtime.getSession(sessionId)
    : await runtime.createSession({ workspaceDir: pending.workspaceDir, sessionId });
  if (created.sessionId !== sessionId) {
    throw acp.RequestError.internalError(
      undefined,
      `Runtime created Session ${created.sessionId} instead of the reserved ${sessionId}.`,
    );
  }
  pending.written = true;
  try {
    if (attachment.mcpServers.length > 0) {
      await runtime.configureSessionMcpServers(sessionId, attachment.mcpServers);
    }
    if (pending.model && !(await runtime.selectSessionModel(pending.model, sessionId))) {
      throw acp.RequestError.invalidParams(undefined, 'Runtime rejected the model selection.');
    }
    const persisted = pending.model ? await runtime.getSession(sessionId) : created;
    if (attachment.attachmentController.signal.aborted) {
      throw acp.RequestError.resourceNotFound(sessionId);
    }
    attachment.session = persisted;
    attachment.pending = undefined;
    return persisted;
  } catch (error) {
    try {
      await runtime.deleteSession(sessionId);
      pending.written = false;
    } catch {
      // Keep `written`: the next attempt finishes this Session instead of creating it again.
    }
    throw error;
  }
}

/** Records a model or effort choice made before the reserved Session exists. */
export function bufferPendingModel(
  attachment: ReservedSessionAttachment,
  selection: TuiModelSelection,
): void {
  if (!attachment.pending) return;
  attachment.pending.model = selection;
  attachment.session = {
    ...attachment.session,
    model: {
      providerId: selection.providerId,
      modelId: selection.modelId,
      ...(selection.variant !== undefined ? { variant: selection.variant } : {}),
      ...(selection.thinking ? { thinking: selection.thinking } : {}),
    },
  };
}

/** A reserved Session without its own choice uses the globally selected model, as creation will. */
export function withRosterModel(session: TuiSession, models: readonly TuiModel[]): TuiSession {
  if (session.model?.providerId && session.model.modelId) return session;
  const selected = models.find((model) => model.selected);
  if (!selected) return session;
  return {
    ...session,
    model: {
      providerId: selected.providerId,
      modelId: selected.modelId,
      ...(selected.variant !== undefined ? { variant: selected.variant } : {}),
    },
  };
}
