/**
 * `skillsExtension`: Installs `SkillRegistry` through the `@mavis/agent-runtime` extension SPI
 * (design document §4.3 → `pi.registerTool + pi.registerReminderProvider`).
 *
 * Deviation from the §4.3 table: skills' `registerTool` refers to the host-side `skill` file reader
 * (reading SKILL.md). Catalog rendering adds an adapter-level `contributeSystemPrompt` contribution
 * beyond the original table. The host already manually assembles `<available_skills>` into its
 * system prompt; this extension moves that declarative portion to the SPI. The `skill` IO tool
 * remains host-owned because file reads are not purely declarative; a full migration will add it
 * via `pi.registerTool`.
 *
 * Minimal adapter responsibilities:
 * 1. Read `SkillRegistry.getSnapshot()` per turn, render catalog text with
 *   `renderAvailableSkillsCatalog`, and inject it through `pi.contributeSystemPrompt`. This matches
 *   current host catalog assembly (`<available_skills>`); the default wrapper is byte-for-byte
 *   aligned with `packages/local-runtime/src/skills/builtin.ts`.
 * 2. Optionally register a reminder provider: when the host supplies `matcher(userInput, snapshot)
 *   => Reminder | null`, evaluate skill-match reminders per turn, equivalent to the host's existing
 *   `skillMatchReminderProvider`.
 *
 * The host defines the `skill` tool (`packages/local-runtime/src/tools/skill-tool.ts`) because it
 * reads filesystem SKILL.md files. This extension registers no tool, only the declarative catalog +
 * reminder portions. A future host SPI migration will register the skill tool via
 * `pi.registerTool`, matching the §4.3 table's semantics.
 *
 * The host constructs and passes in `SkillRegistry` and retains its lifecycle (`refresh()`
 * scheduling, watcher shutdown, etc.). Each extension instance weakly caches its first snapshot by
 * `TurnAssemblyCtx` identity: the same context represents one assembly / turn, so the catalog
 * contributor and reminder matcher must see the same version. Different contexts do not share a
 * cache; snapshots can be collected with their contexts.
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
   *     (matches `packages/local-runtime/src/skills/builtin.ts` legacy shape).
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
