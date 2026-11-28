/**
 * Builtin tool 定义 —— LLM 面向的 6 个工具的 (name, description, schema)。
 *
 * Schema 字段镜像 `@earendil-works/pi-coding-agent` 中 read / write / edit /
 * bash / grep 的对应 schema,这样无论用 pi builtin 还是 host 实现,LLM 看到的
 * 工具入参形状都一致。`find` / `ls` 不在此列 —— 整个体系不暴露这两个工具给
 * LLM(用 grep / glob 替代)。`glob` 没有 pi 同名 builtin,但对标 pi find
 * (按 glob 模式列文件)。
 *
 * `read / write / edit / bash` 这四个跟 pi builtin 同名,PiTurnRunner 在
 * 装配阶段会自动 fallback 到 pi 原生 `createXxxTool(cwd)`(走本地 fs)当
 * 它们没有被显式绑定;`grep / glob` 没有 fallback,必须显式注册。
 */

import { Type, type Static } from '@sinclair/typebox';

import { prepareEditArguments } from './edit-prepare-arguments.js';
import type { ToolDefinition } from './types.js';

// ─── read ───────────────────────────────────────────────────────────────

export const ReadToolDef = {
  name: 'read',
  executionMode: 'parallel',
  description:
    'Read the contents of a file. Supports text, images (jpg, png, gif, webp), and video (mp4, avi, mov, mkv) when the active model declares video support; otherwise video files are read as a text-only placeholder. Output is truncated to a maximum number of lines/bytes — use `offset` and `limit` to page through long files.',
  schema: Type.Object({
    path: Type.String({ description: 'Absolute or workspace-relative file path.' }),
    offset: Type.Optional(
      // 1-indexed to match the pi engine (`startLine = offset - 1`); this
      // was mistakenly documented as 0-based before, which made models read
      // off by one line. Keep in lockstep with Local/CloudReadToolDef.
      Type.Number({
        description:
          'The line number to start reading from (1-indexed). Only provide if the file is too large to read at once.',
      }),
    ),
    limit: Type.Optional(
      Type.Number({
        description:
          'The number of lines to read. Only provide if the file is too large to read at once.',
      }),
    ),
  }),
} as const satisfies ToolDefinition;
export type ReadToolInput = Static<typeof ReadToolDef.schema>;

// ─── write ──────────────────────────────────────────────────────────────

export const WriteToolDef = {
  name: 'write',
  executionMode: 'sequential',
  // Guidance sentences (prefer-edit, read-before-overwrite, no line-number
  // prefixes, no unsolicited docs) are kept in sync with Local/Cloud
  // WriteToolDef. The wrapper-only result contract (true byte count,
  // overwrote suffix) is intentionally absent: hosts consuming this base
  // def fall back to the pi builtin, which does not implement it.
  description:
    'Write content to a file. Creates the file if it does not exist, overwrites it if it does, and creates parent directories as needed. ' +
    'Prefer the edit tool for modifying existing files; only use write for new files or complete rewrites. ' +
    'If the file already exists, read it first before overwriting; writing replaces the entire previous content. ' +
    'Content is written literally, including line endings; NEVER include the line-number prefixes shown by the read tool. ' +
    'Do not proactively create documentation files (*.md, README) unless explicitly requested.',
  schema: Type.Object({
    path: Type.String({ description: 'Absolute or workspace-relative file path.' }),
    content: Type.String({ description: 'Full file content to write.' }),
  }),
} as const satisfies ToolDefinition;
export type WriteToolInput = Static<typeof WriteToolDef.schema>;

// ─── edit ───────────────────────────────────────────────────────────────

const EditToolSchema = Type.Object({
  path: Type.String({ description: 'Absolute or workspace-relative file path.' }),
  edits: Type.Array(
    Type.Object({
      oldText: Type.String({ description: 'Exact existing text to replace.' }),
      newText: Type.String({ description: 'Replacement text.' }),
    }),
    { description: 'Ordered list of replacements; all must succeed.' },
  ),
});

export const EditToolDef = {
  name: 'edit',
  executionMode: 'sequential',
  // Wording of everything from "Every `edits[].oldText`" onward is kept in
  // lockstep with Local/CloudEditToolDef BY HAND — there is no
  // edit-defs-contract test yet (only read/write have one), and the three
  // edit schemas cannot be made identical (this def is pi-shaped
  // {path, edits[]}, the wrappers are cc-shaped {file_path, old_string,...}).
  // The compatibility shim is shared (edit-prepare-arguments.ts).
  description:
    'Edit a single file using exact text replacement. ' +
    'Every `edits[].oldText` must match a unique, non-overlapping region of the original file, and all edits in one call apply atomically. ' +
    'ALWAYS read the file with the read tool right before editing; do not construct oldText from memory, stale context, or guesses. ' +
    'Copy oldText exactly from the file, including whitespace and indentation, and NEVER include the line-number prefixes shown by the read tool. ' +
    'Keep each oldText as small as possible while still unique; do not pad it with large unchanged regions. ' +
    'To change multiple places in one file, use a single call with multiple entries in edits[] instead of consecutive edit calls; each oldText is matched against the original file content, so edits must not overlap. ' +
    'After a successful edit, re-read the file before editing it again.',
  schema: EditToolSchema,
  prepareArguments: prepareEditArguments,
} as const satisfies ToolDefinition;
export type EditToolInput = Static<typeof EditToolDef.schema>;

// ─── bash ───────────────────────────────────────────────────────────────

export const BashToolDef = {
  name: 'bash',
  executionMode: 'sequential',
  description:
    'Execute a bash command. Returns combined stdout + stderr after the command exits. Supports an optional timeout in seconds. ' +
    'IMPORTANT: each invocation is stateless with respect to the working directory — every command starts from the same fixed default directory in a fresh shell, NOT from where a previous command left off. ' +
    'A `cd` (e.g. `cd ..`) only affects that single command and does NOT change the cwd of the next call. ' +
    'To operate in a different directory, scope it within the same call (e.g. `cd subdir && some-command`) or use absolute paths.',
  schema: Type.Object({
    command: Type.String({ description: 'Shell command line to execute.' }),
    timeout: Type.Optional(
      Type.Number({ description: 'Timeout in seconds. Default is host-defined.' }),
    ),
  }),
} as const satisfies ToolDefinition;
export type BashToolInput = Static<typeof BashToolDef.schema>;

// ─── grep ───────────────────────────────────────────────────────────────

export const GrepToolDef = {
  name: 'grep',
  executionMode: 'parallel',
  description:
    'Search file contents for a regex pattern using ripgrep. Respects .gitignore. Output is truncated to a maximum number of matches/bytes; long lines are clipped.',
  schema: Type.Object({
    pattern: Type.String({ description: 'Regex pattern (or literal if `literal=true`).' }),
    path: Type.Optional(
      Type.String({ description: 'Directory or file to search. Defaults to cwd.' }),
    ),
    glob: Type.Optional(
      Type.String({ description: "File-glob filter, e.g. '*.ts' or '**/*.spec.ts'." }),
    ),
    ignoreCase: Type.Optional(Type.Boolean({ description: 'Case-insensitive search.' })),
    literal: Type.Optional(
      Type.Boolean({ description: 'Treat pattern as literal string instead of regex.' }),
    ),
    context: Type.Optional(
      Type.Number({ description: 'Lines of context before and after each match.' }),
    ),
    limit: Type.Optional(Type.Number({ description: 'Maximum number of matches to return.' })),
  }),
} as const satisfies ToolDefinition;
export type GrepToolInput = Static<typeof GrepToolDef.schema>;

// ─── glob ───────────────────────────────────────────────────────────────

export const GlobToolDef = {
  name: 'glob',
  executionMode: 'parallel',
  description:
    'Search for files by glob pattern. Respects .gitignore. Returns file paths relative to the search root, truncated when results exceed the limit.',
  schema: Type.Object({
    pattern: Type.String({ description: "Glob pattern, e.g. '**/*.ts' or 'src/**/*.tsx'." }),
    path: Type.Optional(Type.String({ description: 'Search root. Defaults to cwd.' })),
    limit: Type.Optional(Type.Number({ description: 'Maximum number of file paths to return.' })),
  }),
} as const satisfies ToolDefinition;
export type GlobToolInput = Static<typeof GlobToolDef.schema>;

// ─── todowrite ──────────────────────────────────────────────────────────

/**
 * `todowrite` —— session-scoped TODO list 工具,与 Pi runtime /
 * reference CLI 的 `todowrite` / `TodoWrite` 保持兼容 (status/priority
 * 用 string 不用 enum)。
 *
 * 两条链路 (`daemon → ui` 与 `cloud-runtime → archon-server → archon-biz →
 * ui`) 共用 `packages/ui` 的 `MsgType.SystemEvent` + `eventType:'todo_updated'`
 * 分支渲染。实现端各自负责构造该事件:
 *   - cloud-runtime `CloudTodoWriteTool`:在 tool execute 内通过
 *     turn-event-context 注入一条 `stream.resp` RuntimeEvent(payload 是
 *     RespData with SystemEvent),同时调 `updateTodoState` 喂 SR 状态。
 *   - daemon 本地链路:`framework-adapter/todo-extractor` 从 tool_call args
 *     抽 todos,`ResponseBroadcaster.emitTodoUpdated` 合成 SSE 注入。
 */
export const TodoWriteToolDef = {
  name: 'todowrite',
  executionMode: 'sequential',
  description:
    'Create or update a structured task list for a complex coding session. Use it for multi-step work or explicit user task lists; skip it for single, trivial, or purely conversational requests. Keep exactly one task in_progress and update statuses as work progresses.',
  schema: Type.Object({
    todos: Type.Array(
      Type.Object({
        content: Type.String({ description: 'Brief description of the task' }),
        status: Type.String({
          description: 'Current status of the task: pending, in_progress, completed, cancelled',
        }),
        priority: Type.String({
          description: 'Priority level of the task: high, medium, low',
        }),
      }),
      { description: 'The updated todo list' },
    ),
  }),
} as const satisfies ToolDefinition;
export type TodoWriteToolInput = Static<typeof TodoWriteToolDef.schema>;

// ─── task ───────────────────────────────────────────────────────────────

/**
 * `task` —— Pi runtime / reference-CLI-compatible sub-agent delegation tool.
 * The local runtime supports synchronous one-shot sub-agent calls in this phase,
 * so the description omits background/resume/task_id guidance.
 *
 * Schema is exactly 3 required string fields, matching legacy local runtime's runtime
 * shape after stripping background/model overrides:
 *   - `description`: short 3-5 word label
 *   - `prompt`: the actual task prompt for the sub-agent
 *   - `subagent_type`: the requested sub-agent name (resolver looks this up)
 *
 * `additionalProperties:false` is intentionally NOT set — matches existing
 * builtin-defs convention and pi/typebox silently drops unknown fields.
 */
export const TASK_TOOL_DESCRIPTION = `Launch a new agent to handle complex, multistep tasks autonomously.

Use this for broad research, parallelizable investigation, or delegated implementation. Do not use it for targeted file reads, grep-style code searches, or work that is simpler to do directly.

Each invocation is a stateless, one-shot task. The sub-agent's result is returned only to you, so summarize any user-visible outcome yourself.`;

export const TaskToolDef = {
  name: 'task',
  executionMode: 'sequential',
  description: TASK_TOOL_DESCRIPTION,
  schema: Type.Object({
    description: Type.String({
      description: 'A short (3-5 words) description of the task',
    }),
    prompt: Type.String({
      description: 'The task for the agent to perform',
    }),
    subagent_type: Type.String({
      description: 'The type of specialized agent to use for this task',
    }),
  }),
} as const satisfies ToolDefinition;
export type TaskToolInput = Static<typeof TaskToolDef.schema>;
