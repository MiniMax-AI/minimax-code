import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, AssistantMessage, Message, Model } from '@earendil-works/pi-ai';
import {
  projectAgentMessagesForModel,
  type PiLlmCallPreparedHookInput,
} from '@mavis/agent-core/pi-turn-runner';
import type { AgentExtension } from '@mavis/agent-runtime';

import type { ResolvedAdvisorModel } from '../../service/model-system/index.js';
import { ADVISOR_TOOL_NAME, readAdvisorBinding } from '../../service/turn-system/index.js';

/** The main model's question tool; the advisor is told whether the agent could ask the user. */
const ASK_USER_TOOL_NAME = 'ask_user';

/**
 * When to call the advisor, in the System Prompt of exactly the Turns that offer the tool: both
 * follow the Turn's advisor binding. It is a runtime contribution rather than prompt-asset text,
 * so seeded and custom prompts carry it too, and it comes and goes with the tool.
 */
const ADVISOR_SYSTEM_PROMPT_GUIDANCE = `<advisor>
The advisor tool is on in this session. Calling it hands your whole conversation so far to a stronger reviewer model and returns its advice. It takes no parameters; to ask about something specific, write the question in your reply right before the call.

Call advisor BEFORE substantive work: before writing, before committing to an interpretation, before building on an assumption. If the task needs orientation first (finding files, reading code), do that, then call advisor. Orientation is not substantive work; writing, editing and declaring an answer are.

Also call advisor:
- When you believe the task is complete. Before this call, make your deliverable durable: write the file, save the result.
- When stuck: errors recurring, approach not converging.
- When considering a change of approach.

On short reactive tasks where the next action is dictated by tool output you just read, you do not need to call it.

Give the advice serious weight. If a step fails empirically, or you have primary-source evidence that contradicts a specific claim, adapt. If your evidence points one way and the advisor points another, do not silently switch: state the conflict in your reply and call advisor once more.
</advisor>`;

/** Everything one `advisor` call needs, frozen when the main model issued the call. */
export interface AdvisorCallMaterial {
  readonly systemPrompt: string;
  /** Provider-visible messages, ending with the assistant message that called `advisor`. */
  readonly messages: readonly Message[];
  /** Whether the main request offered `ask_user`. */
  readonly canAskUser?: boolean;
  readonly binding: ResolvedAdvisorModel;
  /**
   * The Turn's user input when it is an ordinary input Turn: the text a managed main model's input
   * review covers. Continuations, recoveries and retries have none.
   */
  readonly userInput?: string;
}

interface PreparedRequestView {
  readonly systemPrompt: string;
  readonly messages: readonly AgentMessage[];
  readonly model: Model<Api>;
  readonly canAskUser: boolean;
}

interface TurnCaptures {
  latest?: PreparedRequestView;
  userInput?: string;
  readonly calls: Map<string, AdvisorCallMaterial>;
}

/**
 * Turn-scoped material for `advisor` calls. The latest prepared main request is kept per Turn;
 * each `advisor` call freezes it with its own assistant message under its tool call id. Every
 * entry is dropped after its call and at Turn end, so nothing survives a Turn.
 */
export class AdvisorCaptureStore {
  private readonly turns = new Map<string, TurnCaptures>();

  observeUserInput(sessionId: string, turnId: string, userInput: string): void {
    this.turn(sessionId, turnId).userInput = userInput;
  }

  observePrepared(input: PiLlmCallPreparedHookInput): void {
    this.turn(input.sessionId, input.turnId).latest = {
      systemPrompt: input.systemPrompt,
      messages: input.messages,
      model: input.model,
      canAskUser: input.tools.some((tool) => tool.name === ASK_USER_TOOL_NAME),
    };
  }

  captureCall(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly toolCallId: string;
    readonly assistantMessage: AssistantMessage;
    readonly binding: ResolvedAdvisorModel;
  }): void {
    const turn = this.turns.get(turnKey(input.sessionId, input.turnId));
    const view = turn?.latest;
    if (!turn || !view) return;
    // The same projection the main request went through, so the advisor reads what the
    // main model's next request would see.
    const projected = projectAgentMessagesForModel(
      [...view.messages, input.assistantMessage],
      view.model,
    ).messages;
    turn.calls.set(input.toolCallId, {
      systemPrompt: view.systemPrompt,
      messages: projected,
      canAskUser: view.canAskUser,
      binding: input.binding,
      ...(turn.userInput === undefined ? {} : { userInput: turn.userInput }),
    });
  }

  read(sessionId: string, turnId: string, toolCallId: string): AdvisorCallMaterial | undefined {
    return this.turns.get(turnKey(sessionId, turnId))?.calls.get(toolCallId);
  }

  releaseCall(sessionId: string, turnId: string, toolCallId: string): void {
    this.turns.get(turnKey(sessionId, turnId))?.calls.delete(toolCallId);
  }

  releaseTurn(sessionId: string, turnId: string): void {
    this.turns.delete(turnKey(sessionId, turnId));
  }

  /** Number of Turns holding material; for tests. */
  get size(): number {
    return this.turns.size;
  }

  private turn(sessionId: string, turnId: string): TurnCaptures {
    const key = turnKey(sessionId, turnId);
    const existing = this.turns.get(key);
    if (existing) return existing;
    const created: TurnCaptures = { calls: new Map() };
    this.turns.set(key, created);
    return created;
  }
}

/**
 * The advisor's part of a Turn: the System Prompt guidance on when to call it, and the capture
 * store fed from the Turn hooks (an ordinary Turn's user input, the final prepared request of
 * each main model call, the assistant message of each top-level `advisor` call, and cleanup).
 */
export function createAdvisorExtension(store: AdvisorCaptureStore): AgentExtension {
  return {
    id: 'advisor',
    description:
      'Tell the main model when to call the advisor, and capture the conversation it sees for those calls.',
    init(api) {
      api.contributeSystemPrompt((context) =>
        readAdvisorBinding(context.agentConfig.advisor)
          ? ADVISOR_SYSTEM_PROMPT_GUIDANCE
          : undefined,
      );
      api.on('turn_start', (event, ctx) => {
        if (event.isOrdinaryInputTurn && readAdvisorBinding(ctx.agentConfig.advisor)) {
          store.observeUserInput(event.sessionId, event.turnId, event.userInput.text);
        }
      });
      api.on('on_llm_call_prepared', (input, ctx) => {
        if (readAdvisorBinding(ctx.agentConfig.advisor)) store.observePrepared(input);
      });
      api.on('before_tool_call', (toolContext, _signal, ctx) => {
        if (toolContext.toolCall.name !== ADVISOR_TOOL_NAME || toolContext.parentToolCallId) {
          return undefined;
        }
        const binding = readAdvisorBinding(ctx.agentConfig.advisor);
        if (!binding) return undefined;
        store.captureCall({
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          toolCallId: toolContext.toolCall.id,
          assistantMessage: toolContext.assistantMessage,
          binding,
        });
        return undefined;
      });
      api.on('after_tool_call', (toolContext, _signal, ctx) => {
        if (toolContext.toolCall.name === ADVISOR_TOOL_NAME) {
          store.releaseCall(ctx.sessionId, ctx.turnId, toolContext.toolCall.id);
        }
        return undefined;
      });
      api.on('turn_end', (event) => {
        store.releaseTurn(event.sessionId, event.turnId);
      });
    },
  };
}

function turnKey(sessionId: string, turnId: string): string {
  return `${sessionId}\u0000${turnId}`;
}
