export type AgentReferenceResolutionSource =
  | 'stable_name'
  | 'display_name_compat'
  | 'canonical_name'
  | 'explicit_agent';

/**
 * Neutral read scope shared by the local Agent capability and V1 consumers.
 * It contains no persistence or HTTP types, so consumers can be migrated
 * without importing either runtime's concrete Agent implementation.
 */
export interface AgentReferenceReadScope {
  readonly requestedName: string;
  readonly canonicalName: string;
  readonly primaryName: string;
  readonly compatibleNames: readonly string[];
  readonly exact: boolean;
  readonly source: AgentReferenceResolutionSource;
  readonly trustedBuiltin?: boolean;
  /** Persisted owner selected by the resolver, when the implementation knows it. */
  readonly exactOwnerName?: string;
}

/**
 * Narrow Agent reference port. Management callers may use the individual
 * methods; execution callers compose a private TaskTargetFacts object from
 * the same four methods without widening the public port.
 */
export interface AgentReferenceResolver {
  resolveAgentReadScope(requestedName: string): Promise<AgentReferenceReadScope>;
  resolveAgentWriteTarget(requestedName: string): Promise<string>;
  requireExactAgentKey(requestedName: string): Promise<string>;
  resolveAgentExecutionTarget(exactOwnerName: string): Promise<string>;
  /**
   * Whether the task tool may dispatch to this owner. An absent method or an
   * `undefined` result means the Agent is dispatchable, matching the wire
   * default of `AgentDetail.dispatchable`.
   */
  resolveAgentDispatchable?(exactOwnerName: string): Promise<boolean | undefined>;
}
