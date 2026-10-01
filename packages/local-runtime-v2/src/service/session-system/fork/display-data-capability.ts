import type { SessionHistoryMutationCapability } from '../messages/history/mutation/session-history-mutation-adapter.js';
import type { MessageRepository } from '../messages/repo/contract.js';
import { resolveForkDisplayBoundary } from './display-boundary.js';
import { resolveSideHistoryBoundary } from './side-history-boundary.js';

/** Session-owned Display boundary and projection operations used by Application Fork. */
export function createSessionForkDisplayCapability(
  messages: MessageRepository,
  historyMutation: SessionHistoryMutationCapability,
) {
  return {
    list: async (sessionId: string) => (await messages.list(sessionId)).messages,
    boundary: {
      resolve: async ({
        sessionId,
        assistantDisplayMessageId,
        sideHistory,
      }: {
        readonly sessionId: string;
        readonly assistantDisplayMessageId?: string;
        readonly sideHistory?: { readonly throughMessageId?: string };
      }) => {
        const display = (await messages.list(sessionId)).messages;
        const boundary = resolveForkDisplayBoundary(display, assistantDisplayMessageId);
        if (!boundary.assistant || boundary.assistantIndex < 0) return undefined;
        if (sideHistory) {
          const history = await historyMutation.read(sessionId);
          const messageId = resolveSideHistoryBoundary(history, sideHistory.throughMessageId);
          return {
            messages: display,
            assistant: boundary.assistant,
            assistantIndex: boundary.assistantIndex,
            isLatestConversationMessage: boundary.isLatestConversationMessage,
            canonicalBoundaryReachable: messageId !== undefined,
            ...(messageId ? { sideHistoryMessageId: messageId } : {}),
          };
        }
        const candidates = [
          boundary.assistantCanonicalMessageId,
          boundary.beforeUserMessageId,
        ].filter((candidate): candidate is string => Boolean(candidate));
        const history = candidates.length > 0 ? await historyMutation.read(sessionId) : undefined;
        const canonical = resolveCanonicalBoundary(history, boundary);
        return {
          messages: display,
          assistant: boundary.assistant,
          assistantIndex: boundary.assistantIndex,
          canonicalBoundaryReachable: candidates.length === 0 || canonical.reachable,
          isLatestConversationMessage: boundary.isLatestConversationMessage,
          ...(canonical.assistantMessageId
            ? { assistantCanonicalMessageId: canonical.assistantMessageId }
            : {}),
          ...(canonical.beforeUserMessageId
            ? { beforeUserMessageId: canonical.beforeUserMessageId }
            : {}),
        };
      },
    },
    probePrefix: (input: ForkDisplayPrefixProbe) => probeDisplayPrefix(messages, input),
    copyPrefix: (input: Parameters<MessageRepository['copyPrefix']>[0]) =>
      messages.copyPrefix(input),
    copyPrefixAndAppendForkOrigin: (
      input: Parameters<MessageRepository['copyPrefixAndAppendForkOrigin']>[0],
    ) => messages.copyPrefixAndAppendForkOrigin(input),
    appendForkOrigin: (input: Parameters<MessageRepository['appendForkOrigin']>[0]) =>
      messages.appendForkOrigin(input),
    latestRevision: (sessionId: string) => messages.latestDisplayRowId(sessionId),
    deleteSession: (sessionId: string) => messages.deleteSessionData(sessionId),
  };
}

function resolveCanonicalBoundary(
  history: Awaited<ReturnType<SessionHistoryMutationCapability['read']>> | undefined,
  boundary: ReturnType<typeof resolveForkDisplayBoundary>,
): ResolvedCanonicalBoundary {
  if (hasCanonicalBoundary(history, boundary.assistantCanonicalMessageId)) {
    return {
      reachable: true,
      assistantMessageId: boundary.assistantCanonicalMessageId,
      beforeUserMessageId: undefined,
    };
  }
  if (hasCanonicalBoundary(history, boundary.beforeUserMessageId)) {
    return {
      reachable: true,
      assistantMessageId: undefined,
      beforeUserMessageId: boundary.beforeUserMessageId,
    };
  }
  return {
    reachable: false,
    assistantMessageId: boundary.assistantCanonicalMessageId,
    beforeUserMessageId: boundary.assistantCanonicalMessageId
      ? undefined
      : boundary.beforeUserMessageId,
  };
}

interface ResolvedCanonicalBoundary {
  readonly reachable: boolean;
  readonly assistantMessageId: string | undefined;
  readonly beforeUserMessageId: ReturnType<
    typeof resolveForkDisplayBoundary
  >['beforeUserMessageId'];
}

function hasCanonicalBoundary(
  history: Awaited<ReturnType<SessionHistoryMutationCapability['read']>> | undefined,
  messageId: string | undefined,
): boolean {
  if (!history || !messageId) return false;
  return (
    history.active.some((envelope) => envelope.message_id === messageId) ||
    history.snapshots.some((snapshot) =>
      snapshot.records.some((envelope) => envelope.message_id === messageId),
    )
  );
}

export interface ForkDisplayPrefixProbe {
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly throughMessageId: string;
}

async function probeDisplayPrefix(
  messages: MessageRepository,
  input: ForkDisplayPrefixProbe,
): Promise<boolean> {
  const [source, target] = await Promise.all([
    messages.list(input.sourceSessionId),
    messages.list(input.targetSessionId),
  ]);
  const through = source.messages.findIndex((message) => message.msg_id === input.throughMessageId);
  if (through < 0) return false;
  const prefix = source.messages.slice(0, through + 1).filter((message) => !isForkOrigin(message));
  const copied = target.messages.slice(0, prefix.length);
  if (
    copied.length !== prefix.length ||
    copied.some((message, index) => message.msg_id !== prefix[index]?.msg_id)
  ) {
    return false;
  }
  return target.messages.some(
    (message) =>
      isForkOrigin(message) && message.forkOrigin?.sourceSessionId === input.sourceSessionId,
  );
}

function isForkOrigin(message: Awaited<ReturnType<MessageRepository['list']>>['messages'][number]) {
  return message.kind === 'fork-origin' || message.displayKind === 'fork-origin';
}
