import type { RuntimeTool } from '@mavis/agent-core/tools';
import {
  isPtcMavisChildToolName,
  PTC_MAVIS_RUN_CODE_NOTE,
  readPtcMavisChildTarget,
} from '@mavis/agent-tools';

interface NativeDataType {
  readonly name: string;
  readonly declaration: string;
  /** Types this declaration refers to; each is printed once, before its first user. */
  readonly requires?: readonly NativeDataType[];
}

/**
 * Computer Use types (local-runtime-v2 service/computer-use/result). The ten
 * action tools share one type, computer_type and computer_app_activate only
 * extend it. Its comment also states the failure shape of the read tools, so
 * it is printed whenever any computer_* type is.
 */
const COMPUTER_ACTION_DATA: NativeDataType = {
  name: 'ComputerActionData',
  declaration:
    'type ComputerActionData = { effect?: string; code?: string; route?: string; deliveryMode?: string; dispatched?: boolean; degradedReason?: string; escalation?: string; refusedRoutes?: Array<{ route: string; reason?: string }>; completion?: "not_started" | "completed" | "unknown" }; // driver strings, e.g. effect "confirmed", "unverifiable" or "refused", code "delivery_failed"; escalation is the recommended delivery mode; completion only when the call threw: whether the action ran. Other failed computer_* calls have only { code?, completion? }',
};
const COMPUTER_SCREENSHOT: NativeDataType = {
  name: 'ComputerScreenshot',
  declaration:
    'type ComputerScreenshot = { included: boolean; width?: number; height?: number; mimeType?: string }; // width, height: the pixel space of screenshot x/y',
};
const computerType = (name: string, declaration: string, screenshot = false): NativeDataType => ({
  name,
  declaration,
  requires: screenshot ? [COMPUTER_ACTION_DATA, COMPUTER_SCREENSHOT] : [COMPUTER_ACTION_DATA],
});
const COMPUTER_DATA_TYPES: Readonly<Record<string, NativeDataType>> = {
  ...Object.fromEntries(
    [
      'computer_click',
      'computer_drag',
      'computer_set_value',
      'computer_select_text',
      'computer_key',
      'computer_scroll',
      'computer_secondary_action',
      'computer_window_set_frame',
    ].map((name) => [name, COMPUTER_ACTION_DATA]),
  ),
  computer_type: computerType(
    'ComputerTypeData',
    'type ComputerTypeData = ComputerActionData & { deliveredChars?: number; requestedChars?: number; retryFromCharacter?: number };',
  ),
  computer_app_activate: computerType(
    'ComputerActivateData',
    'type ComputerActivateData = ComputerActionData & { processActivated?: boolean; focusedWindowId?: number | null; frontProcessMatchesTarget?: boolean };',
  ),
  computer_app_state: computerType(
    'AppStateData',
    'type AppStateData = { pid?: number; windowId?: number; degradedReason?: string; elementCount?: number; filteredElementCount?: number; menuOmitted: boolean; treeTruncated: boolean; geometryConflict: boolean; backgroundRoutes?: Array<{ route: string; status: string; reason?: string }>; screenshot: ComputerScreenshot; elements: Array<{ index: number; role?: string; label?: string; value?: string | number | boolean; token?: string; depth?: number; enabled?: boolean; selected?: boolean; expanded?: boolean }> }; // only elements whose "- [index]" row is in output; token is its element_token; on failure { pid?, windowId?, degradedReason?, screenshot: { included: false } }',
    true,
  ),
  computer_window_list: computerType(
    'WindowListData',
    'type WindowListData = { pid?: number; windows: Array<{ windowRef: string; windowId: number; title?: string; isOnScreen?: boolean; onCurrentSpace?: boolean | null; bounds?: { x: number; y: number; width: number; height: number } }> }; // bounds in desktop coordinates',
  ),
  computer_app_list: computerType(
    'AppListData',
    'type AppListData = { apps: Array<{ name: string; pid?: number; bundleId?: string; launchPath?: string; running?: boolean; active?: boolean }> } | { counts: { total: number; running: number; installedNotRunning: number }; running: Array<{ name: string; pid?: number; bundleId?: string }>; activeApps: Array<{ name: string; pid?: number; bundleId?: string }> } | { counts: { total: number; running: number; installedNotRunning: number }; page: { offset: number; limit: number; returned: number }; apps: Array<{ name: string; pid?: number; bundleId?: string; running: boolean }> }; // apps with name; running without it; page with scope installed or all',
  ),
  computer_app_launch: computerType(
    'AppLaunchData',
    'type AppLaunchData = { pid?: number; processRunning?: boolean; windowReadiness?: string; observedWindowIds?: number[]; observationComplete?: boolean; windows?: Array<{ windowRef?: string; windowId: number; title?: string }> };',
  ),
  computer_desktop_state: computerType(
    'DesktopStateData',
    'type DesktopStateData = { screenshot: ComputerScreenshot; screenWidth?: number; screenHeight?: number };',
    true,
  ),
  computer_display_list: computerType(
    'DisplayListData',
    'type DisplayListData = { coordinateSpace?: string; matchesNativeWindowCoordinates?: boolean; cursor?: { x: number; y: number; displayId: string }; displays?: Array<{ id: string; label?: string; primary: boolean; internal: boolean; bounds: { x: number; y: number; width: number; height: number }; workArea: { x: number; y: number; width: number; height: number }; scaleFactor: number; rotation: number }> };',
  ),
  computer_verify_state: computerType(
    'VerifyStateData',
    'type VerifyStateData = { predicates: Array<{ index: number; status: string; unknownReason?: string }>; screenshot?: ComputerScreenshot };',
    true,
  ),
};

/**
 * `data` shapes of native tools (each agent-tools tool's programmatic data
 * and Bash's details projection). Declared only for the native objects, so an
 * MCP or plugin tool that reuses a name promises nothing. A failure keeps only
 * the metadata named in the comment; a call that did not run has `{}`.
 */
const NATIVE_DATA_TYPES: Readonly<Record<string, NativeDataType>> = {
  read: {
    name: 'ReadData',
    declaration:
      'type ReadData = { kind: "text"; content: string; startLine: number; lineCount: number; totalLines: number } | { kind: "image"; mimeType: string; width: number; height: number; originalWidth: number; originalHeight: number } | { kind: "image"; mimeType: string; omittedReason: "too_large" | "processor_unavailable" } | { kind: "pdf" | "notebook" | "video" }; // content has no line numbers; on failure only kind',
  },
  write: {
    name: 'WriteData',
    declaration:
      'type WriteData = { path: string; created: boolean; bytesWritten: number }; // on failure only path',
  },
  edit: {
    name: 'EditData',
    declaration:
      'type EditData = { path: string; replacements: number; replaceAll: boolean }; // on failure only path',
  },
  glob: { name: 'GlobData', declaration: 'type GlobData = { paths: string[] };' },
  grep: {
    name: 'GrepData',
    declaration:
      'type GrepData = { files: string[] } | { matches: Array<{ path: string; line: number; text: string }> } | { counts: Array<{ path: string; count: number }> }; // by output_mode; matches has no context lines',
  },
  bash: {
    name: 'BashData',
    declaration:
      'type BashData = { status: "complete"; exitCode: number | null } | { status: "background"; taskId?: string }; // whether the command finished, not r.status',
  },
  web_fetch: {
    name: 'WebFetchData',
    declaration:
      'type WebFetchData = { url: string; finalUrl?: string; httpStatus?: number; contentType?: string; bytes?: number; content: string }; // content is cut where output is; on failure { url, httpStatus?, retryAfter?: string }',
  },
  web_search: {
    name: 'WebSearchData',
    declaration:
      'type WebSearchData = Record<string, unknown>; // the search response object shown in output',
  },
  todowrite: {
    name: 'TodoWriteData',
    declaration:
      'type TodoWriteData = { total: number; active: number; completed: number; cancelled: number };',
  },
  workspace_semantic_search: {
    name: 'SemanticSearchData',
    declaration:
      'type SemanticSearchData = { revisionId: string; matches: Array<{ path: string; startLine: number; endLine: number; score: number; snippet: string }> };',
  },
  session_create: {
    name: 'SessionCreateData',
    declaration:
      'type SessionCreateData = { ok: boolean; [key: string]: unknown }; // the result object shown in output; on failure { ok: false }',
  },
  self_reminder: {
    name: 'SelfReminderData',
    declaration:
      'type SelfReminderData = { ok: true; response: Record<string, unknown> } | { ok: false };',
  },
  memory: {
    name: 'MemoryData',
    declaration:
      'type MemoryData = { ok: true; target: string; operation: string; content?: string; sizeBytes?: number; updatedAt?: string; sources?: Array<{ sourceAgent: string; content: string }>; sourceAgent?: string; name?: string; description?: string; matches?: Array<{ lineNumber: number; line: string; context?: string[]; sourceAgent?: string }>; topics?: Array<{ name: string; description: string; sizeBytes: number; updatedAt: string; sourceAgent?: string }>; replacements?: number; deleted?: boolean; matchCount?: number; topicCount?: number } | { ok: false; target: string; operation: string; code: string }; // fields by operation; run_code calls are never cut, so content and matches are whole',
  },
  ...COMPUTER_DATA_TYPES,
};

/** One type for every mavis_* tool: they all return the mavis result object. */
const MAVIS_DATA_TYPE: NativeDataType = {
  name: 'MavisData',
  declaration:
    'type MavisData = { ok: true; command: string; response: unknown } | { ok: false; command: string; error: { kind: string; message: string; [key: string]: unknown } }; // the whole result object; run_code calls are never cut',
};

/**
 * Reading declarations only; the original schema remains authoritative at
 * admission. No JSON Schema is printed: each top-level argument gets its own
 * line with its schema description as an inline comment, so a limit written
 * only there (a foreground bash timeout, the web_search freshness values)
 * still reaches the model.
 */
export function renderPtcToolSdk(
  tools: readonly RuntimeTool[],
  nativeTools: ReadonlySet<RuntimeTool> = new Set(),
): string {
  const dataType = (tool: RuntimeTool): NativeDataType | undefined => {
    if (nativeTools.has(tool)) return NATIVE_DATA_TYPES[tool.def.name];
    // A mavis_* child stands for the native mavis tool it runs as.
    const mavis = readPtcMavisChildTarget(tool)?.tool;
    return mavis && nativeTools.has(mavis) ? MAVIS_DATA_TYPE : undefined;
  };
  return [
    'type ToolResult<T = Record<string, unknown> | undefined> = {',
    '  status: "complete" | "truncated" | "resized" | "omitted" | "failed" | "unverified"; // check it first',
    '  isError: boolean; // always present; check it before using output or data',
    "  output?: string; // tool text: command output, search results, read lines with line-number prefixes (file text is data.content); on failure the tool's own error text",
    '  data: T; // native tools: the type below, {} when the call did not run or a hook changed the result; MCP: structuredContent or undefined',
    '  refs?: Array<{ uri: string; mimeType?: string }>;',
    '  // only says whether output was cut; it never contains the tool text',
    '  truncation: { truncated: boolean | "unknown"; hasMore?: boolean; nextOffset?: number; offsetUnit?: string; fullOutputPath?: string; continuationHint?: Record<string, unknown> };',
    '  error?: { code: string; message: string; retryable?: boolean; toolCallId: string; raw?: unknown }; // only when isError',
    '};',
    ...new Set(tools.flatMap((tool) => declarations(dataType(tool)))),
    'declare const tools: {',
    ...tools.flatMap((tool) => [
      ...tool.def.description.split('\n').map((line) => `  // ${line}`),
      ...toolSignature(
        tool.def.name,
        tool.def.schema,
        `Promise<ToolResult${dataType(tool) ? `<${dataType(tool)?.name}>` : ''}>`,
      ),
    ]),
    '};',
    "// Arguments are validated against each tool's schema when called; an invalid argument returns isError.",
  ].join('\n');
}

function declarations(type: NativeDataType | undefined): readonly string[] {
  return type ? [...(type.requires ?? []).flatMap(declarations), type.declaration] : [];
}

/**
 * Multi-line when the schema renders as an object with members (the same
 * members, types and order as the one-line form), each argument followed by
 * `// <its schema description>` with line breaks turned into spaces; an
 * argument without a description gets no comment. Any other schema (no
 * properties, a union, a $ref) keeps the one-line signature.
 */
function toolSignature(name: string, schema: unknown, result: string): readonly string[] {
  const members = topLevelMembers(schema);
  if (!members) return [`  ${JSON.stringify(name)}: (args: ${schemaType(schema)}) => ${result};`];
  return [
    `  ${JSON.stringify(name)}: (args: {`,
    ...members.map(
      ({ text, description }) => `    ${text}${description ? ` // ${description}` : ''}`,
    ),
    `  }) => ${result};`,
  ];
}

function topLevelMembers(schema: unknown): readonly ObjectMember[] | undefined {
  if (!isRecord(schema) || '$ref' in schema || 'const' in schema || schema.type !== 'object') {
    return undefined;
  }
  if (compositeSchemaType(schema, 0) !== undefined) return undefined;
  const members = objectMembers(schema, 0);
  return members.length > 0 ? members : undefined;
}

function schemaDescription(schema: unknown): string | undefined {
  if (!isRecord(schema) || typeof schema.description !== 'string') return undefined;
  // A line break would end the // comment early.
  return schema.description.trim().replace(/\r\n?|[\n\u2028\u2029]/gu, ' ') || undefined;
}

function schemaType(value: unknown, depth = 0): string {
  if (value === false) return 'never';
  if (!isRecord(value) || depth > 12 || '$ref' in value) return 'unknown';
  if ('const' in value) return literalType(value.const);
  return compositeSchemaType(value, depth) ?? typedSchemaType(value, depth);
}

function compositeSchemaType(value: Record<string, unknown>, depth: number): string | undefined {
  if (Array.isArray(value.enum)) return value.enum.map(literalType).join(' | ') || 'never';
  const union = value.anyOf ?? value.oneOf;
  if (Array.isArray(union)) {
    return union.map((entry) => `(${schemaType(entry, depth + 1)})`).join(' | ') || 'never';
  }
  if (Array.isArray(value.allOf)) {
    return value.allOf.map((entry) => `(${schemaType(entry, depth + 1)})`).join(' & ') || 'unknown';
  }
  if (Array.isArray(value.type)) {
    return value.type.map((type) => schemaType({ ...value, type }, depth + 1)).join(' | ');
  }
  return undefined;
}

function typedSchemaType(value: Record<string, unknown>, depth: number): string {
  switch (value.type) {
    case 'null':
      return 'null';
    case 'boolean':
    case 'string':
      return value.type;
    case 'number':
    case 'integer':
      return 'number';
    case 'array':
      return `Array<${schemaType(value.items, depth + 1)}>`;
    case 'object':
      return objectSchemaType(value, depth);
    default:
      return 'unknown';
  }
}

interface ObjectMember {
  readonly text: string;
  readonly description?: string;
}

function objectMembers(value: Record<string, unknown>, depth: number): ObjectMember[] {
  const properties = isRecord(value.properties) ? value.properties : {};
  const required = new Set(Array.isArray(value.required) ? value.required : []);
  const members: ObjectMember[] = Object.entries(properties).map(([key, schema]) => ({
    text: `${JSON.stringify(key)}${required.has(key) ? '' : '?'}: ${schemaType(schema, depth + 1)};`,
    description: schemaDescription(schema),
  }));
  if (members.length > 0 && value.additionalProperties !== false) {
    members.push({ text: '[key: string]: unknown;' });
  }
  return members;
}

function objectSchemaType(value: Record<string, unknown>, depth: number): string {
  const members = objectMembers(value, depth);
  if (members.length === 0) {
    return `Record<string, ${value.additionalProperties === false ? 'never' : schemaType(value.additionalProperties, depth + 1)}>`;
  }
  return `{ ${members.map(({ text }) => text).join(' ')} }`;
}

function literalType(value: unknown): string {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
    ? JSON.stringify(value)
    : 'unknown';
}

/**
 * Browser calling convention, only when this run_code lists Browser (native
 * `browser` or the Plugin-bound `mcp_browser`). The round trips PTC removes
 * here are a commit followed by a program that only reads its result,
 * waiting for an async list (a search suggestion), and recovering after a
 * click navigated. `observe` (declared only by the run_code Browser variant)
 * folds the read into the action call, waits for expected text and also runs
 * after a navigating click, so each becomes one program. Calls stay one at a
 * time because they share one page; the host refuses a program's remaining
 * Browser calls after one fails (BROWSER_PTC_STOPPED), and a commit stays the
 * last Browser call so its own observation is the evidence for what follows.
 */
export function browserRunCodeParagraph(childTools: readonly RuntimeTool[]): readonly string[] {
  const name = childTools.find(
    (tool) => tool.def.name === 'browser' || tool.def.name === 'mcp_browser',
  )?.def.name;
  if (!name) return [];
  return [
    `Browser: tools.${name}({ action, input, observe? }) returns the direct-call JSON in r.data.result; attached images reach you after the program. Await Browser calls one by one, never in Promise.all. Page-changing actions accept observe: { kind: "inspect" } returns fresh refs, { kind: "text", selector? } returns visible text, and waitForText waits for expected text (a search suggestion, a toast) before reading; the read lands in r.data.result.observation, so do not follow an action with a separate inspect or query. observe also runs when a click navigates (code UNEXPECTED_NAVIGATION): the observation is the new page. Put a whole bounded step in one program: fill the related fields, type a search term with observe.waitForText, click the matching option from that observation, read the form back. After one Browser call fails, the remaining Browser calls of that program are refused with BROWSER_PTC_STOPPED; check r.isError after each call and return early. An irreversible or externally visible commit (submit, send, save, pay, delete, share) is the last Browser call of its program, after the program read back what it commits; give it observe so its result already shows the outcome. Example: const f = await tools.${name}({ action: "fill", input: { ref: searchRef, text: "Ann" }, observe: { kind: "inspect", waitForText: "Ann" } }); if (f.isError) return f.error; const opt = f.data.result.observation.elements.find((e) => e.text.startsWith("Ann")); return opt ?? f.data.result.observation;`,
  ];
}

/**
 * Computer Use calling convention, only when this run_code lists computer_*.
 * They act on one shared desktop, so they run one at a time (no
 * executionMode, the scheduler serializes them) and the host refuses a
 * program's remaining Computer Use calls after one fails
 * (COMPUTER_USE_PTC_STOPPED). AX state with query is the cheap read; a
 * screenshot is attached to the outer result after the program, so it is
 * asked for only when the step needs to see the window. Taking the
 * foreground is announced to the user before the program, because nothing
 * inside a program reaches the user. An irreversible action ends its program
 * so the next decision is made on its verified effect.
 */
export function computerUseRunCodeParagraph(childTools: readonly RuntimeTool[]): readonly string[] {
  if (!childTools.some((tool) => tool.def.name.startsWith('computer_'))) return [];
  return [
    'Computer Use: await computer_* calls one by one, never in Promise.all; they act on one shared desktop. Put one bounded step in one program: find the window, read its state, act, then read it back to verify. After one Computer Use call fails, the remaining Computer Use calls of that program are refused with COMPUTER_USE_PTC_STOPPED; check r.isError after each call and return early. Read AX state, narrowed with query, by default; pass include_screenshot: true only when you need to see the window, and the screenshot reaches you after the program. When a step must bring an app to the foreground, tell the user before running the program. An irreversible action (send, submit, delete, pay) is the last Computer Use call of its program; verify it in the next program. Example: const s = await tools.computer_app_state({ pid, window_ref, query: "Search" }); if (s.isError) return s.error; return s.output;',
  ];
}

/**
 * mavis_* result convention, only when this run_code lists them: what the
 * mavis tool's OUTPUT section says, once here instead of in every mavis_*
 * comment of the SDK below.
 */
export function mavisRunCodeParagraph(childTools: readonly RuntimeTool[]): readonly string[] {
  return childTools.some((tool) => isPtcMavisChildToolName(tool.def.name))
    ? [PTC_MAVIS_RUN_CODE_NOTE]
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
