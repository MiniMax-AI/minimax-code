/**
 * CoreGlobTool —— `glob` 工具的 host 中立实现（desktop LocalGlobTool 是其薄包装，
 * 对应 cloud/cloud-glob.ts）。ripgrep、realpath 与 stat 走 CoreToolHost 端口。
 *
 * `rg --files` 以 ignore-aware 方式枚举文件，用户 glob 在 runner 流内匹配；
 * 编排同 local-grep.ts，argv 组装是本文件导出的无 IO 纯函数。
 *
 * Hardening（对齐 cloud）：
 * - shared 敏感 deny-list 以 `--glob=!…` 追加（P0-2）
 * - pattern 不进入 rg argv，`-` 开头 pattern 不可能被解析成 rg flag（P0-1）
 *
 * sort（P1-4）：可选 `sort="modified"` 映射 rg `--sortr=modified`（新→旧）。
 * 默认不排序——rg `--sort*` 会禁用并行，大目录变慢；结果被 limit 截断时在
 * notice 里提示可用排序让「留下的」更可能相关。
 */

import type { ToolExecutionContext, ToolImpl, ToolResult } from '@mavis/agent-core/tools';

import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

import {
  defaultScanNoiseDirectoriesInSearchRoot,
  defaultScanExcludeArgs,
  filterGlobPaths,
  findGlobMagicIndex,
  globToPathRegex,
  isBroadFileScan,
  isNarrowSearchRoot,
  resolveGlobStaticSearchRoot,
} from '../shared/rg-scan-policy.js';
import { withCompatibleGlobToolResponse } from '../plugin-hooks/vendor-tool-response.js';
import { isSensitiveSearchRoot, sensitiveExcludeArgs } from '../desktop/local-sensitive.js';
import { createDesktopOutputContinuation } from '../desktop/output-limit.js';
import { withDesktopCompletenessReport } from '../desktop/ptc-result-projection.js';
import { LocalGlobToolDef, type LocalGlobToolInput } from './defs.js';
import type { CoreSearchToolOptions } from './grep-tool.js';
import { resolveSearchRoot, textResult } from './paths.js';
import type { CoreRgOptions, CoreToolHost } from './ports.js';

const DEFAULT_GLOB_LIMIT = 200;

function isExactFilePattern(pattern: string): boolean {
  const normalized = pattern.replaceAll('\\', '/');
  return (
    findGlobMagicIndex(normalized) < 0 &&
    normalized.length > 0 &&
    normalized !== '.' &&
    normalized !== '..' &&
    !normalized.endsWith('/')
  );
}

// ─── argv 组装（纯函数） ────────────────────────────────────────────────

export type GlobArgsInput = Pick<LocalGlobToolInput, 'pattern' | 'sort' | 'include_ignored'> & {
  broadFileScan?: boolean;
  includeDirectoryNoise?: boolean;
  allowedDirectoryNoise?: readonly string[];
};

export function buildGlobArgs(input: GlobArgsInput): string[] {
  const broadFileScan = input.broadFileScan ?? isBroadFileScan(input.pattern);
  return [
    '--no-config',
    '--no-messages',
    '--files',
    '--hidden',
    // Respect project / Git ignore rules by default so generated artifacts,
    // dependency trees, and local environments do not flood project scans.
    ...(input.include_ignored ? ['--no-ignore'] : []),
    // Newest-first so a truncated page keeps recently changed (likely
    // relevant) files. Off by default: rg --sort* disables parallelism.
    ...(input.sort === 'modified' ? ['--sortr=modified'] : []),
    // Positive rg globs override ignore rules when they match an ignored file
    // or directory. Enumerate the ignore-aware working set and filter the
    // runner stream before unmatched paths can consume the stdout byte cap.
    ...defaultScanExcludeArgs({
      broadFileScan,
      includeDirectoryNoise: input.includeDirectoryNoise,
      allowedDirectoryNoise: input.allowedDirectoryNoise,
    }),
    // Keep the security deny-list last so later scan-policy changes cannot
    // accidentally re-include sensitive paths.
    ...sensitiveExcludeArgs(),
  ];
}

// ─── 绝对路径 pattern 处理（CC extractGlobBaseDirectory parity） ─────────
//
// rg --glob 只匹配相对路径：模型传 `/Users/x/src/**/*.ts` 会静默零结果。
// 把 pattern 的静态前缀提取为搜索根、剩余部分作相对 pattern。

export function splitAbsoluteGlob(pattern: string): { root?: string; pattern: string } {
  if (!isAbsolute(pattern)) return { pattern };
  const magicIndex = findGlobMagicIndex(pattern);
  if (magicIndex < 0) {
    // Literal absolute path: search its directory for its basename.
    return { root: dirname(pattern), pattern: basename(pattern) };
  }
  const prefix = pattern.slice(0, magicIndex);
  const cut = Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf('\\'));
  if (cut <= 0) return { root: '/', pattern: pattern.slice(1) };
  let root = prefix.slice(0, cut);
  // Windows drive root: "C:" means "cwd on drive C" (relative) — force "C:/".
  if (/^[A-Za-z]:$/.test(root)) root += '/';
  return { root, pattern: pattern.slice(cut + 1) };
}

// ─── 工具编排 ──────────────────────────────────────────────────────────

export class CoreGlobTool<Ctx extends ToolExecutionContext = ToolExecutionContext>
  implements ToolImpl<typeof LocalGlobToolDef.schema, Ctx>
{
  private readonly rgOptions: Pick<CoreRgOptions, 'maxStdoutBytes' | 'timeoutMs' | 'killGraceMs'>;

  constructor(
    private readonly workspaceRoot: string,
    private readonly host: CoreToolHost,
    options: CoreSearchToolOptions = {},
  ) {
    this.rgOptions = options.rgOptions ?? {};
  }

  async execute(
    _ctx: Ctx,
    input: LocalGlobToolInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const startedAt = Date.now();
    if (!input.pattern) throw new Error('glob pattern is required');
    const limit = Math.max(1, Math.floor(input.limit ?? DEFAULT_GLOB_LIMIT));
    const offset = input.offset && input.offset > 0 ? Math.floor(input.offset) : 0;
    const split = splitAbsoluteGlob(input.pattern);
    const patternRoot = split.root;
    let effectivePattern = split.pattern;
    // The permission gate reviews `input.path` — an absolute pattern is only
    // a convenience spelling and MUST NOT widen the approved scope. Compare
    // via realpath so a workspace-internal symlink pointing outside
    // (workspace/link -> /etc) cannot smuggle the search root out (same
    // approach as cloud's assertWithinWorkspace). Escaping roots are
    // rejected and routed through `path` (which the gate audits).
    const base = resolveSearchRoot(this.workspaceRoot, input.path);
    let searchRoot = base;
    if (patternRoot) {
      let baseReal: string;
      let patternRootReal: string;
      try {
        baseReal = await this.host.fs.realpath(base);
        patternRootReal = await this.host.fs.realpath(resolve(patternRoot));
      } catch {
        throw new Error(`glob path does not exist: ${input.path ?? patternRoot}`);
      }
      const rel = relative(baseReal, patternRootReal);
      const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
      if (!inside) {
        throw new Error(
          `glob absolute pattern escapes the approved search path (${base}); pass the directory via "path" so the permission gate can review it`,
        );
      }
      // rg always runs from the reviewed base — running from the pattern's
      // subdirectory would return paths relative to that subdirectory, which
      // follow-up read/edit would then resolve against the base and hit the
      // wrong files. Fold the subdirectory back into the glob instead.
      searchRoot = baseReal;
      if (rel !== '') {
        effectivePattern = `${rel.split('\\').join('/')}/${effectivePattern}`;
      }
    }
    // Clear error for a missing path — spawn's cwd ENOENT would otherwise
    // surface as a misleading "ripgrep binary not found".
    let rootStats;
    try {
      rootStats = await this.host.fs.stat(searchRoot);
    } catch {
      throw new Error(`glob path does not exist: ${input.path ?? searchRoot}`);
    }
    if (!rootStats.isDirectory()) {
      throw new Error(`glob path must be a directory: ${input.path ?? searchRoot}`);
    }
    if (await isSensitiveSearchRoot(searchRoot, (path) => this.host.fs.realpath(path))) {
      return reportGlob(
        withCompatibleGlobToolResponse(textResult(LocalGlobToolDef.name, 'No files matched'), {
          durationMs: Date.now() - startedAt,
          filenames: [],
          truncated: false,
          totalMatches: 0,
          countIsComplete: true,
        }),
        [],
      );
    }
    const requestedRoot = resolveGlobStaticSearchRoot(effectivePattern, searchRoot);
    const narrowSearchRoot = await isNarrowSearchRoot(requestedRoot, this.workspaceRoot, (path) =>
      this.host.fs.realpath(path),
    );
    const exactFilePattern = isExactFilePattern(effectivePattern);
    const explicitIgnoredScope = narrowSearchRoot || exactFilePattern;
    if (input.include_ignored && !explicitIgnoredScope) {
      throw new Error(
        'include_ignored requires a narrow path, pattern prefix, or exact filename; narrow the search scope before inspecting ignored artifacts',
      );
    }
    const broadFileScan = isBroadFileScan(effectivePattern) && !narrowSearchRoot;
    const allowedDirectoryNoise = defaultScanNoiseDirectoriesInSearchRoot(
      requestedRoot,
      searchRoot,
    );
    const result = await this.host.runRg(
      buildGlobArgs({
        pattern: effectivePattern,
        ...(input.sort ? { sort: input.sort } : {}),
        ...(input.include_ignored ? { include_ignored: true } : {}),
        broadFileScan,
        includeDirectoryNoise: Boolean(
          input.include_ignored && narrowSearchRoot && !exactFilePattern,
        ),
        allowedDirectoryNoise,
      }),
      searchRoot,
      {
        ...this.rgOptions,
        stdoutLineRegex: globToPathRegex(effectivePattern),
        maxStdoutLines: offset + limit + 1,
        ...(signal ? { signal } : {}),
      },
    );
    if (result.timedOut) throw new Error('glob timed out');
    // rg --files: exit 1 = no files matched (NOT an error), 2 = error. A
    // byte-cap kill ends the child via signal (exitCode null) — that is a
    // truncation, not a failure: fall through and list the partial output.
    if (result.exitCode !== 0 && result.exitCode !== 1 && !result.stdoutTruncated) {
      const reason = result.stderr.trim() || `ripgrep exited with code ${result.exitCode}`;
      throw new Error(`glob failed: ${reason}`);
    }

    const discoveredLines = result.stdout
      .split('\n')
      .map((line) => line.replace(/\r$/, '').trim())
      .filter((line) => line.length > 0);
    const allLines = filterGlobPaths(discoveredLines, effectivePattern);
    const lines = allLines.slice(offset, offset + limit);
    const truncated = allLines.length > offset + lines.length || result.stdoutTruncated;
    let text =
      lines.length > 0
        ? lines.join('\n')
        : offset > 0
          ? `No more files matched at offset ${offset}`
          : 'No files matched';

    const details: Record<string, unknown> = { matched: lines.length, limit, offset };
    if (truncated) {
      details.truncated = true;
      if (lines.length > 0) {
        const nextOffset = offset + lines.length;
        details.next_offset = nextOffset;
        details.desktop_output_continuation = createDesktopOutputContinuation({
          next_offset: nextOffset,
          offset_unit: 'file',
          continuation_hint: {
            tool: 'glob',
            preserve_args: ['pattern', 'path', 'include_ignored', 'limit', 'sort'],
            instruction:
              `If the omitted remainder is needed, call glob again with offset=${nextOffset}; ` +
              'preserve the same search arguments.',
          },
        });
        text +=
          `\n\n[Results truncated: showing ${lines.length} paths from offset ${offset}. ` +
          `If the omitted remainder is needed, use offset=${nextOffset} with the same search arguments. ` +
          `Refine path/pattern or pass sort="modified" to surface recently changed files]`;
      } else {
        text +=
          '\n\n[Output was truncated before this page could be reached. ' +
          'Refine path/pattern or reduce offset]';
      }
    }
    return reportGlob(
      withCompatibleGlobToolResponse(
        {
          tool_name: LocalGlobToolDef.name,
          text,
          content: [{ type: 'text', text }],
          details,
        },
        {
          durationMs: Date.now() - startedAt,
          filenames: lines,
          truncated,
          totalMatches: allLines.length,
          countIsComplete: !result.stdoutTruncated,
        },
      ),
      lines,
    );
  }
}

/** PTC data is exactly the page of paths the text lists, plus the completeness statement. */
function reportGlob(result: ToolResult, paths: readonly string[]): ToolResult {
  return withDesktopCompletenessReport(LocalGlobToolDef.name, result, {
    data: { paths: [...paths] },
  });
}
