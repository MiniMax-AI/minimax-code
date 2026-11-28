export type CanonicalSubagentRole = 'explore' | 'worker' | 'verifier';

export interface LocalSubagentRoleDefinition {
  whenToUse: string;
}

/** Single source of truth for canonical desktop SubAgent role names. */
export const SUBAGENT_ROLES = {
  explore: {
    whenToUse:
      'Read-only mapping for unfamiliar, cross-file, or evidence-heavy questions; it can use Bash for read-only Git and code investigation, but cannot create or edit files.',
  },
  worker: {
    whenToUse:
      'Bounded production work with explicit scope, ownership, deliverable, and acceptance.',
  },
  verifier: {
    whenToUse:
      'Independently validate an existing deliverable and report findings; no project-file changes. Temporary validation artifacts require an explicitly designated temporary location.',
  },
} as const satisfies Record<CanonicalSubagentRole, LocalSubagentRoleDefinition>;

export const CANONICAL_SUBAGENT_ROLES = Object.keys(SUBAGENT_ROLES) as CanonicalSubagentRole[];

/**
 * Model-visible built-in targets. `mavis` is deliberately absent: the primary
 * Agent is not dispatchable through the task tool.
 */
const TASK_AGENT_TARGETS: readonly CanonicalSubagentRole[] = CANONICAL_SUBAGENT_ROLES;

const TASK_AGENT_TARGET_DESCRIPTIONS: Readonly<
  Record<(typeof TASK_AGENT_TARGETS)[number], string>
> = {
  explore: SUBAGENT_ROLES.explore.whenToUse,
  worker: SUBAGENT_ROLES.worker.whenToUse,
  verifier: SUBAGENT_ROLES.verifier.whenToUse,
};

/** Names whose bare form is interpreted as a canonical role or primary alias. */
export const RESERVED_SUBAGENT_NAMES = [
  ...CANONICAL_SUBAGENT_ROLES,
  'main',
  'mavis',
] as readonly string[];

const RESERVED_SUBAGENT_NAME_SET = new Set(RESERVED_SUBAGENT_NAMES);

/**
 * The desktop service currently returns the thrift enum value for built-ins,
 * while a few adapters expose the already-decoded string. Everything else is
 * intentionally treated as non-builtin so a manual/unknown row cannot be
 * selected through a role or primary alias by accident.
 */
export function isTrustedBuiltinCreationSource(value: unknown): boolean {
  return value === 3 || value === 'builtin';
}

export function toAgentRequestRef(
  agent: { name?: unknown; creationSource?: unknown } | null | undefined,
): string | undefined {
  if (typeof agent?.name !== 'string') return undefined;
  const name = agent.name;
  if (name.toLowerCase().startsWith('agent:')) return name;
  if (
    RESERVED_SUBAGENT_NAME_SET.has(name.toLowerCase()) &&
    !isTrustedBuiltinCreationSource(agent.creationSource)
  ) {
    return `agent:${name}`;
  }
  return name;
}

export const AGENT_REQUEST_REF_DESCRIPTION =
  'Use the `requestRef` returned by the native `mavis` tool with command "agent list". For built-in work use explore, worker, or verifier. Use `agent:<stable-name>` to select the exact manual/custom Agent when its name collides with a reserved role or primary alias; ordinary custom names use their raw stable name.';

export const LOCAL_MAVIS_AGENT_NAME_DESCRIPTION = `${AGENT_REQUEST_REF_DESCRIPTION} "me" selects the current Agent.`;

const TASK_AGENT_REQUEST_REF_DESCRIPTION =
  'Built-in name or stable custom `requestRef`. Use `agent:<stable-name>` for a custom Agent whose name collides with a reserved role or primary alias; ordinary custom names use their raw stable name. Use the native `mavis` tool with command "agent list" for discovery only when needed and available.';

const WITHOUT_MAVIS_AGENT_REQUEST_REF_DESCRIPTION =
  'Use explore, worker, or verifier for built-in work. For a known custom Agent, use its stable `requestRef`. Use `agent:<stable-name>` to select the exact manual/custom Agent when its name collides with a reserved role or primary alias; ordinary custom names use their raw stable name.';

export function isCanonicalSubagentRole(value: string): value is CanonicalSubagentRole {
  return Object.hasOwn(SUBAGENT_ROLES, value);
}

export function resolveCanonicalSubagentRole(
  requestedName: string,
): CanonicalSubagentRole | undefined {
  const normalized = requestedName.trim().toLowerCase();
  return isCanonicalSubagentRole(normalized) ? normalized : undefined;
}

export function roleDirectoryText(): string {
  return TASK_AGENT_TARGETS.map(
    (target) => `- ${target} — ${TASK_AGENT_TARGET_DESCRIPTIONS[target]}`,
  ).join('\n');
}

/**
 * Returns model-visible Task target guidance for the currently exposed
 * capability surface. Resolver compatibility stays unchanged.
 */
export function agentNameDescription(options: { includeMavis?: boolean } = {}): string {
  return options.includeMavis === false
    ? WITHOUT_MAVIS_AGENT_REQUEST_REF_DESCRIPTION
    : TASK_AGENT_REQUEST_REF_DESCRIPTION;
}
