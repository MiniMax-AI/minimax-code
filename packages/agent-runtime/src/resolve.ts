/**
 * `resolveExtensions`: Expand `{ base, additions, overlays, profile }` during construction into the
 * final load list (whose order is handler execution order).
 *
 * Algorithm (aligned with design document §4.4 + ADR §Consequence 4), in fixed order:
 * 0. Build an id → extension pool from base + additions, checking id uniqueness.
 * 1. Start with base.
 * 2. `disable`: Remove from base; the id must exist in base.
 * 3. `enable`: Validate each enabled id for conflicts (it cannot also appear in disable, per spec
 *   §4.4:332 `if (overlay.disable?.includes(id)) throw ...`), then select from the additions pool.
 *   Append in additions-array order to keep relative order stable for multiple enabled entries in
 *   the same profile (§4.4 line 329).
 * 4. `replace`: Map target id → replacement id, preserving position.
 *
 * Throw for all unresolved ids (fail fast during construction; never silently discard). If the
 * profile has no overlay, return all of base so hosts without overlays still work.
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

  // 1. Start with base.
  let result: AgentExtension[] = [...base];

  // 2. disable: Remove from base; the id must exist in base.
  for (const id of disableIds) {
    if (!base.some((e) => e.id === id)) {
      throw new Error(`resolveExtensions: overlay '${profile}' disables id not in base: '${id}'`);
    }
    result = result.filter((e) => e.id !== id);
  }

  // 3. enable: Two passes: validate 3a+3b over enabled ids, then append in additions order for 3c.
  //   3a. Conflict: An id cannot also be disabled (explicitly part of enable in spec §4.4:332).
  //   3b. Missing: The id must exist in the additions pool; never silently discard it.
  //   3c. Append: Push matching ids in additions-array order to preserve relative order.
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

  // 4. replace: Map target id → replacement id, preserving position. All replacements locate
  // targets in the same pre-replacement list so earlier replacements cannot disrupt swaps.
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
