/**
 * V2 multi-step questionnaire schema.
 *
 * Shared between daemon (runtime normalize/validate/serialize) and UI
 * (composer rendering). The schema is intentionally forward-compatible with
 * a future `PendingDecision.kind = "questionnaire"` substrate — `schemaVersion`
 * is pinned to `2` so consumers can branch cleanly when V3 lands.
 *
 * Reference: docs/tasks/multi-step-ask-answer-implementation-plan.html
 * (decision: composer replacement; one question per step; required by default;
 * Others always present; image optional with safe URL schemes only).
 */

// ---------------------------------------------------------------------------
// Step + option
// ---------------------------------------------------------------------------

/**
 * Single answer option presented to the user.
 *
 * `id` is stable so reply payloads can reference the same option after
 * navigation. `description` is optional extra hint text rendered next to the
 * option label (e.g. "the safer choice"). `image` is optional preview art
 * rendered above the label (e.g. screenshots of design candidates). All
 * string fields are sanitized — the UI MUST render them as plain text,
 * never as HTML.
 */
export interface AskQuestionOption {
  id: string;
  label: string;
  description?: string;
  image?: AskQuestionImage;
  /** Canonical marker, emitted only for a Goal-owned questionnaire. */
  recommended?: true;
}

/**
 * Image attached to a question step.
 *
 * `src` must be either an `https://` URL or an app-served attachment URL
 * (paths starting with `/mavis/api/`). Raw `file://` paths are rejected by
 * the daemon normalizer to avoid local-fs exposure through the UI.
 */
export interface AskQuestionImage {
  src: string;
  alt?: string;
  caption?: string;
  width?: number;
  height?: number;
}

/**
 * One step in the multi-step questionnaire. Each step holds exactly one
 * question with its own selection mode and options.
 *
 * Runtime invariants (enforced by the daemon normalizer):
 *   - `allowOther` is always `true`
 *   - `otherPlaceholder` is always the literal string `'Others...'`
 *   - `required` defaults to `true`
 *   - `selectionMode` defaults to `'single'`
 */
export interface AskQuestionStep {
  id: string;
  header?: string;
  question: string;
  description?: string;
  image?: AskQuestionImage;
  selectionMode: 'single' | 'multiple';
  options: AskQuestionOption[];
  allowOther: true;
  otherPlaceholder: 'Others...';
  required: true;
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * Lifecycle status of a questionnaire request. Lives on the request payload
 * so UI consumers can render expired / superseded panels without an extra
 * round-trip.
 */
export type AskQuestionnaireStatus =
  | 'pending'
  | 'answered'
  | 'expired'
  | 'superseded'
  | 'dismissed';

/**
 * Tool-call metadata linking the questionnaire back to the LLM message and
 * tool call that produced it. Optional because some entrypoints (manual
 * injection, channel-bridge) may not have a tool call.
 */
export interface AskQuestionnaireToolCall {
  message_id: string;
  call_id: string;
}

/**
 * Requester metadata used by the UI to scope the composer to the active
 * session and by the daemon to authorize reply submissions.
 */
export interface AskQuestionnaireRequester {
  sessionId: string;
  runId?: string;
  toolCallId?: string;
  agentName?: string;
}

/**
 * Presentation hints — locked at V2. Kept on the request payload so future
 * versions can opt-out per-flow without breaking older renderers.
 */
export interface AskQuestionnairePresentation {
  replaceComposer: boolean;
  showProgress: boolean;
  allowBackNavigation: boolean;
}

/** Shared expiry window for pending Questionnaire requests and Plan lifecycle fences. */
export const QUESTIONNAIRE_TTL_MS = 24 * 60 * 60 * 1000;

/** Machine-owned context identifying a questionnaire created while a Goal is active. */
export type AskQuestionnairePurpose = 'goal';

export interface QuestionnairePlanReview {
  markdown: string;
  path: string;
}

export type AskQuestionnairePlanReview = QuestionnairePlanReview;

export type AskQuestionnaireMode =
  | 'questionnaire'
  | 'feature-enable'
  | 'plan'
  | 'plugin-preparation';

export interface PluginPreparationRequest {
  pluginName: string;
  reason: string;
  requiredApps?: string[];
  outcome?: 'ready' | 'declined';
}

export const PLUGIN_PREPARATION_STEP_ID = 'plugin-preparation';
export const PLUGIN_PREPARATION_READY_OPTION_ID = 'ready';

export type PluginPreparationReadiness =
  | 'needs-install'
  | 'needs-enable'
  | 'needs-app-connection'
  | 'ready';

export function getPluginPreparationReadiness(
  detail: {
    summary: { installExists: boolean; enabled: boolean; capabilities: { appCount: number } };
    apps: readonly { provider: string; status?: string }[];
  },
  requiredApps?: readonly string[],
): PluginPreparationReadiness {
  if (!detail.summary.installExists) return 'needs-install';
  if (!detail.summary.enabled) return 'needs-enable';
  if (!requiredApps && detail.apps.length < detail.summary.capabilities.appCount) {
    return 'needs-app-connection';
  }
  const apps = requiredApps
    ? requiredApps.map((provider) => detail.apps.find((app) => app.provider === provider))
    : detail.apps;
  return apps.some((app) => app?.status !== 'connected') ? 'needs-app-connection' : 'ready';
}

export interface AskQuestionnaireModePayload {
  featureKey?: string;
  planReview?: QuestionnairePlanReview;
  pluginPreparation?: PluginPreparationRequest;
}

export interface OrdinaryQuestionnaireResponseOrigin {
  readonly kind: 'questionnaire-response';
  readonly requestId: string;
  readonly mode: 'questionnaire';
  readonly purpose: 'ordinary';
}

export function isOrdinaryQuestionnaireResponseOrigin(
  value: unknown,
): value is OrdinaryQuestionnaireResponseOrigin {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const origin = value as Readonly<Record<string, unknown>>;
  return (
    origin.kind === 'questionnaire-response' &&
    typeof origin.requestId === 'string' &&
    origin.requestId.length > 0 &&
    origin.mode === 'questionnaire' &&
    origin.purpose === 'ordinary' &&
    Object.keys(origin).length === 4
  );
}

/**
 * Full questionnaire request emitted by the daemon and consumed by the UI.
 * `schemaVersion` MUST be `2` for this shape; it is reserved so future V3
 * payloads can be distinguished at parse time.
 */
export interface AskQuestionnaireRequest {
  schemaVersion: 2;
  id: string;
  /** Machine-owned flow classification; tool input cannot set this field. */
  purpose?: AskQuestionnairePurpose;
  /** Runtime-owned identity used to prevent an old questionnaire from driving a replacement Goal. */
  goalId?: string;
  title?: string;
  tool?: AskQuestionnaireToolCall;
  requester?: AskQuestionnaireRequester;
  presentation: AskQuestionnairePresentation;
  steps: AskQuestionStep[];
  /** Unix ms; consumer renders local-tz string. */
  expiresAt?: number;
  status?: AskQuestionnaireStatus;
  /** Unix ms; set by the daemon when the request is created. */
  createdAt?: number;
  /** Missing on historical rows and therefore interpreted as `questionnaire`. */
  mode?: AskQuestionnaireMode;
  /** Mode-specific data. Plan review Markdown lives only under this payload. */
  modePayload?: AskQuestionnaireModePayload;
}

// ---------------------------------------------------------------------------
// Draft answer + reply
// ---------------------------------------------------------------------------

/**
 * Per-step draft answer held in the composer's local state.
 *
 * `selectedOptionIds` contains the IDs of all selected normal options (at
 * most one when the step is single-choice). `selectedOther` indicates the
 * `Others...` chip is active; `otherText` carries the free-form entry.
 * `skipped` is set when the user clicked the Skip button — it overrides
 * `step.required` at validation time and renders as `No answer` in the
 * chat summary.
 *
 * Single-choice + Others: the UI clears `selectedOptionIds` when Others is
 * picked, and clears `selectedOther` when a normal option is picked.
 * Multi-choice: Others can be combined with normal options freely.
 * Selecting any option or typing Others auto-clears `skipped`.
 */
export interface AskQuestionnaireDraftAnswer {
  stepId: string;
  selectedOptionIds: string[];
  selectedOther: boolean;
  otherText?: string;
  skipped?: boolean;
}

/**
 * Final per-step answer in the reply payload. Same shape as the draft so
 * the UI can serialize directly without translation; the daemon enforces
 * the validation invariants on receipt.
 */
export interface AskQuestionnaireReplyAnswer {
  stepId: string;
  selectedOptionIds: string[];
  selectedOther: boolean;
  otherText?: string;
  skipped?: boolean;
}

/**
 * Structured reply payload posted by the UI to
 * `POST /mavis/api/agent/:agentId/questionnaire/:requestId/reply`.
 *
 * `submittedAt` is a Unix ms timestamp captured at the moment the user
 * clicked Submit. Storage is ms throughout; consumers format locally per
 * AGENTS.md §1.
 */
export interface AskQuestionnaireReplyPayload {
  schemaVersion: 2;
  requestId: string;
  answers: AskQuestionnaireReplyAnswer[];
  submittedAt: number;
  /**
   * Machine-owned settlement provenance. Runtime ignores any caller value and
   * writes the canonical source before persisting the reply.
   */
  source?: 'user' | 'automatic_timeout';
}

// ---------------------------------------------------------------------------
// Tool input — what the LLM passes to ask_user
// ---------------------------------------------------------------------------

/**
 * Option as authored by the LLM (id optional — the runtime fills it in).
 * `image` is optional preview art rendered above the label inside the
 * option card; same scheme rules as the step-level image (HTTPS or
 * `/mavis/api/...` paths).
 */
export interface AskUserToolOptionInput {
  id?: string;
  label: string;
  description?: string;
  image?: AskUserToolImageInput;
  /** Optional machine-readable recommendation marker authored by the model. */
  recommended?: boolean;
}

/**
 * Image attachment as authored by the LLM. The runtime validates the src
 * scheme; raw `file://` and other unsafe schemes are rejected.
 */
export interface AskUserToolImageInput {
  src: string;
  alt?: string;
  caption?: string;
}

/**
 * Per-step input as authored by the LLM. `selectionMode` defaults to
 * `'single'` when omitted; `options` defaults to `[]` so a step with only an
 * `Others...` answer path is still valid.
 */
export interface AskUserToolStepInput {
  id?: string;
  header?: string;
  question: string;
  description?: string;
  image?: AskUserToolImageInput;
  options?: AskUserToolOptionInput[];
  selectionMode?: 'single' | 'multiple';
}

/** Model-authored renderer modes carried by the generic ask_user wire contract. */
export type AskUserToolMode = Exclude<AskQuestionnaireMode, "plan" | "plugin-preparation">;

export interface AskUserToolModePayload {
  featureKey?: string;
}

/**
 * Full `ask_user` tool input authored by the LLM. The runtime normalizer
 * produces an {@link AskQuestionnaireRequest} from this shape.
 */
export interface AskUserToolInput {
  /** `feature-enable` reuses the existing pause/reply lifecycle. */
  mode?: AskUserToolMode;
  modePayload?: AskUserToolModePayload;
  /**
   * Set true for a confirmation that an active Goal must never infer from its
   * timeout. Ordinary AskUser requests ignore this field because they never
   * auto-reply.
   */
  requiresExplicitResponse?: boolean;
  title?: string;
  steps?: AskUserToolStepInput[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The literal placeholder enforced for every step's Others input. */
export const ASK_OTHER_PLACEHOLDER = 'Others...' as const;

/**
 * Tool name registered for the Mavis-owned `ask_user` flow. The daemon
 * marks this name as an interactive tool so the permission engine returns
 * `behavior: 'ask'`, which the legacy local-runtime plugin translates into a
 * `<questionnaire-ask>` XML instruction for the LLM to emit.
 */
export const ASK_USER_TOOL_NAME = 'ask_user' as const;

export interface AskQuestionnaireState {
  status: "pending" | "answered" | "expired" | "superseded" | "dismissed";
  answeredAt?: number;
  injectedAt?: number;
  dismissedAt?: number;
}
