/**
 * Entitlement-denial helpers shared by cloud and desktop tools.
 *
 * 服务端限额 gate（archon-server）拒绝创建类操作时，会在 resp 里带
 * `entitlement_denial`（网站/cron/project envelope，方案 §四-C3/C4）或在
 * cloud-runtime HTTP ProtocolError body 的 `detail` 字段里带同构 JSON 字符串
 * （§四-C5）。本模块收容三件事：
 *   1. **容错解析** —— `parseEntitlementDenial` / `parseEntitlementDenialDetail`。
 *      服务端 gate 是唯一强制点；这里只做体验层。未知可选字段局部省略，
 *      不可识别的记录或非法 JSON 返回 `undefined`，**绝不 throw**。
 *   2. **tool result 文案**（§四-D，用户逐字拍板）—— 纯函数，锁定
 *      "don't/do not retry on your own" 条件化措辞与 limit/current 插值；
 *      `suggest_plan_key`/`suggest_limit` 缺失（存量超所有档，C2/D10）时
 *      省略升级子句。
 *   3. **`entitlement.limit_reached` 副流事件**（§四-E）—— AGENT_MESSAGE(type=2)
 *      + SYSTEM_EVENT(msg_type=3)，msg_content 与 EntitlementDenial 逐字段对齐
 *      外加 `eventType`。云端（CloudTodoWriteTool 同款 reporter 通道）与桌面端
 *      （local todo-event 同款）共用同一构造，三端渲染一致。
 *
 * 事件发送本身由调用方 `reporter.appendEvents` 完成并各自兜底 —— 副流事件
 * 失败绝不影响 tool result 主路径（todowrite 先例语义）。
 */

import { buildStreamRespEvent } from '@mavis/agent-core/event-bridge';
import {
  MsgType,
  RespDataType,
  type AgentMessage,
  type RespData,
} from '@mavis/agent-core/protocol/agent-message';
import type { StreamRespEvent } from '@mavis/agent-core/protocol/runtime-event';
import type { TurnEventReporter } from '@mavis/agent-core/pi-turn-runner';

/** WebsiteManagementCode.ENTITLEMENT_LIMIT_EXCEEDED 的枚举名（envelope `error_code`）。 */
export const ENTITLEMENT_LIMIT_EXCEEDED_ERROR_CODE = 'ENTITLEMENT_LIMIT_EXCEEDED';
/**
 * SSE/HTTP ProtocolError 的权益拒绝 key（对应 status_code
 * STATUS_MATRIX_COMMON_ENTITLEMENT_DENIED 的大写 key；2026-09 MR 链内修订：
 * 码与 key 从 ARCHON 段 ENTITLEMENT_LIMIT_EXCEEDED 统一为 COMMON 段语义中性
 * DENIED，数量型/开关型明细走 EntitlementDenial 字段）。
 * 注意与上面网站 envelope 的 error_code 是两个体系：网站走 WebsiteManagementCode
 * 枚举名（值仍为 ENTITLEMENT_LIMIT_EXCEEDED），不受本次改名影响。
 */
export const ENTITLEMENT_DENIED_PROTOCOL_KEY = 'ENTITLEMENT_DENIED';
/** WebsiteManagementCode.ENTITLEMENT_LIMIT_EXCEEDED = 19（envelope `code`，IDL §三-3）。 */
export const WEBSITE_ENTITLEMENT_LIMIT_EXCEEDED_CODE = 19;
/** §四-E 事件类型；archon-server 对 `entitlement.` 前缀跳过持久化，SSE 透传。 */
export const ENTITLEMENT_LIMIT_REACHED_EVENT_TYPE = 'entitlement.limit_reached';

/**
 * `EntitlementDenial`（archon_server_base，§三-2）的工具层视图。
 * 功能拒绝可以没有 limit/current；只有完整额度数据才使用额度文案。
 * 可选字段尽力保留、缺失即省略。
 */
export interface EntitlementDenial {
  entitlement_key: string;
  limit?: number;
  current?: number;
  denial_code?: number;
  error_code?: string;
  plan_key?: string;
  suggest_plan_key?: string;
  suggest_limit?: number;
  suggest_combo_id?: string;
  suggest_billing_period?: 'Month' | 'Year';
  message?: string;
}

/**
 * 容错解析 resp 里的 `entitlement_denial` 记录。可用性判据：
 * `entitlement_key` 非空，且有完整额度、拒绝码或 message。额度只接受非负安全
 * 整数或相应数字字符串；功能和未来拒绝码使用 message 兜底。导航字段必须成对，
 * 且周期为 Month/Year。完全不可识别的记录返回 `undefined`，不 throw。
 */
export function parseEntitlementDenial(value: unknown): EntitlementDenial | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const entitlementKey = nonEmptyString(record.entitlement_key);
  const limit = quotaNumber(record.limit);
  const current = quotaNumber(record.current);
  const denialCode = finiteNumber(record.denial_code);
  const errorCode = nonEmptyString(record.error_code);
  const message = nonEmptyString(record.message);
  if (
    entitlementKey === undefined ||
    ((limit === undefined || current === undefined) &&
      denialCode === undefined &&
      errorCode === undefined &&
      message === undefined)
  ) {
    return undefined;
  }
  const planKey = nonEmptyString(record.plan_key);
  const suggestPlanKey = nonEmptyString(record.suggest_plan_key);
  const suggestLimit = quotaNumber(record.suggest_limit);
  const suggestComboId = nonEmptyString(record.suggest_combo_id);
  const suggestBillingPeriod = record.suggest_billing_period;
  return {
    entitlement_key: entitlementKey,
    ...(limit !== undefined ? { limit } : {}),
    ...(current !== undefined ? { current } : {}),
    ...(denialCode !== undefined ? { denial_code: denialCode } : {}),
    ...(errorCode !== undefined ? { error_code: errorCode } : {}),
    ...(planKey !== undefined ? { plan_key: planKey } : {}),
    ...(suggestPlanKey !== undefined ? { suggest_plan_key: suggestPlanKey } : {}),
    ...(suggestLimit !== undefined ? { suggest_limit: suggestLimit } : {}),
    ...(suggestComboId !== undefined &&
    (suggestBillingPeriod === 'Month' || suggestBillingPeriod === 'Year')
      ? { suggest_combo_id: suggestComboId, suggest_billing_period: suggestBillingPeriod }
      : {}),
    ...(message !== undefined ? { message } : {}),
  };
}

/**
 * §四-C5：ProtocolError.detail 是 EntitlementDenial 的 JSON **字符串**。
 * 非 string / JSON.parse 失败 / 解析结果不可用 → `undefined`，不 throw。
 */
export function parseEntitlementDenialDetail(detail: unknown): EntitlementDenial | undefined {
  if (typeof detail !== 'string' || !detail.trim()) return undefined;
  try {
    return parseEntitlementDenial(JSON.parse(detail));
  } catch {
    return undefined;
  }
}

/** §四-D 云端/桌面 `website_deploy` 文案（用户逐字拍板；无升级建议时省略升级子句）。 */
export function websiteDeployEntitlementLimitText(denial: EntitlementDenial): string {
  if (!isQuotaDenial(denial)) {
    return denial.message ?? 'This operation is not available on the current plan.';
  }
  const suggestion = suggestionClause(denial);
  const recovery = suggestion
    ? `It can succeed after the user upgrades the plan ${suggestion} or unpublishes an existing site.`
    : 'It can succeed after the user unpublishes an existing site.';
  return [
    `Deploy rejected: website deployment limit reached (${denial.current}/${denial.limit} on the current plan).`,
    `Retrying now will fail with the same error. ${recovery}`,
    'Report this to the user and let them decide; do not retry on your own.',
    `error_code: ${ENTITLEMENT_LIMIT_EXCEEDED_ERROR_CODE} · entitlement: ${denial.entitlement_key}`,
  ].join('\n');
}

/** §四-D `mavis cron` 文案；`enable`（UpdateCronTask false→true）复用同一 body。 */
export function cronEntitlementLimitText(
  denial: EntitlementDenial,
  action: 'create' | 'enable',
): string {
  if (!isQuotaDenial(denial)) {
    return denial.message ?? 'This operation is not available on the current plan.';
  }
  const verb = action === 'enable' ? 'Enable' : 'Create';
  const suggestion = suggestionClause(denial);
  const recovery = suggestion
    ? `This succeeds only after the user upgrades ${suggestion} or removes/disables an existing cloud cron task.`
    : 'This succeeds only after the user removes/disables an existing cloud cron task.';
  return [
    `${verb} failed: cloud cron task limit reached (${denial.current}/${denial.limit} on the current plan).`,
    `${recovery} Report the options to the user; don't retry on your own.`,
  ].join('\n');
}

function isQuotaDenial(denial: EntitlementDenial): boolean {
  return (
    denial.limit !== undefined &&
    denial.current !== undefined &&
    (denial.denial_code === undefined || denial.denial_code === 1) &&
    (denial.error_code === undefined || denial.error_code === 'LIMIT_EXCEEDED')
  );
}

/** "(Go allows 50)" —— 两个 suggest 字段都在才输出；档位名首字母大写展示。 */
function suggestionClause(denial: EntitlementDenial): string | undefined {
  if (denial.suggest_plan_key === undefined || denial.suggest_limit === undefined) {
    return undefined;
  }
  const plan = denial.suggest_plan_key.charAt(0).toUpperCase() + denial.suggest_plan_key.slice(1);
  return `(${plan} allows ${denial.suggest_limit})`;
}

let entitlementEventSeq = 0;

/**
 * §四-E `entitlement.limit_reached` 事件（stream.resp RuntimeEvent）。
 * 只构造不发送；调用方 `reporter.appendEvents([event])` 并自行兜底失败。
 */
export function buildEntitlementLimitReachedEvent(input: {
  sessionId: string;
  turnId: string;
  reporter: TurnEventReporter;
  denial: EntitlementDenial;
}): StreamRespEvent {
  entitlementEventSeq += 1;
  const agentMessage: AgentMessage = {
    msg_id: `entitlement_${Date.now()}_${entitlementEventSeq}`,
    msg_type: MsgType.SystemEvent,
    msg_content: JSON.stringify({
      eventType: ENTITLEMENT_LIMIT_REACHED_EVENT_TYPE,
      ...input.denial,
    }),
  };
  const respData: RespData = {
    type: RespDataType.AgentMessage,
    agent_message: agentMessage,
  };
  return buildStreamRespEvent({
    sessionId: input.sessionId,
    turnId: input.turnId,
    eventId: input.reporter.nextEventId('entitlement_limit_reached'),
    runtimeSeq: input.reporter.nextRuntimeSeq(),
    respData,
  });
}

/** 测试隔离用：重置事件 msg_id 序号。 */
export function _resetEntitlementEventSeqForTests(): void {
  entitlementEventSeq = 0;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function quotaNumber(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
