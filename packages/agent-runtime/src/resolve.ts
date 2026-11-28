/**
 * `resolveExtensions` —— 构造期把 `{ base, additions, overlays, profile }` 展开成
 * 一条最终加载列表（顺序 = handler 执行顺序）。
 *
 * 算法（对齐设计文档 §4.4 + ADR §Consequence 4）—— 4 步固定顺序：
 *   0. 建立 id → extension 的 pool（含 base + additions），检查 id 唯一性。
 *   1. 从 base 出发。
 *   2. `disable`：从 base 里移除；id 必须在 base 里。
 *   3. `enable`：遍历 enable 集合 —— 每个 id 先校验冲突（不能同时出现在 disable 里，
 *      对应 spec §4.4:332 `if (overlay.disable?.includes(id)) throw ...`），再从
 *      additions 池取；按 additions 数组顺序追加，保证同 profile 多次 enable 的
 *      相对顺序稳定（§4.4 line 329 prose "按 additions 数组内顺序"）。
 *   4. `replace`：`{ 目标 id → 替换 id }`，保持位置。
 *
 * 所有引用不到的 id 都抛错（构造期 fail-fast，不允许静默丢弃）。
 * profile 没在 overlays 里定义 → 直接返回 base 全量（让"没定义 overlay"的 host 也能跑）。
 */

import type { AgentExtension, ProfileOverlay } from './types.js';

export function resolveExtensions(
  base: readonly AgentExtension[],
  additions: readonly AgentExtension[],
  overlays: Readonly<Record<string, ProfileOverlay>>,
  profile: string | undefined,
): AgentExtension[] {
  const pool = new Map<string, AgentExtension>();
  for (const ext of [...base, ...additions]) {
    if (pool.has(ext.id)) {
      throw new Error(
        `resolveExtensions: duplicate extension id in base+additions pool: '${ext.id}'`,
      );
    }
    pool.set(ext.id, ext);
  }

  const overlay = profile ? overlays[profile] : undefined;
  if (!overlay) return [...base];

  const disableIds = new Set(overlay.disable ?? []);

  // 1. 从 base 出发
  let result: AgentExtension[] = [...base];

  // 2. disable：从 base 里移除；id 必须在 base 里
  for (const id of disableIds) {
    if (!base.some((e) => e.id === id)) {
      throw new Error(`resolveExtensions: overlay '${profile}' disables id not in base: '${id}'`);
    }
    result = result.filter((e) => e.id !== id);
  }

  // 3. enable：两遍遍历——先在 enable 集合上做 3a+3b 校验，再在 additions 上按序追加 3c
  //   3a. 冲突：id 不能同时在 disable 里（spec §4.4:332 明示放在 enable 步内）
  //   3b. 缺席：id 必须在 additions 池里（不允许静默丢弃）
  //   3c. 追加：按 additions 数组顺序把命中 id 推到 result 末尾（保证 relative order 稳定）
  const enableSet = new Set(overlay.enable ?? []);
  for (const id of enableSet) {
    if (disableIds.has(id)) {
      throw new Error(`resolveExtensions: overlay '${profile}' both enables and disables '${id}'`);
    }
    if (!additions.some((e) => e.id === id)) {
      throw new Error(
        `resolveExtensions: overlay '${profile}' enables id not in additions: '${id}'`,
      );
    }
  }
  for (const ext of additions) {
    if (enableSet.has(ext.id)) result.push(ext);
  }

  // 4. replace：`{ 目标 id → 替换 id }`，保持位置。所有 replacement 都以
  // replace 前的同一份列表定位 target，避免 swap 被前一项 replacement 改写。
  const replacements = new Map<string, AgentExtension>();
  for (const [targetId, replaceId] of Object.entries(overlay.replace ?? {})) {
    if (!result.some((extension) => extension.id === targetId)) {
      throw new Error(
        `resolveExtensions: overlay '${profile}' replaces non-existent target: '${targetId}'`,
      );
    }
    const replaceExt = pool.get(replaceId);
    if (!replaceExt) {
      throw new Error(
        `resolveExtensions: overlay '${profile}' replace source not in pool: '${replaceId}'`,
      );
    }
    replacements.set(targetId, replaceExt);
  }
  result = result.map((extension) => replacements.get(extension.id) ?? extension);

  const finalIds = new Set<string>();
  for (const extension of result) {
    if (finalIds.has(extension.id)) {
      throw new Error(
        `resolveExtensions: duplicate extension id in final load list: '${extension.id}'`,
      );
    }
    finalIds.add(extension.id);
  }

  return result;
}
