/**
 * Whether programmatic tool calling (PTC) is really on for one Turn.
 *
 * Two places must agree on this: the tool catalog, which hides ordinary tools
 * behind run_code, and the system prompt, which tells the model those tools
 * are callable only inside run_code. If they disagreed, the prompt would send
 * the model to run_code when it does not exist, or keep recommending direct
 * calls that are rejected. Both call this one function with facts taken from
 * the same rendered Agent profile.
 */
export interface PtcTurnFacts {
  /**
   * The Session runs in PTC mode (`toolCallMode: 'ptc'`, fixed from `beta.ptc`
   * at creation or after a compaction) and a trusted top-level entry that may
   * use PTC (Agent Host turn intent `desktop-ptc`).
   */
  readonly requested: boolean;
  /** Prompt surface of the rendered profile; missing means interactive. */
  readonly surface?: 'interactive' | 'task-child' | 'cli';
  /**
   * Canonical view name of a trusted built-in Agent (`creationSource ===
   * 'builtin'`); absent for Custom Agents.
   */
  readonly canonicalRole?: string;
}

/** Built-in roles that keep native tools: read-only Explore and Peek. */
const NATIVE_ONLY_ROLES: ReadonlySet<string> = new Set(['explore', 'peek']);

export function isPtcTurnEnabled(facts: PtcTurnFacts): boolean {
  const surface = facts.surface ?? 'interactive';
  return (
    facts.requested &&
    (surface === 'interactive' || surface === 'cli') &&
    (facts.canonicalRole === undefined || !NATIVE_ONLY_ROLES.has(facts.canonicalRole))
  );
}
