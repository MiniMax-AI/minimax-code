/**
 * LocalWebsiteDeployTool —— `website_deploy` 工具的 local 实现。
 *
 * 跟 cloud `CloudWebsiteDeployTool` 同名工具,但语义不同:cloud 在本进程持有
 * OSS AK/SK 直接散文件上传;local **不持有任何 OSS 凭据**,只做本机 fs 校验,
 * 然后把"打包 + 上传 + 发布"全部委托给 `LocalWebsiteDeployAdapter`(由
 * local-runtime 注入,走后端 presigned 直传 + 解包发布,见设计草案 方案 B)。
 *
 * 本文件 def + impl 就近放一起,对齐 cloud `cloud-website-deploy.ts` 的
 * 一工具一文件规范;**不**进 `builtin-defs.ts`(那里只放基础 Pi 工具的 def,
 * 且会与本文件 / types.ts 形成循环依赖)。
 *
 * Description 关键契约(影响 LLM 调用决策):
 *   1. 公开发布前必须用户确认。本工具发布到**公网可访问 URL**;真正的硬拦截
 *      由 local permission ask gate 负责,description 只是给 LLM 的提示。
 *   2. input 必须是**已构建好的静态站点目录**(production dist/,含 index.html),
 *      不是源码。缺 index.html → 本地 pre-check 直接返失败,不调 adapter / 后端。
 *   3. "原地更新已有站点"与"发布为新站点"必须由用户在调用前用 `ask_user` 二选一。
 *      两条路后果不对称且不易撤销:带 nodeId 会整体替换线上内容(URL/alias 不变),
 *      不带 nodeId 会新建 drive 节点 + 全新 URL。这条同样只做在 description 层 ——
 *      权限门禁不区分这两条路,所以必须靠模型在调用前问清。
 *
 * 失败可观测性:本层(agent-tools/desktop)按约定不持有 logger、不调 console.*,
 * 发布拒绝的结构化日志由 local-runtime `LocalWebsiteDeployClient` 的
 * `website deploy stage` 事件承担(stage/result/status_code/error_code/
 * status_msg_present)。这里的 `status_msg_present:false` 与本文件"后端没给可用
 * message → 走中立兜底文案"是同一个条件,因此失败分支走哪条文案可从日志还原。
 *
 * 失败语义(同 cloud):所有失败都返 `ToolResult` `details.ok=false` + 人类/LLM
 * 可读 text,**不 throw**(throw 会被 pi-agent 兜成不可读的 "Tool execution
 * error",LLM 难以据此自纠)。signal 已 abort 时同样返可读失败而非 throw。
 */

import { Type, type Static } from '@sinclair/typebox';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  bindTool,
  type ToolDefinition,
  type ToolImpl,
  type ToolResult,
} from '@mavis/agent-core/tools';

import { resolveWithinWorkspace } from './path-guard.js';
import {
  ENTITLEMENT_LIMIT_EXCEEDED_ERROR_CODE,
  WEBSITE_ENTITLEMENT_LIMIT_EXCEEDED_CODE,
  buildEntitlementLimitReachedEvent,
  parseEntitlementDenial,
  websiteDeployEntitlementLimitText,
} from '../shared/entitlement.js';
import type {
  LocalRuntimeToolContext,
  LocalWebsiteDeployAdapter,
  LocalWebsiteDeployAdapterFailure,
  LocalWebsiteDeployFailureReason,
  LocalWebsiteDeployStage,
} from './types.js';

const LOCAL_WEBSITE_DEPLOY_FAILURE_REASONS = new Set<string>([
  'aborted',
  'validation_failed',
  'packaging_failed',
  'upload_url_rejected',
  'transport_failed',
  'service_request_failed',
  'publish_contract_failed',
  'adapter_failed',
]);

const LOCAL_WEBSITE_DEPLOY_STAGES = new Set<string>([
  'adapter',
  'validate_site',
  'upload_site',
  'validate_source',
  'upload_source',
  'get_upload_url',
  'get_upload_url_source',
  'upload_archive',
  'upload_source_archive',
  'publish_archive',
  'update_archive',
]);

type LocalSourcePathValidationReason =
  | 'missing_source_path'
  | 'invalid_source_path'
  | 'source_path_escape'
  | 'source_not_found'
  | 'source_stat_failed'
  | 'source_not_a_directory'
  | 'source_realpath_failed'
  | 'source_inside_build';

export const LocalWebsiteDeployToolDef = {
  name: 'website_deploy',
  // 有副作用的公开写操作 —— 保持串行(对齐 local `write` 的 sequential),
  // 不标 parallel(避免与 web_fetch 等只读工具走不同的执行/权限分支)。
  executionMode: 'sequential',
  description:
    '⚠️ **Public deployment — user confirmation required.** This publishes files from THIS ' +
    'machine to a **publicly-accessible URL on the open Internet**. Anyone with the link can ' +
    'view the deployed site. Before invoking you MUST: (1) tell the user the site will be ' +
    'public, (2) get explicit confirmation. The local permission gate also gates this tool, but ' +
    'do not rely on it alone — confirm at the moment of publishing. `source_path` is required ' +
    'and source code is always uploaded to private cloud storage, so tell the user about this ' +
    'source upload when confirming publication; the initial release has no secrets scanner and ' +
    'only applies the `.env*` and other documented exclusion rules.\n\n' +
    'Deploy a **built static website** (a directory containing index.html and bundled assets — ' +
    'e.g. the output of `vite build` / `next export` / similar bundler dist/) to a public URL. ' +
    'The directory **must contain index.html at the root**. **Do not pass source code or ' +
    'unbuilt project directories** — run the build step first and pass the dist/ output. The ' +
    'site is registered as a node in the user drive (category=website). Returns the public URL. ' +
    'Omit `node_id` for a first publish. To update an existing site in place, pass the exact ' +
    'string `node_id` returned by the prior deployment; its original primary and alias URLs stay ' +
    'attached to that node.\n\n' +
    '⚠️ **Pick in-place update vs new site with the user before calling.** Whenever this publish ' +
    'could target a site that already exists — the user says "update / change that site", an ' +
    'earlier deployment in this context returned a `node_id`, or their drive already holds a site ' +
    'with the same name — you MUST ask via `ask_user` first and have the user choose explicitly ' +
    'between: (a) **update the existing site in place** — pass `node_id`, the original primary and ' +
    'alias URLs are kept, and the live site content is **replaced wholesale** by this upload; or ' +
    '(b) **publish as a new site** — omit `node_id`, which creates a new drive node with a ' +
    '**brand-new URL** and leaves the existing site untouched. The two outcomes are asymmetric ' +
    'and not easily undone: (a) overwrites what is already public, (b) leaves the user a second ' +
    'site to manage separately. Do not guess: never decide to pass or omit `node_id` on your own ' +
    'while the user has made no explicit choice.\n\n' +
    'When delivering the deployed site to the user, output it inside a <deliver-assets> block ' +
    'with type="website":\n\n' +
    '<deliver-assets>\n' +
    '<media type="website" src="<the deployed URL returned in tool result>" node_id="<the node ID returned in tool result>" name="<project_name>" />\n' +
    '</deliver-assets>',
  schema: Type.Object({
    node_id: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          'Optional exact string ID of an existing website drive node. Omit for a first publish. ' +
          'Pass it only after the user has explicitly chosen to update that existing site in ' +
          'place — doing so replaces the live site content wholesale while keeping its URLs. ' +
          'When present, website_deploy updates that node in place; never convert node IDs to numbers.',
      }),
    ),
    path: Type.String({
      description:
        'Workspace-relative or absolute path to the **built** static-site root directory ' +
        '(bundler dist/ output). Must contain index.html.',
    }),
    project_name: Type.String({
      description:
        'Used as the display name of the drive node and the HTML <title> tag when missing from ' +
        'the source. Pick a short human-readable name.',
    }),
    source_path: Type.String({
      description:
        'Required workspace-relative or absolute path to the project source root. It is always ' +
        'uploaded to private cloud storage separately from the public built site; do not include ' +
        'secrets. It must be a real directory. A self-contained static site may use the same ' +
        'directory as path. If the build path is inside it, the build directory is excluded from ' +
        'the source archive. A source path inside the build path is rejected.',
    }),
  }),
} as const satisfies ToolDefinition;

export type LocalWebsiteDeployToolInput = Static<typeof LocalWebsiteDeployToolDef.schema>;

@bindTool(LocalWebsiteDeployToolDef)
export class LocalWebsiteDeployTool implements ToolImpl<
  typeof LocalWebsiteDeployToolDef.schema,
  LocalRuntimeToolContext
> {
  constructor(
    private readonly adapter: LocalWebsiteDeployAdapter,
    private readonly workspaceRoot: string,
  ) {}

  async execute(
    ctx: LocalRuntimeToolContext,
    input: LocalWebsiteDeployToolInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (signal?.aborted) {
      return aiReadableFailure(`Deploy was aborted before it started.`, {
        reason: 'aborted',
        path: input.path,
      });
    }

    // Schema validation can be bypassed by a direct tool call; reject before any fs or adapter work.
    const sourcePath: unknown = input.source_path;
    if (typeof sourcePath !== 'string') {
      return sourcePathValidationFailure(
        'Cannot deploy: source_path is required.',
        'missing_source_path',
      );
    }
    if (!sourcePath.trim()) {
      return sourcePathValidationFailure(
        'Cannot deploy: source_path must not be empty.',
        'invalid_source_path',
        {
          source_path: sourcePath,
        },
      );
    }

    const rawNodeId: unknown = input.node_id;
    let nodeId: string | undefined;
    if (rawNodeId !== undefined) {
      if (typeof rawNodeId !== 'string' || !rawNodeId.trim() || rawNodeId !== rawNodeId.trim()) {
        return aiReadableFailure('Cannot deploy: node_id must be a non-empty exact string.', {
          reason: 'invalid_node_id',
        });
      }
      nodeId = rawNodeId;
    }

    // 1) Path 围栏 + 目录校验 + 必含 index.html(本机可做,不下发 adapter)
    let dir: string;
    try {
      dir = await resolveWithinWorkspace(input.path, this.workspaceRoot);
    } catch (err) {
      return aiReadableFailure(
        `Cannot deploy: '${input.path}' is outside the workspace or invalid. ` +
          `Pass a path that lives under the current working directory.`,
        { reason: 'path_escape', path: input.path, detail: describeError(err) },
      );
    }

    let dirStat;
    try {
      // lstat: reject a symlink at the build root; ancestor symlink aliases
      // remain valid because the workspace guard already resolved their target.
      dirStat = await lstat(dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return aiReadableFailure(
          `Cannot deploy: '${input.path}' does not exist. website_deploy needs a built ` +
            `static site (a bundler dist/ output). Run the build step first, then pass the ` +
            `output directory path.`,
          { reason: 'not_found', path: input.path },
        );
      }
      return aiReadableFailure(
        `Cannot deploy: unable to read '${input.path}'. Check the path and permissions, ` +
          `then retry.`,
        { reason: 'stat_failed', path: input.path, detail: describeError(err) },
      );
    }
    if (!dirStat.isDirectory()) {
      return aiReadableFailure(
        `Cannot deploy: '${input.path}' is not a directory. Pass the path to the built ` +
          `site directory (containing index.html), not a single file.`,
        { reason: 'not_a_directory', path: input.path },
      );
    }

    const indexPath = join(dir, 'index.html');
    let indexStat;
    try {
      // lstat (not stat): do NOT follow symlinks. The runtime packaging
      // (walkDeployableFiles) skips symlink entries, so a symlinked root
      // index.html would pass a stat()-based pre-check yet be absent from
      // the uploaded zip — publishing a site that 404s on `/`. Rejecting it
      // here keeps the pre-check consistent with what actually gets packaged.
      indexStat = await lstat(indexPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return aiReadableFailure(
          `Cannot deploy: '${input.path}' has no index.html at the root. website_deploy needs ` +
            `a built static site (a bundler dist/ output, e.g. from \`vite build\` / ` +
            `\`next export\`), not source code or an unbuilt project. The site won't load ` +
            `without a root index.html — run the build step first and try again.`,
          { reason: 'missing_index_html', path: input.path },
        );
      }
      return aiReadableFailure(
        `Cannot deploy: unable to read '${input.path}/index.html'. Check the file is present ` +
          `and readable, then retry.`,
        { reason: 'index_stat_failed', path: input.path, detail: describeError(err) },
      );
    }
    if (!indexStat.isFile()) {
      return aiReadableFailure(
        `Cannot deploy: '${input.path}/index.html' isn't a regular file (it's a directory or ` +
          `symlink). The deploy packager skips symlinks, so the published site would be missing ` +
          `its root index.html — make sure the build produced a real index.html file.`,
        { reason: 'index_not_a_file', path: input.path },
      );
    }

    let sourceDir: string | undefined;
    if (input.source_path !== undefined) {
      if (!input.source_path.trim()) {
        return sourcePathValidationFailure(
          'Cannot deploy: source_path must not be empty.',
          'invalid_source_path',
          { source_path: input.source_path },
        );
      }
      try {
        sourceDir = await resolveWithinWorkspace(input.source_path, this.workspaceRoot);
      } catch (err) {
        return sourcePathValidationFailure(
          `Cannot deploy: '${input.source_path}' is outside the workspace or invalid. ` +
            `Pass a source path that lives under the current working directory.`,
          'source_path_escape',
          { source_path: input.source_path, detail: describeError(err) },
        );
      }

      let sourceStat;
      try {
        sourceStat = await lstat(sourceDir);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          return sourcePathValidationFailure(
            `Cannot deploy: '${input.source_path}' does not exist.`,
            'source_not_found',
            { source_path: input.source_path },
          );
        }
        return sourcePathValidationFailure(
          `Cannot deploy: unable to read '${input.source_path}'.`,
          'source_stat_failed',
          { source_path: input.source_path, detail: describeError(err) },
        );
      }
      if (!sourceStat.isDirectory()) {
        return sourcePathValidationFailure(
          `Cannot deploy: '${input.source_path}' is not a real directory.`,
          'source_not_a_directory',
          { source_path: input.source_path },
        );
      }

      let canonicalDir: string;
      let canonicalSourceDir: string;
      try {
        [canonicalDir, canonicalSourceDir] = await Promise.all([
          realpath(dir),
          realpath(sourceDir),
        ]);
      } catch (err) {
        return sourcePathValidationFailure(
          'Cannot deploy: unable to resolve the source directory safely.',
          'source_realpath_failed',
          { source_path: input.source_path, detail: describeError(err) },
        );
      }
      if (canonicalDir !== canonicalSourceDir && isPathInside(canonicalDir, canonicalSourceDir)) {
        return sourcePathValidationFailure(
          'Cannot deploy: source_path cannot be nested inside the built site directory.',
          'source_inside_build',
          { source_path: input.source_path },
        );
      }
    }

    // 2) Session 是发布身份/审计锚点 —— 缺失视为 runtime 内部状态问题。
    const sessionId = ctx.sessionId;
    if (!sessionId) {
      return aiReadableFailure(
        `Deploy needs an active session, but the current turn has none. Please report this ` +
          `to the user — it's an internal state issue, not something they can fix.`,
        { reason: 'missing_session_id', path: input.path },
      );
    }

    // 3) 委托 adapter:打包 + 上传 + 发布(local 不碰 OSS 凭据)。
    let resp;
    try {
      resp = await this.adapter.deploy(
        {
          dir,
          ...(sourceDir ? { sourceDir } : {}),
          ...(nodeId ? { nodeId } : {}),
          projectName: input.project_name,
          sessionId,
          turnId: ctx.turnId,
        },
        signal,
      );
    } catch (err) {
      const failure = asWebsiteDeployAdapterFailure(err);
      const stage = failure?.stage ?? 'adapter';
      const retryable = failure?.retryable ?? false;
      return aiReadableFailure(
        `Deploy failed during ${stage}: ${describeError(err)}.${
          retryable ? ' Retry the same call to try again.' : ''
        }`,
        {
          reason: failure?.reason ?? 'adapter_failed',
          stage,
          retryable,
          detail: describeError(err),
          path: input.path,
        },
      );
    }

    const statusCode = resp.base_resp?.status_code ?? 0;
    if (statusCode !== 0) {
      // 限额拒绝(WebsiteManagementCode.ENTITLEMENT_LIMIT_EXCEEDED = 19)是下面
      // "不在客户端映射文案"原则的**唯一例外**,且不违背其动机:文案数值
      // (limit/current/suggest)全部来自后端 entitlement_denial 插值,客户端只
      // 持模板(方案 §四-D,用户逐字拍板),没有第二份会漂移的 code→文案表。
      // denial 缺失/不可用时仍走既有 status_msg 透传路径 —— 服务端 gate 才是
      // 强制点,这里只做体验层,绝不 throw。
      const entitlementFailure = await desktopEntitlementLimitFailure(
        ctx,
        resp,
        statusCode,
        nodeId ? 'update_archive' : 'publish_archive',
        input.path,
      );
      if (entitlementFailure) return entitlementFailure;
      // 面向用户的失败真因由后端 `status_msg` 承载,这里**原样透出**,不在客户端按业务码
      // 硬编码一份文案:只有后端知道当前是哪种业务状态(站点已被用户取消发布、内容审核
      // 未通过、配额用尽…),在客户端再维护一份 code→文案映射会立刻变成前后端双份维护
      // 且必然漂移。客户端只负责两件事:分类成"业务侧拒绝、重试无用",并把 message 交给
      // 模型转述。
      //
      // 历史缺陷(2026-08-16 国内生产):本分支曾无条件输出 "website deployment is currently
      // unavailable",把 `UNPUBLISHED`(站点已被取消发布,需先重新发布)这类业务状态冲突
      // 误报成基础设施故障,用户理解为"服务挂了"而拿不到真正的处理动作。因此这里绝不再
      // 声称服务不可用 —— 拒绝原因只能来自后端,拿不到时也只给中立描述。
      const backendMessage =
        typeof resp.base_resp?.status_msg === 'string' && resp.base_resp.status_msg.trim()
          ? resp.base_resp.status_msg
          : undefined;
      const errorCode =
        typeof resp.error_code === 'string' && resp.error_code.trim() ? resp.error_code : undefined;
      // details 里保持既有字段与取值:status_msg 在后端未给可用 message 时仍回落到同一句
      // 技术描述,下游按 reason/status_code 分类的工具不受影响。
      const statusMsg = backendMessage ?? `publish service returned status_code=${statusCode}`;
      const text = backendMessage
        ? `Deploy was rejected by the publish service: ${backendMessage}` +
          `${errorCode ? ` (error_code=${errorCode})` : ''}. Relay this reason to the user as the ` +
          `actual cause and tell them the concrete next step it implies. This is a business-side ` +
          `rejection, so retrying the same call will not succeed until that condition is resolved.`
        : `Deploy was rejected by the publish service, which returned no reason message ` +
          `(status_code=${statusCode}${errorCode ? `, error_code=${errorCode}` : ''}). Tell the ` +
          `user the publish request was rejected and surface this technical detail. This is a ` +
          `business-side rejection, so retrying the same call will not succeed.`;
      return aiReadableFailure(text, {
        reason: 'publish_business_failure',
        stage: nodeId ? 'update_archive' : 'publish_archive',
        retryable: false,
        status_code: statusCode,
        status_msg: statusMsg,
        ...(errorCode ? { error_code: errorCode } : {}),
        path: input.path,
      });
    }

    // 4) 成功 —— URL 和可信 node ID（若后端返回）都给模型；cover_path 仅走 details。
    const websiteUrl = resp.cdn_url ?? '';
    if (!websiteUrl) {
      return aiReadableFailure(
        `Deploy returned an empty URL — this is unexpected. Please tell the user the ` +
          `deployment didn't complete cleanly.`,
        {
          reason: 'empty_cdn_url',
          stage: nodeId ? 'update_archive' : 'publish_archive',
          retryable: false,
          path: input.path,
        },
      );
    }
    const summary = [
      `${nodeId ? 'Website updated' : 'Website deployed'}: ${websiteUrl}`,
      ...(resp.node_id ? [`Drive node ID: ${resp.node_id}`] : []),
    ].join('\n');
    return {
      tool_name: LocalWebsiteDeployToolDef.name,
      text: summary,
      content: [{ type: 'text', text: summary }],
      details: {
        ok: true,
        website_url: websiteUrl,
        ...(resp.node_id ? { node_id: resp.node_id } : {}),
        ...(resp.cover_path ? { cover_path: resp.cover_path } : {}),
      },
    };
  }
}

/**
 * 桌面端限额 denial 分支:tool result 用与云端同款的 §四-D 文案,并经
 * `ctx.reporter`(local-runtime 注入的本地事件通道,todo-event 同款)发与
 * 云端**同 schema** 的 `entitlement.limit_reached` 事件(§四-E)。
 *
 * 鲁棒性:非 19/ENTITLEMENT_LIMIT_EXCEEDED 或 denial 不可用 → `undefined`
 * 走既有 status_msg 透传;reporter 缺失或 appendEvents 失败 → 跳过事件,
 * `details.event_emitted=false` 留可观测痕迹(本层按约定不持有 logger,
 * 结构化日志由 local-runtime client 的 stage 事件承担)。
 */
async function desktopEntitlementLimitFailure(
  ctx: LocalRuntimeToolContext,
  resp: Awaited<ReturnType<LocalWebsiteDeployAdapter['deploy']>>,
  statusCode: number,
  stage: LocalWebsiteDeployStage,
  inputPath: string,
): Promise<ToolResult | undefined> {
  const isEntitlementRejection =
    resp.error_code === ENTITLEMENT_LIMIT_EXCEEDED_ERROR_CODE ||
    statusCode === WEBSITE_ENTITLEMENT_LIMIT_EXCEEDED_CODE;
  if (!isEntitlementRejection) return undefined;

  const denial = parseEntitlementDenial(resp.entitlement_denial);
  if (!denial) return undefined;

  let eventEmitted = false;
  if (ctx.reporter) {
    try {
      await ctx.reporter.appendEvents([
        buildEntitlementLimitReachedEvent({
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          reporter: ctx.reporter,
          denial,
        }),
      ]);
      eventEmitted = true;
    } catch {
      // 副流事件失败不影响 tool result 主路径(todowrite 先例语义)。
    }
  }

  return aiReadableFailure(websiteDeployEntitlementLimitText(denial), {
    reason: 'entitlement_limit_exceeded',
    stage,
    retryable: false,
    status_code: statusCode,
    error_code: ENTITLEMENT_LIMIT_EXCEEDED_ERROR_CODE,
    entitlement_key: denial.entitlement_key,
    limit: denial.limit,
    current: denial.current,
    event_emitted: eventEmitted,
    path: inputPath,
  });
}

/**
 * 统一 ai-readable failure helper —— 失败永远返 ToolResult,不 throw。
 * `text` 是 LLM 看到的主体(决定怎么自纠);`details.ok=false` + `reason`
 * 让 SRE/dev 工具能精确分类。
 */
function aiReadableFailure(message: string, details: Record<string, unknown>): ToolResult {
  return {
    tool_name: LocalWebsiteDeployToolDef.name,
    text: message,
    content: [{ type: 'text', text: message }],
    details: { ok: false, ...details },
  };
}

function sourcePathValidationFailure(
  message: string,
  reason: LocalSourcePathValidationReason,
  details: Record<string, unknown> = {},
): ToolResult {
  const errorCode =
    reason === 'missing_source_path'
      ? 'LOCAL_SOURCE_PATH_REQUIRED'
      : reason === 'source_path_escape'
        ? 'LOCAL_SOURCE_PATH_ESCAPE'
        : 'LOCAL_SOURCE_PATH_INVALID';
  return aiReadableFailure(message, {
    ...details,
    error_code: errorCode,
    reason,
    stage: 'validate_source',
    retryable: false,
  });
}

function describeError(err: unknown): string {
  if (err === null || err === undefined) return 'unknown error';
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  return String(err);
}

function asWebsiteDeployAdapterFailure(err: unknown): LocalWebsiteDeployAdapterFailure | undefined {
  if (!(err instanceof Error)) return undefined;
  const candidate = err as Partial<LocalWebsiteDeployAdapterFailure>;
  return isLocalWebsiteDeployFailureReason(candidate.reason) &&
    isLocalWebsiteDeployStage(candidate.stage) &&
    typeof candidate.retryable === 'boolean'
    ? (candidate as LocalWebsiteDeployAdapterFailure)
    : undefined;
}

function isLocalWebsiteDeployFailureReason(
  value: unknown,
): value is LocalWebsiteDeployFailureReason {
  return typeof value === 'string' && LOCAL_WEBSITE_DEPLOY_FAILURE_REASONS.has(value);
}

function isLocalWebsiteDeployStage(value: unknown): value is LocalWebsiteDeployStage {
  return typeof value === 'string' && LOCAL_WEBSITE_DEPLOY_STAGES.has(value);
}

function isPathInside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
