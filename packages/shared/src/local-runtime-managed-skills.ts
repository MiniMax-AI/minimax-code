/**
 * Which managed Skills a conversation has already loaded.
 *
 * A namespaced on-demand tool runs only after its Skill was read in the same
 * conversation, so the receipt is what the gate checks. State is per process
 * and in memory, like the Browser Skill store: it is a within-conversation
 * fact, not durable data, and it is cleared on the same events that drop what
 * the model was told — a rewind that resets context, the conversation being
 * deleted, and a compaction that replaced the history.
 *
 * It sits in `@mavis/shared` beside the other local-runtime capability
 * contracts, because the AgentHost turn assembly reads it and that layer may
 * not depend on a Runtime service.
 */
export interface ManagedSkillReceiptStore {
  /** Whether this conversation already read the named Skill. */
  hasLoaded(sessionId: string, skill: string): boolean;
  markLoaded(sessionId: string, skill: string): void;
  /** Every Skill this conversation read, in read order. */
  loadedSkills(sessionId: string): readonly string[];
  /** Drops one Skill's receipt; true when there was one to drop. */
  clearSkill(sessionId: string, skill: string): boolean;
  /** A rewind that reset context, or the conversation being deleted; how many were dropped. */
  clearSession(sessionId: string): number;
  clear(): void;
  /**
   * Records that preloading this Skill failed in this process, so no later Turn
   * of the conversation reads it again. A Skill that cannot be found or read
   * stays unreadable for the life of the process, and re-reading it every Turn
   * would spend a Turn on the same failure.
   */
  markPreloadFailed(sessionId: string, skill: string): void;
  /** Whether preloading this Skill already failed in this process. */
  hasPreloadFailed(sessionId: string, skill: string): boolean;
  /**
   * Remembers the receipts one Turn's Skill preload wrote. A preloaded body
   * only reaches the model in that Turn's user message, so the receipts stay
   * provisional until the Turn settles.
   */
  recordPreloadReceipts(sessionId: string, turnId: string, skills: readonly string[]): void;
  /**
   * Settles one Turn's preload receipts: `committed` keeps them, because the
   * user message carrying those bodies was handed to the model; otherwise they
   * are dropped, so the next Turn preloads the bodies for real. Returns how
   * many receipts were dropped.
   */
  settlePreloadReceipts(sessionId: string, turnId: string, committed: boolean): number;
  /**
   * Claims the one history restore this process owes a conversation: true the
   * first time, false on every later call. A conversation clear drops the claim
   * with the receipts, so the next Turn re-derives them from what history now
   * holds.
   */
  claimHistoryRestore(sessionId: string): boolean;
}

/**
 * In-memory receipts, one set of Skill names per conversation, beside the
 * preloads that already failed for it.
 */
export class ManagedSkillReceipts implements ManagedSkillReceiptStore {
  private readonly loaded = new Map<string, Set<string>>();
  private readonly failedPreloads = new Map<string, Set<string>>();
  private readonly pendingPreloads = new Map<string, Map<string, readonly string[]>>();
  private readonly restored = new Set<string>();

  claimHistoryRestore(sessionId: string): boolean {
    if (this.restored.has(sessionId)) return false;
    this.restored.add(sessionId);
    return true;
  }

  hasLoaded(sessionId: string, skill: string): boolean {
    return this.loaded.get(sessionId)?.has(skill) === true;
  }

  markLoaded(sessionId: string, skill: string): void {
    const skills = this.loaded.get(sessionId);
    if (skills) skills.add(skill);
    else this.loaded.set(sessionId, new Set([skill]));
  }

  loadedSkills(sessionId: string): readonly string[] {
    return [...(this.loaded.get(sessionId) ?? [])];
  }

  clearSkill(sessionId: string, skill: string): boolean {
    const skills = this.loaded.get(sessionId);
    if (skills?.delete(skill) !== true) return false;
    if (skills.size === 0) this.loaded.delete(sessionId);
    return true;
  }

  markPreloadFailed(sessionId: string, skill: string): void {
    const skills = this.failedPreloads.get(sessionId);
    if (skills) skills.add(skill);
    else this.failedPreloads.set(sessionId, new Set([skill]));
  }

  hasPreloadFailed(sessionId: string, skill: string): boolean {
    return this.failedPreloads.get(sessionId)?.has(skill) === true;
  }

  recordPreloadReceipts(sessionId: string, turnId: string, skills: readonly string[]): void {
    if (skills.length === 0) return;
    const turns = this.pendingPreloads.get(sessionId);
    if (turns) turns.set(turnId, skills);
    else this.pendingPreloads.set(sessionId, new Map([[turnId, skills]]));
  }

  settlePreloadReceipts(sessionId: string, turnId: string, committed: boolean): number {
    const turns = this.pendingPreloads.get(sessionId);
    const skills = turns?.get(turnId);
    if (!turns || !skills) return 0;
    turns.delete(turnId);
    if (turns.size === 0) this.pendingPreloads.delete(sessionId);
    if (committed) return 0;
    return skills.filter((skill) => this.clearSkill(sessionId, skill)).length;
  }

  clearSession(sessionId: string): number {
    const dropped = this.loaded.get(sessionId)?.size ?? 0;
    this.loaded.delete(sessionId);
    this.failedPreloads.delete(sessionId);
    this.pendingPreloads.delete(sessionId);
    this.restored.delete(sessionId);
    return dropped;
  }

  clear(): void {
    this.loaded.clear();
    this.failedPreloads.clear();
    this.pendingPreloads.clear();
    this.restored.clear();
  }
}

/**
 * The Skills whose full body these messages still hold. Exactly the two ways a
 * Skill body reaches the model count:
 *
 * - a successful `skill` tool result, whose text opens with `# Skill: <name>`;
 * - a `<preloaded-skill name="<name>">` block in a user message.
 *
 * Anything else that merely quotes the header — a compaction summary, an
 * assistant turn, a user message that talks about a Skill — is not the body,
 * so it must not keep a receipt alive.
 *
 * Pure: the caller owns the store, so the AgentHost history writer, the
 * assembly layer and the Application composition can all reach the same rule
 * without any of them owning the receipt state.
 */
export function skillsHeldInHistory(messages: readonly unknown[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const message of messages) {
    const role = field(message, 'role');
    if (role === 'toolResult') {
      if (field(message, 'toolName') !== SKILL_TOOL_NAME) continue;
      const name = skillHeaderName(contentText(field(message, 'content')));
      if (name !== undefined) names.add(name);
      continue;
    }
    if (role !== 'user') continue;
    // The preload writes the attribute escaped, and a builtin namespace Skill
    // name carries no escapable character, so the raw name matches.
    for (const match of contentText(field(message, 'content')).matchAll(PRELOADED_SKILL_PATTERN)) {
      const name = match[1];
      if (name !== undefined) names.add(name);
    }
  }
  return names;
}

/**
 * Drops the receipts whose Skill body the given history no longer holds, and
 * logs one `managed_skill_receipts_cleared` line for the conversation.
 *
 * Compaction replaced the history with a checkpoint and a rewind removed the
 * turns after a point; in both cases a Skill the model read may no longer be in
 * context, and its receipt would keep letting the gate through a model that no
 * longer holds the rules. Checking only the bodies that are gone leaves a
 * preloaded Skill — whose body lives in the first user message and survives
 * both — unlocked, so the model is not told to reload what it already has.
 *
 * Returns how many receipts were dropped. Receipt bookkeeping never throws:
 * durable History acknowledgement and event publication must not depend on it.
 */
export function clearManagedSkillReceiptsOutsideHistory(
  receipts: ManagedSkillReceiptStore,
  input: {
    readonly sessionId: string;
    readonly messages: readonly unknown[];
    readonly reason: ManagedSkillReceiptClearReason;
    readonly logger?: ManagedSkillReceiptLogger;
  },
): number {
  try {
    const loaded = receipts.loadedSkills(input.sessionId);
    if (loaded.length === 0) return 0;
    const present = skillsHeldInHistory(input.messages);
    let cleared = 0;
    for (const skill of loaded) {
      if (present.has(skill)) continue;
      if (receipts.clearSkill(input.sessionId, skill)) cleared += 1;
    }
    logManagedSkillReceiptsCleared(input.logger, {
      sessionId: input.sessionId,
      reason: input.reason,
      cleared,
    });
    return cleared;
  } catch {
    // Receipt bookkeeping must not affect the caller.
    return 0;
  }
}

/**
 * Re-derives a conversation's receipts from the history it already has.
 *
 * Receipts live in memory, so a process restart empties them while the
 * conversation keeps every Skill body it read: the model still holds the
 * rules, but the gate would answer `SKILL_REQUIRED` and send it to reload
 * what it has. This marks exactly the Skills `skillsHeldInHistory` finds —
 * the same rule the compaction and rewind clears judge by — and runs once per
 * process per conversation, so a later Turn never resurrects a receipt the
 * `skill` tool did not write.
 *
 * A history that holds no body spends no claim, so the first Turn of a new
 * conversation leaves the restore available for the Turn that needs it.
 *
 * Returns how many receipts were restored. Receipt bookkeeping never throws:
 * Turn assembly must not depend on it.
 */
export function restoreManagedSkillReceiptsFromHistory(
  receipts: ManagedSkillReceiptStore,
  input: {
    readonly sessionId: string;
    readonly messages: readonly unknown[];
    readonly logger?: ManagedSkillReceiptLogger;
  },
): number {
  try {
    const held = skillsHeldInHistory(input.messages);
    if (held.size === 0) return 0;
    if (!receipts.claimHistoryRestore(input.sessionId)) return 0;
    const skills = [...held].filter((skill) => !receipts.hasLoaded(input.sessionId, skill));
    for (const skill of skills) receipts.markLoaded(input.sessionId, skill);
    if (skills.length > 0) {
      logManagedSkillReceiptsRestored(input.logger, {
        sessionId: input.sessionId,
        restored: skills.length,
        skills,
      });
    }
    return skills.length;
  } catch {
    // Receipt bookkeeping must not affect the caller.
    return 0;
  }
}

const SKILL_HEADER = '# Skill: ';
const SKILL_TOOL_NAME = 'skill';
const PRELOADED_SKILL_PATTERN = /<preloaded-skill name="([^"]+)">/gu;

/** The Skill a `skill` tool result loaded, read from its leading header line. */
function skillHeaderName(text: string): string | undefined {
  if (!text.startsWith(SKILL_HEADER)) return undefined;
  const name = text.slice(SKILL_HEADER.length).split('\n', 1)[0]?.trim();
  return name || undefined;
}

/** A message's text, whether its content is a string or a list of text parts. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (field(part, 'type') === 'text' ? field(part, 'text') : undefined))
    .filter((text): text is string => typeof text === 'string')
    .join('\n');
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined;
}

/** Why a conversation's receipts were dropped. */
export type ManagedSkillReceiptClearReason = 'compaction' | 'context_reset' | 'session_deleted';

/** Any structured sink that can take one info line. */
export interface ManagedSkillReceiptLogger {
  info?(fields: Record<string, unknown>, message: string): void;
}

/**
 * The one log line every receipt clear writes, so the events that drop a
 * conversation's receipts can be told apart by `reason` alone. The blocked
 * calls that follow are already counted by `managed_skill_gate_total`, so this
 * adds no metric of its own.
 */
export function logManagedSkillReceiptsCleared(
  logger: ManagedSkillReceiptLogger | undefined,
  input: {
    readonly sessionId: string;
    readonly reason: ManagedSkillReceiptClearReason;
    readonly cleared: number;
  },
): void {
  try {
    logger?.info?.(
      {
        event: 'managed_skill_receipts_cleared',
        session_id: input.sessionId,
        reason: input.reason,
        cleared: input.cleared,
      },
      '[local-runtime-v2] managed skill receipts cleared',
    );
  } catch {
    // Diagnostics must not affect the caller.
  }
}

/**
 * The one line a restart restore writes, so a conversation whose gate opened
 * without a `skill` call in this process can be told apart in the logs.
 */
export function logManagedSkillReceiptsRestored(
  logger: ManagedSkillReceiptLogger | undefined,
  input: {
    readonly sessionId: string;
    readonly restored: number;
    readonly skills: readonly string[];
  },
): void {
  try {
    logger?.info?.(
      {
        event: 'managed_skill_receipts_restored',
        session_id: input.sessionId,
        restored: input.restored,
        skills: input.skills,
      },
      '[local-runtime-v2] managed skill receipts restored',
    );
  } catch {
    // Diagnostics must not affect the caller.
  }
}
