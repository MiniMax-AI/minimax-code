import {
  SystemReminderService,
  createDefaultRegistry,
  withMcodeToolsMasterReminder,
  type Logger as SystemReminderLogger,
  type SystemReminderDiagnostic,
} from '@mavis/system-reminder';

import type { LocalRuntimeConfig } from '../config/types.js';
import { logger } from '../common/logger.js';
import {
  LocalDataCollector,
  type LocalAgentFactsReader,
  type LocalReminderMessageRequest,
  type LocalReminderSessionInfo,
} from '../memory/local-data-collector.js';
import { LocalMemoryFacade } from '../memory/local-memory-facade.js';
import type { LocalMemoryBusEmitter } from '../memory/local-memory-orchestration.js';
import type { CliSunsetNoticeEvaluator } from '../memory/cli-sunset-notice.js';

/**
 * Per-turn reminder clock: `Date#toString()` without seconds (e.g.
 * `Fri Oct 09 2026 13:20 GMT+0800 (China Standard Time)`). Minute precision
 * keeps the zone/offset the model relies on while avoiding a value that is
 * unique to every second.
 */
export function formatReminderDate(nowMs: number): string {
  return new Date(nowMs).toString().replace(/(\d{2}:\d{2}):\d{2}/u, '$1');
}

export function createLocalMemorySubsystem(input: {
  configGetter: () => LocalRuntimeConfig;
  nowMs: () => number;
  emitBusEvent: LocalMemoryBusEmitter;
  /** Host-owned Cron availability. Omit to keep the legacy "available" default. */
  cronEnabled?: () => boolean;
  /** Host-owned user-scoped Memory availability. Omit to keep it enabled. */
  userMemoryEnabled?: () => boolean;
  cliSunsetNotice?: CliSunsetNoticeEvaluator;
  agentFacts?: () => LocalAgentFactsReader | undefined;
  userConfiguredName?: () => string | undefined;
}) {
  const memoryFacade = new LocalMemoryFacade({
    config: () => ({
      dataDir: input.configGetter().dataDir,
      enabled: input.configGetter().memory?.enabled !== false,
    }),
    nowMs: input.nowMs,
    emitBusEvent: input.emitBusEvent,
  });
  const localDataCollector = new LocalDataCollector(memoryFacade, {
    dataDir: () => input.configGetter().dataDir,
    memoryEnabled: () => input.configGetter().memory?.enabled !== false,
    ...(input.userMemoryEnabled ? { userMemoryEnabled: input.userMemoryEnabled } : {}),
    ...(input.cronEnabled ? { cronEnabled: input.cronEnabled } : {}),
    proactiveMemoryEnabled: () => {
      const memory = input.configGetter().memory;
      return memory?.enabled !== false && memory?.proactive === true;
    },
    formatDate: () => formatReminderDate(input.nowMs()),
    emitBusEvent: input.emitBusEvent,
    nowMs: input.nowMs,
    ...(input.cliSunsetNotice ? { cliSunsetNotice: input.cliSunsetNotice } : {}),
    agentFacts: input.agentFacts,
    userConfiguredName: input.userConfiguredName,
  });
  const systemReminderService = new LocalSystemReminderService(
    localDataCollector,
    input.configGetter,
    input.emitBusEvent,
  );
  return { memoryFacade, localDataCollector, systemReminderService };
}

export class LocalSystemReminderService {
  private readonly service: SystemReminderService;

  constructor(
    private readonly collector: LocalDataCollector,
    private readonly configGetter: () => LocalRuntimeConfig,
    private readonly emitBusEvent?: LocalMemoryBusEmitter,
  ) {
    const srLogger: SystemReminderLogger = {
      warn: (ctx, msg) => logger.warn({ ...ctx }, msg),
      info: (ctx, msg) => logger.info({ ...ctx }, msg),
      error: (ctx, msg) => logger.error({ ...ctx }, msg),
    };
    const registry = createDefaultRegistry((ts) => new Date(ts).toString());
    this.service = new SystemReminderService(
      this.collector,
      registry,
      this.configGetter().dataDir,
      srLogger,
      () => ({ traceId: 'local-runtime-system-reminder' }),
      { disableModelPrefixes: [] },
    );
  }

  async buildReminder(
    session: LocalReminderSessionInfo,
    msg: LocalReminderMessageRequest,
    options?: { withDiagnostic?: boolean; deferTelemetry?: boolean },
  ): Promise<{
    text: string;
    diagnostic?: SystemReminderDiagnostic;
    finalizeTelemetry?: (input: { readonly text: string; readonly diagnostic?: unknown }) => void;
  }> {
    const beta = this.configGetter().beta;
    const result = await this.service.buildReminder(
      session,
      msg,
      options?.withDiagnostic ? { withDiagnostic: true } : undefined,
    );
    const text =
      withMcodeToolsMasterReminder({
        reminderText: result.text,
        modelID: msg.model?.modelID,
        enabled: beta?.mcodeTools === true,
      }) ?? '';
    const memoryBlockNames = extractMemoryBlockNames(text);
    const finalizeTelemetry = once(
      (input: { readonly text: string; readonly diagnostic?: unknown }) =>
        this.recordSystemReminderTelemetry({
          sessionId: session.sessionId,
          turnId: msg.turnId,
          agentName: session.agentName,
          ...input,
        }),
    );
    if (!options?.deferTelemetry) finalizeTelemetry({ text, diagnostic: result.diagnostic });
    this.emitBusEvent?.(
      memoryBlockNames.length > 0 ? 'memory.provider_injected' : 'memory.provider_skipped',
      {
        sessionId: session.sessionId,
        turnId: msg.turnId,
        agentName: session.agentName,
        blockNames: memoryBlockNames,
        blockCount: memoryBlockNames.length,
        ...(memoryBlockNames.length > 0 ? {} : { reason: 'no_blocks' }),
      },
    );
    const deferredTelemetry = options?.deferTelemetry ? { finalizeTelemetry } : {};
    if (!options?.withDiagnostic) return { text, ...deferredTelemetry };
    return {
      text,
      ...deferredTelemetry,
      ...(result.diagnostic
        ? { diagnostic: { ...result.diagnostic, fullText: text || null } }
        : {}),
    };
  }

  private recordSystemReminderTelemetry(input: {
    readonly sessionId: string;
    readonly turnId?: string;
    readonly agentName: string;
    readonly text: string;
    readonly diagnostic?: unknown;
  }): void {
    this.emitBusEvent?.(input.text ? 'system_reminder.injected' : 'system_reminder.skipped', {
      ...readSystemReminderEventAttributes(input.diagnostic),
      sessionId: input.sessionId,
      turnId: input.turnId,
      agentName: input.agentName,
      ...(input.text ? { bytes: Buffer.byteLength(input.text, 'utf8') } : { reason: 'no_blocks' }),
    });
  }
}

function once<TInput>(callback: (input: TInput) => void): (input: TInput) => void {
  let called = false;
  return (input) => {
    if (called) return;
    called = true;
    callback(input);
  };
}

type SystemReminderEventAttribute = boolean | number | string;

const RESERVED_SYSTEM_REMINDER_EVENT_ATTRIBUTES = new Set([
  'agentName',
  'bytes',
  'reason',
  'sessionId',
  'turnId',
]);

function readSystemReminderEventAttributes(
  diagnostic: unknown,
): Readonly<Record<string, SystemReminderEventAttribute>> {
  if (!isRecord(diagnostic)) return {};
  const eventAttributes = diagnostic.eventAttributes;
  if (!isRecord(eventAttributes)) return {};

  const accepted: Record<string, SystemReminderEventAttribute> = {};
  for (const [key, value] of Object.entries(eventAttributes)) {
    if (
      !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(key) ||
      RESERVED_SYSTEM_REMINDER_EVENT_ATTRIBUTES.has(key)
    ) {
      continue;
    }
    if (
      typeof value === 'boolean' ||
      typeof value === 'string' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      accepted[key] = value;
    }
  }
  return accepted;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function extractMemoryBlockNames(text: string): string[] {
  const memoryBlockNameByTag = new Map([
    ['agent_memory_update', 'agent_memory_update'],
    ['user_memory_update', 'user_memory_update'],
    ['memory_summary_update', 'memory_summary_update'],
    ['daily_memory_update', 'daily_memory_update'],
    ['proactive-memory', 'proactive_memory'],
  ]);
  return [...text.matchAll(/<([a-z_-]+)>/gu)]
    .map((match) => memoryBlockNameByTag.get(match[1]!))
    .filter((name): name is string => name !== undefined);
}
