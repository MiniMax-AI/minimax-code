/**
 * Whether programmatic tool calling (PTC) is really on for one Turn.
 *
 * Two places must agree on this: the tool catalog, which hides ordinary tools
 * behind run_code, and the system prompt, which tells the model those tools
 * are callable only inside run_code. If they disagreed, the prompt would send
 * the model to run_code when it does not exist, or keep recommending direct
 * calls that are rejected. Both call this one function with the Session mode
 * read once while the Turn's agent config is built.
 *
 * The Session mode is the only input. It is fixed from `beta.ptc` when the
 * Session is created (Peek and fork Sessions inherit their source) and
 * refreshed only after a committed summary (`llm_checkpoint`) compaction, so
 * the prompt prefix of a Session never changes between those points: trigger
 * source, Session kind, role and surface do not take part.
 */
export interface PtcTurnFacts {
  /** The Session runs in PTC mode (`toolCallMode: 'ptc'`). */
  readonly requested: boolean;
}

export function isPtcTurnEnabled(facts: PtcTurnFacts): boolean {
  return facts.requested;
}
