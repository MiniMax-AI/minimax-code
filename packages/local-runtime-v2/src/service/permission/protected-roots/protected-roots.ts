import path from 'node:path';

import { canonicalPath, isInside, type Protects } from './canonical-paths.js';
import { scriptWritesInside } from './script-references.js';
import {
  writesInside,
  writesPaths,
  type ProtectedRootRequest,
  type ProtectedRootSession,
} from './write-targets.js';

/**
 * A directory of the runtime's private data that only the runtime, or the
 * product that owns it, writes. Products register entries; every Session's file
 * write tools and bash writes there are denied before any mode or rule applies.
 */
export interface RuntimeProtectedRoot<
  TSession extends ProtectedRootSession = ProtectedRootSession,
> {
  readonly directory: string;
  /** The protected part of `directory`; all of it when absent. */
  readonly protects?: Protects;
  /**
   * Also read the code a bash command hands to an interpreter and the local
   * scripts it runs: a protected path named next to a file-writing call counts
   * as a write there ({@link scriptWritesInside}).
   */
  readonly scripts?: boolean;
  /** The reason the Agent reads when its write is denied. */
  readonly reason: string;
  /** Sessions this entry leaves alone, such as the owner writing its own files. */
  readonly exempts?: (session: TSession | undefined) => boolean;
}

export interface ProtectedRootDenial {
  readonly behavior: 'deny';
  readonly reason: string;
}

/**
 * Checks registered roots first, in order, then hands the request on. Only file
 * write tools and bash read the Session, for the directories relative targets
 * resolve from; other tools go straight on.
 */
export function createProtectedRootDecisions<
  TRequest extends ProtectedRootRequest & { readonly sessionId: string },
  TDecision,
  TSession extends ProtectedRootSession,
>(
  options: {
    readonly sessions: { get(sessionId: string): Promise<TSession | undefined> };
    readonly roots: readonly RuntimeProtectedRoot<TSession>[];
  },
  decisions: { check(request: TRequest): Promise<TDecision> },
): { check(request: TRequest): Promise<TDecision | ProtectedRootDenial> } {
  const { sessions, roots } = options;
  return {
    check: async (request) => {
      if (roots.length > 0 && writesPaths(request.toolName)) {
        const session = await sessions.get(request.sessionId);
        const trusted = trustedExactTargets(request);
        for (const root of roots) {
          if (root.exempts?.(session)) continue;
          const protects = exceptTrusted(root.protects ?? isInside, trusted);
          if (
            writesInside(root.directory, session, request, protects) ||
            (root.scripts === true &&
              (await scriptWritesInside(root.directory, session, request, protects)))
          ) {
            return { behavior: 'deny', reason: root.reason };
          }
        }
      }
      return decisions.check(request);
    },
  };
}

/** The exact files the turn's execution owner hands the Session to write, such as its Plan document. */
function trustedExactTargets(request: ProtectedRootRequest): string[] {
  return (request.trustedExactWritePaths ?? []).map((target) =>
    canonicalPath(path.resolve(target)),
  );
}

/** A trusted exact target is the Session's own file, whichever tool or script writes it. */
function exceptTrusted(protects: Protects, trusted: readonly string[]): Protects {
  if (trusted.length === 0) return protects;
  // `path.relative` compares Windows paths case-insensitively.
  return (root, target) =>
    !trusted.some((exact) => path.relative(exact, target) === '') && protects(root, target);
}
