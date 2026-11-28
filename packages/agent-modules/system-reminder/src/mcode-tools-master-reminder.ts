import { unwrapSystemReminder, wrapSystemReminderBlocks } from './envelope.js';

const MCODE_TOOLS_MASTER_REMINDER = [
  '<mcode-tools-master-reminder>',
  'The mcode-tools-master skill and mcode-tools CLI serve two purposes: multimodal generation and understanding, and App/Connector tool discovery and use. Load the skill before running any mcode-tools Bash command.',
  'For multimodal generation and understanding, including images/photos, video, audio, music, and documents, load the mcode-tools-master skill and use mcode-tools through Bash. For requested photos, illustrations, posters, or scene renderings, discover suitable image-generation tools before coding a substitute, even without a tool or plugin mention. Discover the relevant tools before concluding that a multimodal capability is unavailable.',
  'For App/Connector requests, load the mcode-tools-master skill and use the mcode-tools connector subcommands to discover, inspect, and call tools. App = Connector: these names refer to the same connected integration. App tools are not listed as direct tools; use CLI discovery before concluding that an App capability is unavailable.',
  'When the user asks to use a named App/service (including a name written in natural language without @), discover its tools before using web_search or a browser as a substitute. A request to use a named integration should be fulfilled through that integration rather than a web search for its name and the task. Merely asking about an App is not a request to use it.',
  'For tasks requiring specialized external records or connected-account data, such as company records, legal cases, financial datasets, or workspace documents, check relevant App tools before general web search when no suitable dedicated tool is already known. App calls through Bash are dedicated-tool access, not ad hoc shell work. Ordinary knowledge questions, local-file tasks, and explicitly requested web searches do not require App discovery.',
  'A Plugin can bundle Apps, MCP tools, and Skills; an App may also be connected independently of a Plugin. After loading the Skill, use mcode-tools connector tools with a relevant keyword. If names or languages do not match, broaden the keyword or list tools without a filter once before concluding that no match exists. Use returned tool names and inspect their schemas; do not invent provider names.',
  'Use a matching App when available. A discovery error or partial catalog does not prove the App is disconnected. Explain unavailable access or discovery failures instead of silently replacing an explicitly requested App with web results. Web search may supplement App results or provide a clearly identified fallback consistent with the user request. Reuse a known relevant tool when appropriate; do not list all Apps on every turn.',
  'Use this path only when Bash and the Skill are available to this Agent. Otherwise explain that App access is unavailable; do not bypass restrictions or assume a direct-tool fallback.',
  '</mcode-tools-master-reminder>',
].join('\n');

const MCODE_TOOLS_MASTER_UNAVAILABLE =
  '<mcode-tools-master-reminder>App = Connector: these names refer to the same connected integration. App/Connector tools require mcode-tools through Bash. The mcode-tools-master Skill is unavailable in this Agent, so App access is unavailable. Do not assume a direct-tool fallback.</mcode-tools-master-reminder>';

/** The full guidance when the mcode-tools-master Skill is available, otherwise the unavailable note. */
export function buildMcodeToolsMasterReminderBlock(enabled: boolean): string {
  return enabled ? MCODE_TOOLS_MASTER_REMINDER : MCODE_TOOLS_MASTER_UNAVAILABLE;
}

export function withMcodeToolsMasterReminder(input: {
  reminderText: string | undefined;
  modelID: string | undefined;
  enabled: boolean;
}): string | undefined {
  const appReminder = buildMcodeToolsMasterReminderBlock(input.enabled);
  const existing = unwrapSystemReminder(input.reminderText);
  return wrapSystemReminderBlocks(existing ? [existing, appReminder] : [appReminder]);
}
