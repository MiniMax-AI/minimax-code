import type { AbortSessionReq } from '@mavis/local-runtime-v2/cli-service';
import type {
  ListTuiSessionPageInput,
  TuiDelegatedAgent,
  TuiDelegationSnapshot,
  TuiDelegationStopOptions,
  TuiDelegationStopReceipt,
  TuiSession,
  TuiSessionPage,
} from '../port.js';
import { MINIMAX_CODE_DEFAULT_AGENT_NAME } from '../../product-context.js';
import {
  collectTuiDelegatedSessions,
  isActiveTuiDelegatedAgent,
  toTuiDelegatedAgent,
} from '../delegation.js';

const DELEGATION_PAGE_SIZE = 200;
const MAX_DELEGATION_PAGES = 20;
const MAX_STOP_PASSES = 3;

export interface TuiDelegationAccessOptions {
  defaultAgentName?: string;
  listSessionPage(input: ListTuiSessionPageInput): Promise<TuiSessionPage>;
  abortSession(req: AbortSessionReq): Promise<boolean>;
}

export class TuiDelegationAccess {
  constructor(private readonly options: TuiDelegationAccessOptions) {}

  async getSnapshot(rootSessionId: string): Promise<TuiDelegationSnapshot> {
    const sessions = await this.listAllSessions();
    const members = collectTuiDelegatedSessions(sessions, rootSessionId).map((member) =>
      toTuiDelegatedAgent(member),
    );
    return { schemaVersion: 1, rootSessionId, members };
  }

  async stop(
    rootSessionId: string,
    options: TuiDelegationStopOptions = {},
  ): Promise<TuiDelegationStopReceipt> {
    const { targetSessionId } = options;
    const failedSessionIds = new Set<string>();
    const inactiveSessionIds = new Set<string>();
    const stoppedSessionIds = new Set<string>();
    const inScope = (snapshot: TuiDelegationSnapshot) =>
      targetSessionId === undefined
        ? snapshot.members
        : collectDelegatedSubtree(snapshot.members, targetSessionId);
    let rootStopped = false;
    let initial: TuiDelegationSnapshot;
    if (targetSessionId === undefined) {
      rootStopped =
        (await this.abort(rootSessionId, failedSessionIds, inactiveSessionIds)) === 'stopped';
      initial = await this.getSnapshot(rootSessionId);
    } else {
      initial = await this.getSnapshot(rootSessionId);
      const target = initial.members.find(({ sessionId }) => sessionId === targetSessionId);
      if (!target) {
        throw new Error(
          `Session ${targetSessionId} is not a delegated agent of root Session ${rootSessionId}.`,
        );
      }
      if (
        isActiveTuiDelegatedAgent(target) &&
        (await this.abort(targetSessionId, failedSessionIds, inactiveSessionIds)) === 'stopped'
      ) {
        stoppedSessionIds.add(targetSessionId);
      }
    }
    let pending = inScope(initial).filter(isActiveTuiDelegatedAgent);

    for (let pass = 0; pass < MAX_STOP_PASSES; pass += 1) {
      for (const member of [...pending].reverse()) {
        if ((await this.abort(member.sessionId, failedSessionIds, inactiveSessionIds)) === 'stopped') {
          stoppedSessionIds.add(member.sessionId);
        }
      }
      const refreshed = await this.getSnapshot(rootSessionId);
      pending = inScope(refreshed).filter(
        (member) => isActiveTuiDelegatedAgent(member) && !stoppedSessionIds.has(member.sessionId),
      );
      if (pending.length === 0) break;
    }

    const final = await this.getSnapshot(rootSessionId);
    return {
      schemaVersion: 1,
      rootSessionId,
      ...(targetSessionId === undefined ? {} : { targetSessionId }),
      rootStopped,
      stoppedSessionIds: [...stoppedSessionIds],
      activeSessionIds: inScope(final)
        .filter(isActiveTuiDelegatedAgent)
        .filter(
          (member) =>
            !stoppedSessionIds.has(member.sessionId) && !inactiveSessionIds.has(member.sessionId),
        )
        .map((member) => member.sessionId),
      failedSessionIds: [...failedSessionIds],
    };
  }

  private async listAllSessions(): Promise<TuiSession[]> {
    const agentNames = new Set([
      this.options.defaultAgentName ?? MINIMAX_CODE_DEFAULT_AGENT_NAME,
      MINIMAX_CODE_DEFAULT_AGENT_NAME,
    ]);
    const seen = new Set<string>();
    const sessions: TuiSession[] = [];
    for (const agentName of agentNames) {
      for (const session of await this.listPagedSessions({ agentName, allAgents: true })) {
        if (seen.has(session.sessionId)) continue;
        seen.add(session.sessionId);
        sessions.push(session);
      }
    }
    return sessions;
  }

  private async listPagedSessions(scope: ListTuiSessionPageInput): Promise<TuiSession[]> {
    const sessions: TuiSession[] = [];
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < MAX_DELEGATION_PAGES; pageIndex += 1) {
      const page = await this.options.listSessionPage({
        ...scope,
        includeArchived: true,
        includeHidden: true,
        cursor,
        limit: DELEGATION_PAGE_SIZE,
      });
      sessions.push(...page.sessions);
      if (!page.hasMore || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return sessions;
  }

  private async abort(
    sessionId: string,
    failedSessionIds: Set<string>,
    inactiveSessionIds: Set<string>,
  ): Promise<'stopped' | 'inactive' | 'failed'> {
    try {
      if (await this.options.abortSession({ id: sessionId, reason: 'user_stop' })) {
        inactiveSessionIds.delete(sessionId);
        failedSessionIds.delete(sessionId);
        return 'stopped';
      }
      inactiveSessionIds.add(sessionId);
      return 'inactive';
    } catch {
      failedSessionIds.add(sessionId);
      return 'failed';
    }
  }
}

function collectDelegatedSubtree(
  members: readonly TuiDelegatedAgent[],
  targetSessionId: string,
): TuiDelegatedAgent[] {
  const subtree = new Set([targetSessionId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const member of members) {
      if (subtree.has(member.sessionId) || !subtree.has(member.parentSessionId)) continue;
      subtree.add(member.sessionId);
      changed = true;
    }
  }
  return members.filter(({ sessionId }) => subtree.has(sessionId));
}
