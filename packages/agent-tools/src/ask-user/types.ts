import type { ToolResult } from '@mavis/agent-core/tools';
import type { AskUserToolInput } from '@mavis/shared/questionnaire';

/** How a sync (v2) ask_user wait ended; Stop rejects instead of returning. */
export type LocalAskUserSyncOutcome =
  | {
      readonly kind: 'answered';
      /**
       * Goal + skip: nobody answered before the deadline, so the runtime
       * selected each question's recommended option. Not the user's choice.
       */
      readonly autoSelected?: true;
      /** Same `<questionnaire-response>` XML + summary a legacy answer message carries. */
      readonly content: string;
      readonly answers?: ReadonlyArray<{ question: string; answer: string }>;
      readonly imageContent?: ToolResult['content'];
      readonly contextImages?: ReadonlyArray<{
        stepId: string;
        contextId: string;
        annotationId: string;
        assetId?: string;
        filePath?: string;
        fileName?: string;
        mimeType?: string;
        status: 'inline' | 'unavailable' | 'unsupported_model' | 'limit';
      }>;
    }
  | {
      readonly kind: 'dismissed';
      /**
       * The question closed before the user acted on it: it expired, or a newer
       * question replaced it. The user can no longer answer it.
       */
      readonly closed?: 'expired' | 'superseded';
      readonly content?: string;
      readonly answers?: ReadonlyArray<{ question: string; answer: string }>;
    }
  /** A new user message was steered into this Turn. */
  | { readonly kind: 'new_message' }
  /**
   * A new user message was queued; it is handled only after this Turn ends.
   * `notAsked`: the message was already queued when the question was raised,
   * so the question was never shown.
   */
  | { readonly kind: 'new_message_queued'; readonly notAsked?: true };

/** AskUser v2 questionnaire (Desktop runtime Turn, including an IM-originated one). */
export interface LocalAskUserV2BeginResult {
  requestId: string;
  schemaVersion: number;
  stepCount: number;
  responseMode: 'sync' | 'async';
  /** The user's ask_user policy changed the mode the model requested via `async`. */
  policyOverridden: boolean;
  /** Present for sync calls: set once the in-Turn wait ended. */
  outcome?: LocalAskUserSyncOutcome;
}

export type LocalAskUserBeginResult =
  | { requestId: string; schemaVersion: number; stepCount: number }
  | LocalAskUserV2BeginResult
  | {
      /** Decision v3: the question was superseded by in-flight user steering. */
      suppressed: true;
      reason: 'user-steering-pending';
    };

/**
 * Host side of ask_user and request_feature_enable. `TContext` is the tool
 * execution context of the runtime that runs the tools; both tools only pass it
 * through to `begin`.
 */
export interface AskUserAdapter<TContext> {
  begin(
    ctx: TContext,
    input: AskUserToolInput,
    signal?: AbortSignal,
  ): Promise<LocalAskUserBeginResult>;
}
