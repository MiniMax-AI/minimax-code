/**
 * `systemReminderExtension`: Installs `SystemReminderService` through the `@mavis/agent-runtime`
 * extension SPI. The design document §4.3 table maps system-reminder to
 * `pi.registerReminderProvider`.
 *
 * `SystemReminderService` already owns a `SystemReminderRegistry` chain; `buildReminder` assembles
 * one `<system-reminder>` block. This adapter registers that aggregated block as one reminder
 * emission rather than a user prompt prefix, honoring `Reminder.content`'s complete-block contract.
 * Hosts consuming `AssemblyResult.reminders` inject blocks in assembler order without adding
 * wrappers.
 *
 * Host resolver contract: `SystemReminderService.buildReminder` needs `SessionInfo` +
 * `MessageRequest`, while SPI `TurnAssemblyCtx` only exposes read-only projections such as
 * `sessionId / turnId / agentName / workspaceDir / userInput / ...` (§6.2). The host supplies
 * `resolveContext(ctx) => { session, msg } | null` to convert SPI context to service context:
 * - Return `null` when the host has no SR context (e.g. background tasks); skip reminder generation
 *   for this turn.
 * - When SR context exists, the resolver supplies SessionInfo / MessageRequest from backend lookups
 *   based on turn state. Exceptions propagate to `assembleTurn` (fail-fast).
 *
 * Service fail-open note: `SystemReminderService.buildReminder` catches errors internally and
 * returns `{ text: undefined }` instead of throwing; the extension relies on this contract. If the
 * service later becomes fail-fast, the extension propagates errors to the pi loop (see the
 * rejection propagation case in `system-reminder.test.ts`).
 *
 * The extension exposes reminders through `pi.registerReminderProvider`; it does not write
 * `AssemblyResult.userPromptPrefix`.
 */

import type { AgentExtension, ExtensionAPI, TurnAssemblyCtx } from '@mavis/agent-runtime';
import type {
  MessageRequest,
  SessionInfo,
  SystemReminderDiagnostic,
  SystemReminderService,
} from '@mavis/system-reminder';

export interface SystemReminderResolvedContext {
  readonly session: SessionInfo;
  readonly msg: MessageRequest;
}

export type SystemReminderContextResolver = (
  ctx: TurnAssemblyCtx,
) => SystemReminderResolvedContext | null | Promise<SystemReminderResolvedContext | null>;

export interface SystemReminderExtensionOptions {
  readonly service: SystemReminderService;
  readonly resolveContext: SystemReminderContextResolver;
  /** Extension id override; default `'system-reminder'` per design doc §4.3. */
  readonly id?: string;
  readonly description?: string;
  /**
   * Optional diagnostic sink populated with per-turn `SystemReminderDiagnostic`.
   * Only invoked when the extension explicitly forces `withDiagnostic: true`
   * for this reason. Note: `SystemReminderService.buildReminder` also produces
   * diagnostics when its debug store is populated internally—those still go
   * to the debug store, not to this callback, so hosts wanting the callback
   * path must supply `onDiagnostic` here (they can supply both).
   */
  readonly onDiagnostic?: (
    diagnostic: SystemReminderDiagnostic,
    ctx: TurnAssemblyCtx,
  ) => void | Promise<void>;
}

export function systemReminderExtension(options: SystemReminderExtensionOptions): AgentExtension {
  const { service, resolveContext, onDiagnostic } = options;
  const id = options.id ?? 'system-reminder';
  const description =
    options.description ??
    'Emit an aggregated <system-reminder> block each turn via SystemReminderService.';
  return {
    id,
    description,
    init(pi: ExtensionAPI): void {
      pi.registerReminderProvider({
        name: id,
        compute: async (ctx) => {
          const resolved = await resolveContext(ctx);
          if (resolved === null) return null;
          const withDiag = Boolean(onDiagnostic);
          const { text, diagnostic } = await service.buildReminder(
            resolved.session,
            resolved.msg,
            withDiag ? { withDiagnostic: true } : undefined,
          );
          if (onDiagnostic && diagnostic) {
            await onDiagnostic(diagnostic, ctx);
          }
          return text ? { content: text } : null;
        },
      });
    },
  };
}
