import type { PiAfterLlmCallHook } from '@mavis/agent-core/pi-turn-runner';
import type { AgentExtension } from '@mavis/agent-runtime';
import type { BrowserUseTurnToolSafetyGuard } from './contracts.js';

const ASK_USER_TOOL_NAME = 'ask_user';
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

export function createBrowserUseExtension(options: {
  readonly requiredSkillName: (sessionId: string, turnId: string) => string | undefined;
  readonly clearTurn: (sessionId: string, turnId: string) => void;
}): AgentExtension {
  const exclusiveSkillStep = createBrowserSkillExclusiveStepHook(options);
  return {
    id: 'browser-use-policy',
    description: 'Enforces Browser Skill ordering before Browser tool execution.',
    init(api): void {
      api.on('after_llm_call', (input) => exclusiveSkillStep(input));
      api.on('turn_end', (event) => options.clearTurn(event.sessionId, event.turnId));
    },
  };
}

export function createBrowserUseTurnToolSafetyGuard(options: {
  readonly rejectLegacyFeatureEnable: boolean;
}): BrowserUseTurnToolSafetyGuard {
  let requiredTool: typeof ASK_USER_TOOL_NAME | undefined;
  // run_code calls whose Browser children must stop: a program cannot be
  // trusted to check r.isError, and a later dependent action on the shared
  // page must not run after an earlier one failed.
  const stoppedPrograms = new Set<string>();
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
      if (!requiredTool || input.toolCall.name === requiredTool) return undefined;
      return {
        block: true,
        reason:
          `REQUIRED_NEXT_TOOL: Browser requires an actual ${requiredTool} tool call before ` +
          `any other tool; blocked ${input.toolCall.name}.`,
      };
    },
    afterToolCall(input) {
      // A trusted Browser result can be marked as an error after compact
      // result bounding while still carrying a binding takeover marker.
      if (!isTrustedBrowserToolCall(input.toolCall)) return;
      if (input.parentToolCallId && input.isError) stoppedPrograms.add(input.parentToolCallId);
      if (readRequiredNextTool(input.result?.details) === ASK_USER_TOOL_NAME) {
        requiredTool = ASK_USER_TOOL_NAME;
      }
    },
  };
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

function readRequiredNextTool(details: unknown): string | undefined {
  if (!isRecord(details)) return undefined;
  const result = details.result;
  if (!isRecord(result)) return undefined;
  const safety = result.safety;
  if (!isRecord(safety)) return undefined;
  return typeof safety.requiredNextTool === 'string' ? safety.requiredNextTool : undefined;
}

function readSkillName(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const name = Reflect.get(value, 'name');
  return typeof name === 'string' ? name : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
