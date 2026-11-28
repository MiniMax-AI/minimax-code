/**
 * `skillsExtension` —— 把 `SkillRegistry` 装进 `@mavis/agent-runtime` 的
 * extension SPI（设计文档 §4.3 → `pi.registerTool + pi.registerReminderProvider`）。
 *
 * 与 §4.3 表的偏差：设计文档表里 skills 用 `registerTool` 指的是 host 侧的
 * `skill` 文件读工具（读 SKILL.md）；catalog 渲染是 adapter 层增加的
 * `contributeSystemPrompt` 贡献，不在 §4.3 表原本列出的表面上——因为 host 的
 * `<available_skills>` 段落在装配时已由 host 手工拼装 system prompt，本 extension
 * 只是把这一段 declarative 部分迁到 SPI 里。`skill` IO 工具本身住 host 因为它涉及
 * 文件读，不属于 pure declarative；将来完整迁移时会通过 `pi.registerTool` 补上。
 *
 * adapter 职责最小化：
 *   1. 每 turn 拿 `SkillRegistry.getSnapshot()` 用 `renderAvailableSkillsCatalog`
 *      渲染 catalog 文本，通过 `pi.contributeSystemPrompt` 注入到 system prompt。
 *      这跟 host 现在的 catalog 拼接 (`<available_skills>` 段)行为一致——默认 wrapper
 *      跟 `packages/agent-modules/context-manager/src/skill-catalog.ts` 产出格式逐字节对齐。
 *   2. 可选 `registerReminderProvider`：当 host 传入 `matcher(userInput, snapshot)
 *      => Reminder | null` 时，per-turn 计算是否触发 skill-match reminder（现有
 *      host 侧 `skillMatchReminderProvider` 的等价接线）。
 *
 * `skill` 的文件读取由 host 承接（`packages/local-runtime-v2/src/service/skill/runtime/native-reader.ts`）
 * 因为它涉及 IO（读文件系统 SKILL.md）；本 extension 不注册 tool——只做 catalog +
 * reminder 的 declarative 部分。将来 host 迁移到 SPI 时会把 skill tool 通过
 * `pi.registerTool` 挂进来（这也符合设计文档 §4.3 表里 skills 用 `registerTool`
 * 的语义）。
 *
 * Host 自己构造 `SkillRegistry` 后传进来；registry lifecycle 仍由 host 管
 *（`refresh()` 调度、watcher 关闭等）。每个 extension 实例只按 `TurnAssemblyCtx`
 * identity 弱缓存首次读取的 snapshot：同一个 ctx 代表同一次 assembly / turn，catalog
 * contributor 与 reminder matcher 必须看到同一版本；不同 ctx 不共享缓存，且 ctx 回收后
 * snapshot 也可随之回收。
 */

import type {
  AgentExtension,
  ExtensionAPI,
  ModelContextAssemblyCtx,
  Reminder,
  TurnAssemblyCtx,
} from '@mavis/agent-runtime';
import {
  renderAvailableSkillsCatalog,
  type SkillRegistry,
  type SkillRenderOptions,
  type SkillSnapshot,
} from '@mavis/skills';

export type SkillMatcher = (
  ctx: TurnAssemblyCtx,
  snapshot: SkillSnapshot | undefined,
) => Reminder | null | undefined | Promise<Reminder | null | undefined>;

export interface SkillsExtensionOptions {
  readonly registry: SkillRegistry;
  /** Extension id override; default `'skills'` per design doc §4.3. */
  readonly id?: string;
  readonly description?: string;
  /**
   * `renderAvailableSkillsCatalog` options (budgetChars / externalDescriptionChars).
   * Static per-runtime; per-profile budget differences go through overlays.
   */
  readonly renderOptions?: SkillRenderOptions;
  /**
   * When the rendered catalog is embedded into the system prompt, wrap it in
   * this header. Contract:
   *   - default (undefined) → wraps in `<available_skills>\n...\n</available_skills>`
   *     (matches `packages/agent-modules/context-manager/src/skill-catalog.ts` legacy shape).
   *   - `null` → no wrapper; raw catalog text.
   *   - string → **must be `<tagName>` form**. The close tag is derived by
   *     stripping the angle brackets; passing an open tag with attributes
   *     (`<available_skills version="1">`) will drop the attributes from the
   *     close tag, and passing a bare `foo` yields the asymmetric
   *     `foo\n...\n</foo>` — validated by the caller.
   */
  readonly header?: string | null;
  /**
   * Optional per-turn skill-match reminder. Host implements the actual match
   * logic against `ctx.userInput.text` / `snapshot.entries`.
   */
  readonly matcher?: SkillMatcher;
  /** Reminder provider name override; default `'skills-match'`. */
  readonly matchProviderName?: string;
}

const DEFAULT_HEADER = '<available_skills>';
const DEFAULT_HEADER_CLOSE = '</available_skills>';

function wrapCatalog(catalog: string, header: string | null | undefined): string {
  if (catalog.length === 0) return '';
  if (header === null) return catalog;
  if (header === undefined) return `${DEFAULT_HEADER}\n${catalog}\n${DEFAULT_HEADER_CLOSE}`;
  const tagName = header.replace(/^<|>$/g, '').replace(/\s.*$/, '');
  return `${header}\n${catalog}\n</${tagName}>`;
}

export function skillsExtension(options: SkillsExtensionOptions): AgentExtension {
  const { registry, renderOptions, header, matcher } = options;
  const id = options.id ?? 'skills';
  const description =
    options.description ??
    'Render the available-skills catalog into system prompt and optionally emit a skill-match reminder per turn.';
  const providerName = options.matchProviderName ?? 'skills-match';
  const snapshotsByAssemblyCtx = new WeakMap<ModelContextAssemblyCtx, SkillSnapshot | undefined>();
  const snapshotFor = (ctx: ModelContextAssemblyCtx): SkillSnapshot | undefined => {
    if (snapshotsByAssemblyCtx.has(ctx)) return snapshotsByAssemblyCtx.get(ctx);
    const snapshot = registry.getSnapshot();
    snapshotsByAssemblyCtx.set(ctx, snapshot);
    return snapshot;
  };

  return {
    id,
    description,
    init(pi: ExtensionAPI): void {
      pi.contributeSystemPrompt((ctx) => {
        const snapshot = snapshotFor(ctx);
        if (!snapshot || snapshot.winners.length === 0) return null;
        const rendered = renderAvailableSkillsCatalog(snapshot, renderOptions ?? {});
        return wrapCatalog(rendered.catalog, header);
      });

      if (matcher) {
        pi.registerReminderProvider({
          name: providerName,
          async compute(ctx) {
            const snapshot = snapshotFor(ctx);
            const result = await matcher(ctx, snapshot);
            return result ?? null;
          },
        });
      }
    },
  };
}
