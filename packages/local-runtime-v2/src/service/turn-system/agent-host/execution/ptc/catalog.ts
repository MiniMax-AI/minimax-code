import type { PtcToolExecutionRequest, PtcToolSource, RuntimeTool } from '@mavis/agent-core/tools';

interface PtcChildCatalog {
  readonly childTools: readonly RuntimeTool[];
  readonly evidenceSourceByTool: ReadonlyMap<RuntimeTool, PtcToolSource>;
}

const childToolsByRunCode = new WeakMap<RuntimeTool, PtcChildCatalog>();

export function registerPtcChildTools(
  runCode: RuntimeTool,
  childTools: readonly RuntimeTool[],
  trustedNativeTools: readonly RuntimeTool[] = [],
): RuntimeTool {
  const nativeTools = new Set(trustedNativeTools);
  const evidenceSourceByTool = new Map<RuntimeTool, PtcToolSource>();
  for (const tool of childTools) {
    if (nativeTools.has(tool)) evidenceSourceByTool.set(tool, tool.source ?? 'builtin');
  }
  childToolsByRunCode.set(runCode, { childTools, evidenceSourceByTool });
  return runCode;
}

/** Evidence ownership follows the admitted object, never its name or permission source. */
export function readPtcToolEvidenceSource(
  runCode: RuntimeTool,
  tool: RuntimeTool | undefined,
): PtcToolExecutionRequest['evidenceSource'] {
  if (!tool) return undefined;
  const source = childToolsByRunCode.get(runCode)?.evidenceSourceByTool.get(tool);
  return source === undefined ? undefined : { tool, source };
}

/** Returns the original final authorization snapshot behind a visible run_code tool. */
export function readPtcChildTools(
  tools: readonly RuntimeTool[] | undefined,
): readonly RuntimeTool[] | undefined {
  if (!tools) return undefined;
  for (const tool of tools) {
    const catalog = childToolsByRunCode.get(tool);
    if (catalog) return catalog.childTools;
  }
  return undefined;
}

/** Full authorized snapshot for host validation; model disclosure stays separate. */
export function readAuthorizedTurnTools(
  visibleTools: readonly RuntimeTool[],
): readonly RuntimeTool[] {
  const childTools = readPtcChildTools(visibleTools);
  if (!childTools) return visibleTools;
  const toolsByName = new Map(visibleTools.map((tool) => [tool.def.name, tool]));
  for (const tool of childTools) {
    if (!toolsByName.has(tool.def.name)) toolsByName.set(tool.def.name, tool);
  }
  return [...toolsByName.values()];
}

/**
 * The native task_output, the only reader of the background task store. A
 * configured or MCP namesake cannot read it. A Turn whose executable tools
 * (run_code's children on a PTC Turn) include it lets a direct Bash call move
 * to the background (executor.ts, canConsumeNativeTaskOutput); a run_code Bash
 * child never does (Agent Core gives program children
 * allowBashAutoPromotion: false).
 */
export function isNativeTaskOutputTool(tool: RuntimeTool): boolean {
  return (
    tool.def.name === 'task_output' && (tool.source === undefined || tool.source === 'builtin')
  );
}

/**
 * The catalog's PTC reminder reaches the executor only inside the merged user
 * prompt prefix. Keeping the same string beside this Turn's run_code lets the
 * executor restore exactly that text after compaction replaced the user message,
 * without a second copy of the wording or a new assembly field.
 */
const turnReminderByRunCode = new WeakMap<RuntimeTool, string>();

export function registerPtcTurnReminder(runCode: RuntimeTool, reminder: string): RuntimeTool {
  turnReminderByRunCode.set(runCode, reminder);
  return runCode;
}

/** The reminder registered with a visible run_code; undefined on Turns without PTC. */
export function readPtcTurnReminder(tools: readonly RuntimeTool[] | undefined): string | undefined {
  if (!tools) return undefined;
  for (const tool of tools) {
    const reminder = turnReminderByRunCode.get(tool);
    if (reminder !== undefined) return reminder;
  }
  return undefined;
}
