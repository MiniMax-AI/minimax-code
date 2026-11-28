import type { PiAfterLlmCallHook } from '@mavis/agent-core/pi-turn-runner';
import type { AgentExtension } from '@mavis/agent-runtime';
import type { BrowserUseTurnToolSafetyGuard } from './contracts.js';

const SKILL_TOOL_NAME = 'skill';

export function isBrowserUseToolingAvailable(
  filePanelBrowserEnabled: boolean | undefined,
  browserUseToolingEnabled: boolean | undefined,
  provider?: string,
): boolean {
  if (browserUseToolingEnabled !== true) return false;
  const normalizedProvider = provider?.trim();
  return normalizedProvider && normalizedProvider !== 'electron-file-panel'
    ? true
    : filePanelBrowserEnabled === true;
}

function createBrowserSkillExclusiveStepHook(options: {
  readonly requiredSkillName: (sessionId: string, turnId: string) => string | undefined;
}): PiAfterLlmCallHook {
  return async (input) => {
    const requiredSkillName = options.requiredSkillName(input.sessionId, input.turnId);
    if (!requiredSkillName) return undefined;
    const toolCalls = input.message.content.filter((block) => block.type === 'toolCall');
    if (toolCalls.length < 2) return undefined;

    const loadsBrowserSkill = toolCalls.some(
      (toolCall) =>
        toolCall.name === SKILL_TOOL_NAME &&
        readSkillName(toolCall.arguments) === requiredSkillName,
    );
    if (!loadsBrowserSkill) return undefined;

    return {
      type: 'retry',
      reason: 'browser_skill_must_be_loaded_alone',
      prompt:
        `Load ${requiredSkillName} in an assistant step containing only the ` +
        '`skill` tool call. Do not call Browser, shell, file, or any other tool in the same ' +
        'assistant response. After the Skill result returns, decide the next Browser action in ' +
        'a new assistant response.',
    };
  };
}

export type BrowserUseLifecycleEventType = 'turn_end';

export function createBrowserUseExtension(options: {
  readonly requiredSkillName: (sessionId: string, turnId: string) => string | undefined;
  readonly clearTurn: (sessionId: string, turnId: string) => void;
  /**
   * Agent Browser control lifecycle: turn end (completed, failed or stopped)
   * releases the tab lease and tidies Agent pages. ask_user does not change
   * Browser control: the model hands a page to the user with release_tab.
   */
  readonly notifyLifecycle?: (
    type: BrowserUseLifecycleEventType,
    sessionId: string,
    turnId: string,
  ) => void;
}): AgentExtension {
  const exclusiveSkillStep = createBrowserSkillExclusiveStepHook(options);
  const notify = (type: BrowserUseLifecycleEventType, sessionId: string, turnId: string) => {
    try {
      options.notifyLifecycle?.(type, sessionId, turnId);
    } catch {
      // Browser lifecycle delivery is best-effort and never changes the Turn.
    }
  };
  return {
    id: 'browser-use-policy',
    description: 'Enforces Browser Skill ordering before Browser tool execution.',
    init(api): void {
      api.on('after_llm_call', (input) => exclusiveSkillStep(input));
      api.on('turn_end', (event) => {
        options.clearTurn(event.sessionId, event.turnId);
        notify('turn_end', event.sessionId, event.turnId);
      });
    },
  };
}

/**
 * Browser actions that read the page without changing it. One of these
 * failing inside run_code (a selector that matched nothing, a wait that timed
 * out) leaves the page as it was, so the program's later Browser calls may
 * still run.
 */
const READ_ONLY_BROWSER_ACTIONS: Readonly<Record<string, true>> = {
  inspect: true,
  query: true,
  wait: true,
  screenshot: true,
  list_tabs: true,
};

export function createBrowserUseTurnToolSafetyGuard(options: {
  readonly rejectLegacyFeatureEnable: boolean;
}): BrowserUseTurnToolSafetyGuard {
  // run_code calls whose Browser children must stop: a program cannot be
  // trusted to check r.isError, and a later dependent action on the shared
  // page must not run after an earlier one failed. A failed read does not
  // stop it. Child calls exist only in PTC turns (toolCallMode 'ptc').
  const stoppedPrograms = new Set<string>();
  // An authentication takeover marker (`safety.requiredNextTool`) is only a
  // prompt-level signal for the model; this guard never blocks tools on it.
  return {
    beforeToolCall(input) {
      if (options.rejectLegacyFeatureEnable && isLegacyBrowserFeatureEnable(input)) {
        return {
          block: true,
          reason:
            'BROWSER_PLUGIN_MANAGED: Desktop Browser control is managed by the Browser Use Plugin; the legacy request_feature_enable card is not accepted.',
        };
      }
      if (
        input.parentToolCallId &&
        stoppedPrograms.has(input.parentToolCallId) &&
        isBrowserToolName(input.toolCall.name)
      ) {
        return {
          block: true,
          reason:
            'BROWSER_PTC_STOPPED: an earlier Browser call in this run_code program failed, so later Browser calls of the program do not run. Return, read the failure, and decide the next step.',
        };
      }
      return undefined;
    },
    afterToolCall(input) {
      if (!input.parentToolCallId || !isTrustedBrowserToolCall(input.toolCall)) return;
      if (
        input.isError &&
        !isReadOnlyFailureWithKnownOutcome(input.toolCall.name, input.args, input.result)
      ) {
        stoppedPrograms.add(input.parentToolCallId);
      }
    },
  };
}

/**
 * A failed read-only Browser call (the compact `browser` tool's `action`, or a
 * split `browser_<action>` tool) whose error does not leave the page state
 * unknown.
 */
function isReadOnlyFailureWithKnownOutcome(
  toolName: string,
  args: unknown,
  result: unknown,
): boolean {
  const details = isRecord(result) && isRecord(result.details) ? result.details : undefined;
  // The result names the action; a split `browser_<action>` tool names it too.
  const action = [
    details?.action,
    isRecord(args) ? args.action : undefined,
    toolName.replace(/^browser_/u, ''),
  ].find((value) => typeof value === 'string');
  if (typeof action !== 'string' || READ_ONLY_BROWSER_ACTIONS[action] !== true) return false;
  const browserResult = isRecord(details?.result) ? details.result : undefined;
  // BROWSER_OPERATION_TIMEOUT leaves the page state unknown even for a read:
  // the page stopped answering and the tab may have been reset.
  return (
    details?.code !== 'BROWSER_OPERATION_TIMEOUT' &&
    browserResult?.code !== 'BROWSER_OPERATION_TIMEOUT'
  );
}

function isLegacyBrowserFeatureEnable(
  input: Parameters<BrowserUseTurnToolSafetyGuard['beforeToolCall']>[0],
): boolean {
  if (input.toolCall.name !== 'request_feature_enable') return false;
  const source = (input.toolCall as { readonly source?: unknown }).source;
  if (source !== undefined && source !== 'builtin') return false;
  return isRecord(input.args) && input.args.featureKey === 'browser-use';
}

/**
 * Before admission the Plugin alias (`mcp_browser`) is still the public name;
 * afterToolCall sees the admitted target. Blocking an imitation is harmless.
 */
function isBrowserToolName(name: string): boolean {
  return name === 'browser' || name === 'mcp_browser' || name.startsWith('browser_');
}

function isTrustedBrowserToolCall(toolCall: { readonly name: string }): boolean {
  const name = toolCall.name;
  if (name !== 'browser' && !name.startsWith('browser_')) return false;

  // Runtime-native tools historically had no source marker. When a marker is
  // present, reject configured/MCP tools that merely imitate a Browser name.
  const source = (toolCall as { readonly source?: unknown }).source;
  return source === undefined || source === 'builtin';
}

function readSkillName(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const name = Reflect.get(value, 'name');
  return typeof name === 'string' ? name : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
