export interface TranscriptToolDefinition {
  readonly names: readonly string[];
  readonly family?:
    | 'shell'
    | 'read'
    | 'search'
    | 'write'
    | 'edit'
    | 'task'
    | 'task-control'
    | 'mcp';
  readonly accentLabel?: string;
  readonly summaryStyle?: 'parenthetical' | 'dot';
  readonly succeededMarker?: 'check';
  readonly runningAction: string;
  readonly completedAction: string;
  readonly failedAction?: string;
  readonly failedActionsByCode?: Readonly<Record<string, string>>;
  readonly previewLines?: {
    readonly running: number;
    readonly completed: number;
    readonly failed: number;
  };
}

const BUILTIN_TOOL_DEFINITIONS: readonly TranscriptToolDefinition[] = [
  {
    names: ['bash'],
    family: 'shell',
    runningAction: 'Running',
    completedAction: 'Ran',
    failedAction: 'Command failed',
    previewLines: { running: 3, completed: 3, failed: 8 },
  },
  {
    names: ['edit', 'edit_file', 'apply_patch'],
    family: 'edit',
    runningAction: 'Editing',
    completedAction: 'Edited',
    failedAction: 'Edit failed',
    previewLines: { running: 3, completed: 3, failed: 8 },
  },
  {
    names: ['grep', 'search'],
    family: 'search',
    runningAction: 'Searching',
    completedAction: 'Searched',
    failedAction: 'Search failed',
    failedActionsByCode: { invalid_regex: 'Invalid search pattern' },
    previewLines: { running: 3, completed: 3, failed: 6 },
  },
  {
    names: ['glob', 'list', 'list_files'],
    family: 'search',
    runningAction: 'Listing',
    completedAction: 'Listed',
    failedAction: 'List failed',
  },
  {
    names: ['run_code'],
    runningAction: 'Running code',
    completedAction: 'Ran code',
    failedAction: 'Code failed',
    previewLines: { running: 3, completed: 3, failed: 8 },
  },
  {
    names: ['memory'],
    runningAction: 'Updating memory',
    completedAction: 'Updated memory',
    failedAction: 'Memory update failed',
  },
  {
    names: ['read', 'read_file', 'readfile'],
    family: 'read',
    runningAction: 'Reading',
    completedAction: 'Read',
    failedAction: 'Read failed',
  },
  {
    names: ['write', 'write_file'],
    family: 'write',
    runningAction: 'Writing',
    completedAction: 'Wrote',
    failedAction: 'Write failed',
    previewLines: { running: 3, completed: 3, failed: 8 },
  },
  {
    names: ['task', 'delegate', 'spawn_agent'],
    family: 'task',
    runningAction: 'Delegating',
    completedAction: 'Delegated',
    failedAction: 'Delegation failed',
    previewLines: { running: 3, completed: 3, failed: 8 },
  },
  {
    names: ['task_output'],
    family: 'task-control',
    summaryStyle: 'dot',
    succeededMarker: 'check',
    runningAction: 'Reading task result',
    completedAction: 'Read task result',
    failedAction: 'Read task result',
  },
  {
    names: ['task_query'],
    family: 'task-control',
    summaryStyle: 'dot',
    succeededMarker: 'check',
    runningAction: 'Checking background tasks',
    completedAction: 'Checked background tasks',
    failedAction: 'Background task check failed',
  },
  {
    names: ['web_search', 'matrix_web_search', 'mcp__matrix__web_search'],
    runningAction: 'Using WebSearch',
    completedAction: 'Used WebSearch',
    failedAction: 'WebSearch failed',
    accentLabel: 'WebSearch',
  },
  {
    names: ['web_fetch'],
    runningAction: 'Using WebFetch',
    completedAction: 'Used WebFetch',
    failedAction: 'WebFetch failed',
    accentLabel: 'WebFetch',
  },
  {
    names: ['mcp'],
    family: 'mcp',
    runningAction: 'Calling',
    completedAction: 'Called',
    failedAction: 'Call failed',
    previewLines: { running: 3, completed: 3, failed: 8 },
  },
];

const TOOL_DEFINITIONS: ReadonlyMap<string, TranscriptToolDefinition> = new Map(
  BUILTIN_TOOL_DEFINITIONS.flatMap((definition) =>
    definition.names.map((name) => [normalizeToolName(name), definition] as const),
  ),
);

export function resolveTranscriptToolDefinition(
  title: string | undefined,
): TranscriptToolDefinition | undefined {
  const normalized = normalizeToolName(title);
  return (
    TOOL_DEFINITIONS.get(normalized) ??
    (isMcpToolName(normalized) ? TOOL_DEFINITIONS.get('mcp') : undefined)
  );
}

export function resolveTranscriptToolFailedAction(
  definition: TranscriptToolDefinition,
  errorCode: string | undefined,
): string {
  return (
    (errorCode ? definition.failedActionsByCode?.[errorCode] : undefined) ??
    definition.failedAction ??
    definition.completedAction
  );
}

export function normalizeToolName(title: string | undefined): string {
  return title?.trim().toLocaleLowerCase().replaceAll('-', '_') || 'tool';
}

export function formatTranscriptToolIdentity(
  title: string | undefined,
  definition: TranscriptToolDefinition | undefined,
): string | undefined {
  if (definition?.family !== 'mcp') return undefined;
  const normalized = normalizeToolName(title);
  if (normalized.startsWith('mcp__')) {
    const [, server, ...tool] = normalized.split('__');
    return server && tool.length > 0 ? `${server}.${tool.join('.')}` : normalized;
  }
  if (normalized.startsWith('mcp_')) return normalized.slice(4).replaceAll('__', '.');
  return normalized === 'mcp' ? undefined : normalized;
}

function isMcpToolName(name: string): boolean {
  return name === 'mcp' || name.startsWith('mcp__') || name.startsWith('mcp_');
}
