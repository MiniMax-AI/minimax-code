/**
 * `systemReminderExtension` —— 把 `SystemReminderService` 装进
 * `@mavis/agent-runtime` 的 extension SPI。设计文档 §4.3 表把 system-reminder
 * 归为 `pi.registerReminderProvider`。
 *
 * `SystemReminderService` 内部已有自己的 `SystemReminderRegistry` chain，
 * `buildReminder` 会一次组装成单个 `<system-reminder>` 块。本 adapter 将这个
 * aggregated block 作为一个 reminder emission 注册，而不是把它降级成 user prompt
 * prefix。这符合 `Reminder.content` 的 complete-block contract；host 消费
 * `AssemblyResult.reminders` 时按 assembler 顺序逐块注入，不再增加 wrapper。
 *
 * Host resolver 契约：`SystemReminderService.buildReminder` 需要
 * `SessionInfo` + `MessageRequest`，而 SPI 层的 `TurnAssemblyCtx` 只暴露
 * `TurnAssemblyCtx.sessionId / turnId / agentName / workspaceDir / userInput / ...`
 * 只读投影（§6.2）。Host 传一个 `resolveContext(ctx) => { session, msg } | null`
 * 完成 SPI ctx → 服务 ctx 的边界转换：
 *   - 若 host 无 SR context（比如 background-task 场景），返回 `null`；本 turn
 *     直接跳过 reminder 生成。
 *   - Host 有 SR context 时，resolver 提供 SessionInfo / MessageRequest 后端
 *     根据 turn 状态查库。异常 throw 会 propagate 到 `assembleTurn`（fail-fast）。
 *
 * 备注（service fail-open）：`SystemReminderService.buildReminder` 内部有
 * try/catch 兜底——出错时返回 `{ text: undefined }` 而非 throw；extension 依赖
 * 这条契约。若未来 service 改成 fail-fast 抛错，本 extension 会把错误 propagate
 * 到 pi loop（见 `system-reminder.test.ts` 的 rejection propagation 用例）。
 *
 * Extension 通过 `pi.registerReminderProvider` 暴露 reminder；不会写入
 * `AssemblyResult.userPromptPrefix`。
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
