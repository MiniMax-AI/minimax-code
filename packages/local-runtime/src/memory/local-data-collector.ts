import { existsSync } from "node:fs";
import { join } from "node:path";

import type { ResolvedAgentCapabilities } from "@mavis/config";
import { getRuntimeRegion } from "@mavis/config";
import {
  AgentFrameworkType,
  AgentRole,
  Role,
  SessionType,
  type MessageRequest,
  type SessionInfo,
  type SystemReminderInput,
} from "@mavis/system-reminder";
import type {
  GetAgentInput as GetAgentInput,
  GetAgentResult as GetAgentResult,
} from "@mavis/protocol/local";

import type { LocalSessionRecord } from "../sessions/controller.js";
import { isLocalDirectTaskPurpose } from "../sessions/session-policy.js";
import type { LocalMemoryFacade } from "./local-memory-facade.js";
import {
  loadCliSunsetCandidates,
  type CliSunsetNoticeEvaluator,
} from "./cli-sunset-notice.js";
import { detectProjectInstructions } from "../project/instructions.js";
import { resolveLocalRuntimeLocale } from "../runtime/locale.js";
import { formatLocalDate } from "./local-memory-store-utils.js";
import {
  agentDetailToIdentity,
  isBuiltinAgentDetail,
  isPersonaMissing,
  toCreationSource,
} from "./local-data-agent-profile.js";

type MemorySnapshot = Awaited<
  ReturnType<LocalMemoryFacade["collectReminderMemory"]>
>;
type MemoryBaseline = {
  canonicalAgentName: string;
  main?: string;
  summary?: string;
  user?: string;
  daily?: string;
};

/** Read-only Agent facts port. V2 supplies this directly from AgentService. */
export type LocalAgentFactsReader = {
  getAgent(request: GetAgentInput): Promise<GetAgentResult>;
};

export type LocalReminderSessionInfo = SessionInfo & {
  environmentInSystemPrompt?: boolean;
  /** See `AgentEnv.sessionIdInContext`. */
  sessionIdInContext?: boolean;
  parentSessionId?: string | null;
  rootSessionId?: string;
  isDefaultWorkspace?: boolean;
  builtinCapabilities?: ResolvedAgentCapabilities;
  /** Frozen execution target and trusted family read-through for Memory only. */
  memoryExecutionTarget?: string;
  memoryRecallEnabled?: boolean;
  memoryWriteEnabled?: boolean;
  taskResultDelivery?: "runtime-managed";
};
export type LocalReminderMessageRequest = MessageRequest;
export type LocalReminderInput = SystemReminderInput;

export class LocalDataCollector {
  private readonly baselines = new Map<string, MemoryBaseline>();

  constructor(
    private readonly memory: LocalMemoryFacade,
    private readonly input: {
      dataDir: () => string;
      memoryEnabled: () => boolean;
      /** Whether this host may read the user-scoped `user.md` memory file. */
      userMemoryEnabled?: () => boolean;
      /**
       * Whether this host can actually schedule Cron work. Absent means
       * "assume available" so existing hosts/tests keep their behavior.
       */
      cronEnabled?: () => boolean;
      proactiveMemoryEnabled?: () => boolean;
      formatDate: () => string;
      emitBusEvent?: (type: string, payload: Record<string, unknown>) => void;
      nowMs?: () => number;
      cliSunsetNotice?: CliSunsetNoticeEvaluator;
      agentFacts?: () => LocalAgentFactsReader | undefined;
      userConfiguredName?: () => string | undefined;
    },
  ) {}

  async collect(
    session: LocalReminderSessionInfo,
    msg: LocalReminderMessageRequest,
    turnCount: number,
  ): Promise<LocalReminderInput> {
    const agentName = session.agentName?.trim();
    const memoryGloballyEnabled = this.input.memoryEnabled();
    const userMemoryEnabled = this.input.userMemoryEnabled?.() !== false;
    const reader = agentName ? this.input.agentFacts?.() : undefined;
    const factsAgentName = agentName;
    const detail =
      reader && factsAgentName
        ? await reader
            .getAgent({ name: factsAgentName, include: "identity,persona" })
            .then((response) => response.agent)
            .catch((error: unknown) => {
              const candidate = Object(error) as {
                status?: unknown;
                code?: unknown;
              };
              if (
                candidate.status === 404 ||
                candidate.code === "AGENT_NOT_FOUND"
              ) {
                return undefined;
              }
              throw error;
            })
        : undefined;
    const agentMemoryEnabled =
      memoryGloballyEnabled &&
      isPrimaryAgent(agentName ?? "") &&
      detail !== undefined &&
      isTrustedPrimaryAgentDetail(detail);
    const memoryRecallEnabled =
      agentMemoryEnabled && session.memoryRecallEnabled !== false;
    const memoryWriteEnabled =
      agentMemoryEnabled && session.memoryWriteEnabled !== false;
    const memoryAccessible = memoryRecallEnabled || memoryWriteEnabled;
    if (memoryAccessible && !agentName) {
      // No agent directory name → nothing to address agent-scoped memory against.
      // Silent "no memory" would make "why was no memory injected this turn" only
      // inferable by absence, so surface it as an event.
      this.input.emitBusEvent?.("memory.provider_agent_resolve_failed", {
        sessionId: session.sessionId,
        turnId: msg.turnId,
        agentName: session.agentName,
        error: "session has no agentName",
      });
    }
    // SystemReminder tracks only the canonical writable Memory target. Retired
    // aliases are injected as explicitly read-only durable context by the
    // static system-prompt builder; they are not a second dynamic delta source.
    const canonicalSnapshot =
      memoryAccessible && agentName
        ? await this.collectCanonicalMemory(session, msg, agentName)
        : undefined;
    const userMemory = userMemoryEnabled
      ? await this.readUserMemory(session, msg)
      : undefined;
    const currentDaily = canonicalSnapshot
      ? await this.readCanonicalDaily(session, msg)
      : undefined;
    const canonicalAgentName =
      session.memoryExecutionTarget?.trim() || agentName || session.agentName;
    const previous = this.baselines.get(session.sessionId);
    const baseline =
      previous?.canonicalAgentName === canonicalAgentName
        ? previous
        : undefined;
    if (
      (memoryRecallEnabled && canonicalSnapshot) ||
      userMemory !== undefined
    ) {
      this.baselines.set(session.sessionId, {
        canonicalAgentName,
        ...(memoryRecallEnabled && canonicalSnapshot
          ? {
              main: canonicalSnapshot.main,
              summary: canonicalSnapshot.summary,
            }
          : {}),
        ...(userMemory !== undefined ? { user: userMemory } : {}),
        ...(memoryRecallEnabled && canonicalSnapshot
          ? { daily: currentDaily }
          : {}),
      });
    }
    const identity = detail ? agentDetailToIdentity(detail) : null;
    const personaEnabled =
      session.builtinCapabilities?.persona.enabled !== false;
    const persona =
      personaEnabled && detail && factsAgentName
        ? await isPersonaMissing({
            agentConfigDir:
              detail.agentConfigDir ??
              join(this.input.dataDir(), "agents", factsAgentName),
            identityDisplayName: identity?.display_name,
            builtin: isBuiltinAgentDetail(detail),
            builtinPersona: detail.persona,
          })
        : undefined;

    const deltas =
      baseline && canonicalSnapshot
        ? diffMemory(baseline, canonicalSnapshot, currentDaily)
        : {};
    const userDelta =
      baseline && userMemory !== undefined && userMemory !== baseline.user
        ? userMemory.trim()
        : undefined;
    const dataDir = this.input.dataDir();
    const workspaceDir = session.workspaceDir ?? process.cwd();
    const agentRole = detail
      ? detail.agentRole === "orchestrator"
        ? "orchestrator"
        : "worker"
      : session.agentRole === AgentRole.Orchestrator
        ? "orchestrator"
        : "worker";
    const sessionType = session.sessionType === SessionType.Root ? 1 : 0;
    const userConfiguredName = this.input.userConfiguredName?.()?.trim();
    return {
      env: {
        environmentInSystemPrompt: session.environmentInSystemPrompt,
        workspaceDir,
        isDefaultWorkspace: session.isDefaultWorkspace ?? true,
        agentConfigDir: `${dataDir}/agents/${agentName}`,
        agentName,
        agentRole,
        sessionId: session.sessionId,
        ...(session.sessionIdInContext ? { sessionIdInContext: true } : {}),
        sessionType,
        parentSessionId: session.parentSessionId ?? undefined,
        taskResultDelivery: session.taskResultDelivery,
        rootSessionId: session.rootSessionId,
        platform: process.platform,
        scene: "local",
        date: this.input.formatDate(),
        dataDir,
        scratchpadPath: session.scratchpadPath,
        systemLocale: resolveLocalRuntimeLocale(),
        region: getRuntimeRegion(),
        projectInstructions: detectProjectInstructions(workspaceDir),
        ...(identity?.display_name
          ? { displayName: identity.display_name }
          : {}),
        ...(userConfiguredName ? { userConfiguredName } : {}),
      },
      turnCount,
      teamModeOff: true,
      ...(memoryWriteEnabled && this.input.proactiveMemoryEnabled?.() === true
        ? { proactiveMemoryEnabled: true }
        : {}),
      mavisEnabled: session.builtinCapabilities?.features.mavis !== false,
      ...(this.input.cronEnabled
        ? { cronEnabled: this.input.cronEnabled() }
        : {}),
      ...(identity ? { identity } : {}),
      ...(persona
        ? { personaMissing: persona.missing, personaPath: persona.personaPath }
        : {}),
      workspaceDir,
      isGitWorkspace: isGitCheckout(workspaceDir),
      isInsideWorktree: isInsideWorktree(workspaceDir),
      creationSource: toCreationSource(detail?.creationSource),
      ...(memoryRecallEnabled && canonicalSnapshot?.summary.trim()
        ? { memorySummaryUpdate: canonicalSnapshot.summary.trim() }
        : {}),
      ...(memoryRecallEnabled ? deltas : {}),
      ...(userMemoryEnabled && userDelta
        ? { userMemoryUpdate: userDelta }
        : {}),
      ...(memoryWriteEnabled && canonicalSnapshot?.main.trim()
        ? {
            memorySkillReminder: {
              path: canonicalSnapshot.mainPath,
              lines: canonicalSnapshot.mainLines,
              sizeBytes: canonicalSnapshot.mainSizeBytes,
            },
          }
        : {}),
      ...(memoryRecallEnabled && canonicalSnapshot?.topics.length
        ? { memoryTopics: canonicalSnapshot.topics }
        : {}),
      ...(memoryRecallEnabled && canonicalSnapshot && turnCount <= 1
        ? await this.collectCliSunsetNotice(canonicalSnapshot)
        : {}),
    };
  }

  private async collectCanonicalMemory(
    session: LocalReminderSessionInfo,
    msg: LocalReminderMessageRequest,
    agentName: string,
  ): Promise<MemorySnapshot | undefined> {
    try {
      return await this.memory.collectReminderMemory(agentName);
    } catch (err) {
      this.input.emitBusEvent?.("memory.provider_collect_failed", {
        sessionId: session.sessionId,
        turnId: msg.turnId,
        agentName,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  private async readUserMemory(
    session: LocalReminderSessionInfo,
    msg: LocalReminderMessageRequest,
  ): Promise<string | undefined> {
    try {
      return (await this.memory.getUserMemory()).content;
    } catch (err) {
      this.input.emitBusEvent?.("memory.provider_user_collect_failed", {
        sessionId: session.sessionId,
        turnId: msg.turnId,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  private async readCanonicalDaily(
    session: LocalReminderSessionInfo,
    msg: LocalReminderMessageRequest,
  ): Promise<string> {
    const agentName =
      session.memoryExecutionTarget?.trim() || session.agentName?.trim();
    if (!agentName) return "";
    try {
      const date = formatLocalDate(this.input.nowMs?.() ?? Date.now());
      return (await this.memory.getDaily(agentName, date)).content;
    } catch (err) {
      this.input.emitBusEvent?.("memory.provider_daily_collect_failed", {
        sessionId: session.sessionId,
        turnId: msg.turnId,
        agentName,
        error: err instanceof Error ? err.message : String(err),
      });
      return "";
    }
  }

  private async collectCliSunsetNotice(
    memory: Awaited<ReturnType<LocalMemoryFacade["collectReminderMemory"]>>,
  ): Promise<Pick<LocalReminderInput, "cliSunsetMemoryNotice">> {
    const notice = await this.input.cliSunsetNotice?.evaluate(
      this.input.nowMs?.() ?? Date.now(),
      () =>
        loadCliSunsetCandidates({
          mainPath: memory.mainPath,
          mainContent: memory.main,
          userPath: memory.userPath,
          userContent: memory.user,
          topicPaths: memory.topics.map((topic) => topic.path),
        }),
    );
    return notice ? { cliSunsetMemoryNotice: notice } : {};
  }

  onSessionRemoved(sessionId: string): void {
    this.baselines.delete(sessionId);
  }

  toSessionInfo(
    session: LocalSessionRecord,
    builtinCapabilities?: ResolvedAgentCapabilities,
    memory?: {
      executionTarget?: string;
      recallEnabled?: boolean;
      writeEnabled?: boolean;
    },
  ): LocalReminderSessionInfo {
    const isRoot = session.sessionType === "root";
    const runtimeAgentName =
      memory?.executionTarget?.trim() || session.agentName;
    return {
      sessionId: session.sessionId,
      // SystemReminder facts/persona/config are execution-scoped. The
      // persisted session owner remains available to lifecycle/event callers
      // through the original LocalSessionRecord and is never rewritten here.
      agentName: runtimeAgentName,
      agentRole: isPrimaryAgent(runtimeAgentName)
        ? AgentRole.Orchestrator
        : AgentRole.Worker,
      sessionType: isRoot ? SessionType.Root : SessionType.Branch,
      frameworkType:
        session.runtime === "pi-agent"
          ? AgentFrameworkType.PiAgent
          : AgentFrameworkType.OpenCode,
      workspaceDir: session.workspaceDir,
      isDefaultWorkspace: session.isDefaultWorkspace,
      parentSessionId: session.parentSessionId,
      ...(session.sessionType === "branch" &&
      !!session.parentSessionId &&
      isLocalDirectTaskPurpose(session.purpose)
        ? { taskResultDelivery: "runtime-managed" as const }
        : {}),
      scratchpadPath: session.scratchpadPath,
      createdAt: session.createdAtMs,
      updatedAt: session.updatedAtMs,
      ...(builtinCapabilities ? { builtinCapabilities } : {}),
      ...(memory?.executionTarget
        ? { memoryExecutionTarget: memory.executionTarget }
        : {}),
      ...(memory?.recallEnabled !== undefined
        ? { memoryRecallEnabled: memory.recallEnabled }
        : {}),
      ...(memory?.writeEnabled !== undefined
        ? { memoryWriteEnabled: memory.writeEnabled }
        : {}),
    };
  }

  toMessage(
    content: string,
    turnId: string,
    model?: MessageRequest["model"],
  ): LocalReminderMessageRequest {
    return {
      content,
      fromRole: Role.User,
      turnId,
      ...(model ? { model } : {}),
    };
  }
}

function diffMemory(
  prev: { main?: string; summary?: string; daily?: string },
  current: { main?: string; summary?: string },
  daily: string | undefined,
): Partial<
  Pick<
    LocalReminderInput,
    "agentMemoryUpdate" | "memorySummaryUpdate" | "dailyMemoryUpdate"
  >
> {
  return {
    ...(current.main && current.main !== prev.main
      ? { agentMemoryUpdate: suffix(prev.main, current.main) }
      : {}),
    ...(current.summary && current.summary !== prev.summary
      ? { memorySummaryUpdate: current.summary.trim() }
      : {}),
    ...(daily !== undefined && daily.trim() && daily !== prev.daily
      ? { dailyMemoryUpdate: daily.trim() }
      : {}),
  };
}

function suffix(prev: string | undefined, current: string): string {
  if (prev && current.startsWith(prev))
    return current.slice(prev.length).trim();
  return current.trim();
}

function isPrimaryAgent(agentName: string): boolean {
  return agentName === "mavis" || agentName === "main";
}

function isTrustedPrimaryAgentDetail(
  detail: NonNullable<
    Awaited<ReturnType<LocalAgentFactsReader["getAgent"]>>["agent"]
  >,
): boolean {
  return (
    isBuiltinAgentDetail(detail) && isPrimaryAgent(detail.name?.trim() ?? "")
  );
}

function isGitCheckout(workspaceDir: string): boolean {
  return existsSync(join(workspaceDir, ".git"));
}

function isInsideWorktree(workspaceDir: string): boolean {
  return (
    existsSync(join(workspaceDir, ".git")) &&
    !existsSync(join(workspaceDir, ".git", "HEAD"))
  );
}
