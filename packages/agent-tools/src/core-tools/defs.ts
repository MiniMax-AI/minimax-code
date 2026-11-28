/**
 * Definitions of the six core tools (read / write / edit / bash / grep / glob).
 * Moved verbatim from `desktop/builtin-defs.ts`, which re-exports them; the
 * names keep their historical `Local*` prefix so existing imports stay valid.
 */
import { Clone, Type, type Static } from '@sinclair/typebox';

import type { ToolDefinition } from '@mavis/agent-core/tools';

import { BashDescriptionSchema } from '../desktop/local-bash-input.js';
import {
  DEFAULT_FOREGROUND_BASH_TIMEOUT_SECONDS,
  MAX_FOREGROUND_BASH_TIMEOUT_SECONDS,
  MAX_MANAGED_BASH_TIMEOUT_SECONDS,
} from '../desktop/local-bash-timing.js';

export const LocalReadToolDef = {
  name: 'read',
  executionMode: 'parallel',
  // Read guidance and parameter descriptions stay aligned with CloudReadToolDef;
  // only the filesystem scope differs. read-defs-contract tests enforce parity.
  description:
    'Reads a file from the local filesystem.\n\n' +
    '- `path` can be workspace-relative or absolute; the desktop permission gate reviews it.\n' +
    '- Text reads return up to 2000 lines, subject to byte limits. Use `offset` and `limit` to read only the part you need.\n' +
    '- Text results include line numbers starting at 1.\n' +
    "- Follow a truncated result's continuation instructions only if you need the omitted text. When `next_offset` is provided, use that exact value with the same `path`.\n" +
    '- Reads images (jpg, png, gif, webp) and presents them visually.\n' +
    '- Reads PDFs via `pages` (required for PDFs over 10 pages; max 20 pages/request), and Jupyter notebooks (.ipynb) as cells with outputs.\n' +
    '- Reads videos (mp4, avi, mov, mkv) when the active model supports video.\n' +
    '- Directories, missing files, unsupported binary files, and empty files return an error or system reminder.\n' +
    '- Reuse current file content already in context. Re-read when it may be stale or to resolve uncertain content or failed matches; do not re-read solely to confirm a successful edit/write.',
  schema: Type.Object({
    path: Type.String({ description: 'Workspace-relative or absolute local file path.' }),
    offset: Type.Optional(
      Type.Number({
        description: 'Starting line for text files (1-indexed).',
      }),
    ),
    limit: Type.Optional(
      Type.Number({
        description: 'Maximum number of text lines to read.',
      }),
    ),
    pages: Type.Optional(
      Type.String({
        description:
          'Page range for PDF files (e.g., "1-5", "3", "10-20"). Only applicable to PDF files. Maximum 20 pages per request. Text offsets and limits are ignored for PDFs.',
      }),
    ),
  }),
} as const satisfies ToolDefinition;
export type LocalReadToolInput = Static<typeof LocalReadToolDef.schema>;

export const LocalWriteToolDef = {
  name: 'write',
  executionMode: 'sequential',
  // Usage guidance stays aligned with CloudWriteToolDef; path scopes differ.
  description:
    'Writes a file to the local filesystem, overwriting if it exists and creating parent directories as needed.\n\n' +
    '- `path` can be workspace-relative or absolute; the desktop permission gate reviews it.\n' +
    '- Use for new files or complete rewrites; use `edit` for partial changes.\n' +
    '- Read existing content before overwriting it. Provide the complete replacement content.\n' +
    '- Content is written literally, including line endings.\n' +
    '- On success, reports the number of bytes written and whether an existing file was overwritten.\n' +
    '- Do not proactively create documentation files unless explicitly requested.',
  schema: Type.Object({
    path: Type.String({ description: 'Workspace-relative or absolute local file path.' }),
    content: Type.String({ description: 'Full file content to write.' }),
  }),
} as const satisfies ToolDefinition;
export type LocalWriteToolInput = Static<typeof LocalWriteToolDef.schema>;

const LocalEditToolSchema = Type.Object(
  {
    file_path: Type.String({ description: 'The absolute path to the file to modify.' }),
    old_string: Type.String({ description: 'The text to replace.' }),
    new_string: Type.String({
      description: 'The text to replace it with (must be different from old_string).',
    }),
    replace_all: Type.Optional(
      Type.Boolean({
        description: 'Replace all occurrences of old_string. Default is false.',
        default: false,
      }),
    ),
  },
  { additionalProperties: false },
);

export const LocalEditToolDef = {
  name: 'edit',
  executionMode: 'sequential',
  // Usage guidance stays aligned with CloudEditToolDef; path scopes differ.
  description:
    'Performs exact string replacement in a local file.\n\n' +
    '- `file_path` must be an absolute local path; the desktop permission gate reviews it.\n' +
    '- Use current file content from `read` or your own successful edit/write. Read the file first if that content is unavailable or may be stale.\n' +
    '- `old_string` must be non-empty and match the file exactly, including whitespace and indentation. It must be unique unless `replace_all` is true; otherwise the edit fails.\n' +
    '- `replace_all: true` replaces every occurrence instead.',
  schema: LocalEditToolSchema,
} as const satisfies ToolDefinition;
export type LocalEditToolInput = Static<typeof LocalEditToolDef.schema>;

export const LocalBashToolDef = {
  name: 'bash',
  executionMode: 'sequential',
  description: [
    'Executes a shell command and returns its output.',
    '',
    '- Each call starts in the session workspace. Changes to the working directory and shell state (variables and functions) do not persist between calls. If a command requires a different working directory, change directories within the same call.',
    '- Use dedicated `read`, `write`, `edit`, `grep`, and `glob` tools for file operations. Do not use shell commands for file reading, searching, or modification unless the user explicitly requests it or you have verified that the dedicated tools cannot perform the required operation. Use `bash` for processes, git, package managers, builds, tests, and pipelines.',
    '- The shell is non-interactive: no TTY or stdin prompts. For commands that require interaction, check `--help` for non-interactive options before asking the user to run them. Leave physical authorization (OAuth consent, MFA, hardware keys) to the user.',
    '',
    '# Git',
    '- Interactive flags (`-i`, e.g. `git rebase -i`, `git add -i`) are not supported in this environment.',
    '- Use the `gh` CLI for GitHub operations (PRs, issues, API).',
    '- Commit or push only when the user asks.',
  ].join('\n'),
  schema: Type.Object({
    command: Type.String({
      description: 'The command to execute',
    }),
    description: BashDescriptionSchema,
    timeout: Type.Optional(
      Type.Number({
        exclusiveMinimum: 0,
        description:
          'Total command timeout in seconds. Foreground-only: default 120s, max 300s. Foreground with automatic backgrounding: default/max 3600s total, including foreground time. Explicit background: uses the specified timeout, or a 1-hour runtime limit if omitted. Backgrounding does not reset the timeout.',
      }),
    ),
    run_in_background: Type.Optional(
      Type.Boolean({
        description:
          'Start in the background and return a task id immediately. Foreground commands may also return a task id after 60s without restarting the process.',
      }),
    ),
  }),
} as const satisfies ToolDefinition;
export type LocalBashToolInput = Static<typeof LocalBashToolDef.schema>;

export const LocalGrepToolDef = {
  name: 'grep',
  executionMode: 'parallel',
  description:
    'Search local file contents using ripgrep. ALWAYS use this tool for content search — NEVER invoke `grep`/`rg` via bash (that would bypass filtering and permission review). `pattern` is a raw ripgrep regular expression by default; use `literal=true` for exact code or text. Returns only the paths of matching files by default (`output_mode="files_with_matches"`) — use it to locate relevant files, then use `read` to view their contents and `edit` to change them. Set `output_mode="content"` to get matching lines (supports `context` and paging) or `"count"` for per-file match counts. Project ignore rules and common dependency, environment, build, and cache directories are excluded by default; use a narrow `path` when explicitly inspecting an artifact directory. Sensitive files (.env, keys, ssh configs) remain excluded. `path` may be workspace-relative or absolute and is reviewed by the desktop permission gate. Results are truncated at `limit`. When a result provides `next_offset` and the omitted remainder is needed, continue with that exact value and preserve the same search arguments and `output_mode`.',
  schema: Type.Object({
    pattern: Type.String({
      description:
        'Pattern is a raw ripgrep regular expression by default: `|`, `(`, `[`, `{`, `.`, `?`, `*`, and `+` are operators and literal uses must be escaped. For example, search for the literal code `functionCall(` with `functionCall\\(`. For one exact code or text string, set `literal=true`; then `|` is literal text, not alternation. Do not add surrounding quotes.',
    }),
    path: Type.Optional(
      Type.String({ description: 'Directory or file to search. Defaults to the workspace.' }),
    ),
    glob: Type.Optional(
      Type.String({ description: "File-glob filter, e.g. '*.ts' or '**/*.spec.ts'." }),
    ),
    output_mode: Type.Optional(
      Type.Union(
        [Type.Literal('files_with_matches'), Type.Literal('content'), Type.Literal('count')],
        {
          description:
            'Output shape: "files_with_matches" (default) lists matching file paths only; "content" shows matching lines with line numbers; "count" shows per-file match counts.',
        },
      ),
    ),
    ignoreCase: Type.Optional(Type.Boolean({ description: 'Case-insensitive search.' })),
    literal: Type.Optional(
      Type.Boolean({
        description:
          'Treat the entire pattern as one literal string instead of regex. Use for exact code or text; regex operators such as `|` are disabled.',
      }),
    ),
    context: Type.Optional(
      Type.Number({
        description:
          'Lines of context before and after each match. Only applies to output_mode="content".',
      }),
    ),
    limit: Type.Optional(Type.Number({ description: 'Maximum number of results to return.' })),
    offset: Type.Optional(
      Type.Number({
        description:
          'Skip the first N results (matches in content mode, files/entries otherwise). Use with `limit` to page.',
      }),
    ),
  }),
} as const satisfies ToolDefinition;
export type LocalGrepToolInput = Static<typeof LocalGrepToolDef.schema>;

export const LocalGlobToolDef = {
  name: 'glob',
  executionMode: 'parallel',
  description:
    'Search for local files by glob pattern using ripgrep. ALWAYS use this tool to find files by name/pattern — NEVER use `find`/`ls -R` via bash (that would bypass filtering and permission review). Project ignore rules plus common dependency, environment, build, cache, binary, and media noise are excluded from broad scans by default. Use an explicit extension glob or narrow path/pattern prefix to find intentionally targeted media or binary files. Set include_ignored=true only with a narrow path/pattern prefix or exact filename when inspecting project-ignored artifacts. Sensitive files (.env, keys, ssh configs) remain excluded. `path` may be workspace-relative or absolute and is reviewed by the desktop permission gate. Returns paths relative to the search root, with a 200-path default limit; pass sort="modified" to list recently changed files first. When a result provides `next_offset` and the omitted remainder is needed, continue with that exact value and preserve the same search arguments.',
  schema: Type.Object({
    pattern: Type.String({ description: "Glob pattern, e.g. '**/*.ts' or 'src/**/*.tsx'." }),
    path: Type.Optional(Type.String({ description: 'Search root. Defaults to the workspace.' })),
    include_ignored: Type.Optional(
      Type.Boolean({
        description:
          'Include files excluded by project ignore rules. Requires a narrow path, pattern prefix, or exact filename and is only for explicit artifact inspection; sensitive-file exclusions still apply.',
      }),
    ),
    limit: Type.Optional(Type.Number({ description: 'Maximum number of file paths to return.' })),
    offset: Type.Optional(
      Type.Number({
        description:
          'Skip the first N matching file paths. Use the returned next_offset with the same search arguments to continue.',
      }),
    ),
    sort: Type.Optional(
      Type.Union([Type.Literal('none'), Type.Literal('modified')], {
        description:
          'Result ordering: "none" (default, fastest) or "modified" (recently changed first — useful when results may be truncated).',
      }),
    ),
  }),
} as const satisfies ToolDefinition;
export type LocalGlobToolInput = Static<typeof LocalGlobToolDef.schema>;

/**
 * Bash schema for one Turn: `run_in_background` only when background execution
 * is available, and timeout / background descriptions matching the active timing
 * policy. `autoBackground` says whether unfinished foreground commands move to
 * the background; hosts with explicit background only pass `false`.
 * `backgroundTimeoutSeconds` is a host whose explicit background commands run
 * for that long by default and at most; absent keeps the 1-hour default.
 * `managedTimeoutSeconds` is the default and cap of a foreground command that
 * may move to the background; absent keeps the desktop 3600s.
 * `maxForegroundTimeoutSeconds` is the most a host runs one foreground command;
 * a value below the ordinary 300s replaces it in the text.
 */
export function createBashToolSchema(
  background: boolean,
  autoBackground = background,
  backgroundTimeoutSeconds?: number,
  managedTimeoutSeconds = MAX_MANAGED_BASH_TIMEOUT_SECONDS,
  maxForegroundTimeoutSeconds = MAX_FOREGROUND_BASH_TIMEOUT_SECONDS,
) {
  const base = Clone(LocalBashToolDef.schema);
  const schema = background ? base : Type.Omit(base, ['run_in_background']);
  schema.properties.timeout.description = bashTimeoutDescription(
    background,
    autoBackground,
    backgroundTimeoutSeconds,
    managedTimeoutSeconds,
    Math.min(maxForegroundTimeoutSeconds, MAX_FOREGROUND_BASH_TIMEOUT_SECONDS),
  );
  if (background && !autoBackground) {
    base.properties.run_in_background.description =
      'Start in the background and return a task id immediately.';
  }
  return schema;
}

function bashTimeoutDescription(
  background: boolean,
  autoBackground: boolean,
  backgroundTimeoutSeconds: number | undefined,
  managedTimeoutSeconds: number,
  foregroundLimitSeconds: number,
): string {
  const foreground = `Foreground: default ${DEFAULT_FOREGROUND_BASH_TIMEOUT_SECONDS}s; values above ${foregroundLimitSeconds}s are capped.`;
  const explicit =
    backgroundTimeoutSeconds === undefined
      ? 'Explicit background: uses the specified timeout, or a 1-hour runtime limit if omitted.'
      : `Explicit background: default ${backgroundTimeoutSeconds}s; values above ${backgroundTimeoutSeconds}s are capped.`;
  if (!background) return `Timeout in seconds. ${foreground}`;
  if (!autoBackground) return `Total command timeout in seconds. ${foreground} ${explicit}`;
  return `Total command timeout in seconds. Foreground with automatic backgrounding: default/max ${managedTimeoutSeconds}s, including foreground time. ${explicit}`;
}
