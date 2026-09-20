import {
  classifySafetyTransportError,
  isSafetyCheckV2Record,
} from "@mavis/shared/safety-check-v2";
import { createSafetyFailureReporter } from "./diagnostics.js";
import {
  getRuntimeBuildEnv,
  getRuntimeRegion,
  type MavisBuildEnv,
  type MavisRegion,
} from "@mavis/config";

import { callTurnSafetyApi } from "./turn-api.js";
import { resolveSafetyApiBase } from "./api-base.js";

import type { LocalRuntimeAuthContext } from "../runtime/model-resolver.js";
import {
  managedBackendRoutingHeaders,
  type LocalRuntimeRoutingContext,
} from "../runtime/routing-headers.js";

export { resolveSafetyApiBase } from "./api-base.js";

export type SafetyCheckResult = {
  pass: boolean;
  reason?: string;
  suggestion?: string;
  /** Model-only guidance; never serialize it to a user-facing response. */
  guide_prompt?: string;
  action?: "allow" | "reject" | "replace" | "guide";
  /** Retry the same failed V2 output review without returning to a V1 window check. */
  retryWithV2?: boolean;
  /**
   * Why a `pass:false` result is not always a policy verdict:
   *   - `rejected`    — the gateway DID review and rejected the content.
   *   - `api_error`   — the gateway responded but with a genuine service-side
   *     degradation: a 5xx, or an explicit `errorCode:50200` service-unavailable
   *     body. We reached the gateway; it just could not review right now.
   *   - `local_error` — we never got a usable verdict because transport failed,
   *     the response was unusable, or a non-auth 4xx rejected the request.
   *   - `auth_error` — the gateway returned 401/403 for missing or expired auth.
   *
   * ONE fail policy everywhere (see `reviewBlocks`): `rejected`, `local_error`, and `auth_error`
   * BLOCK (fail closed — if we have no verdict, or an auth failure, we cannot
   * confirm the content is safe, so we never let it through), while `api_error`
   * DEGRADE-PASSES for legacy V1 checks. V2 errors are mapped to local_error or
   * auth_error and always fail closed. Consumers that
   * need something other than a block decision (e.g. the desktop route mapping to
   * an error code) read `errorKind` directly.
   */
  errorKind?: "rejected" | "api_error" | "local_error" | "auth_error";
};

/**
 * THE single fail-policy predicate for content-safety verdicts — "local blocks,
 * remote degrades" — shared by the turn INPUT review, the streaming OUTPUT
 * review, and every persisted config write (agent fields / user skill / session
 * title).
 *
 * Returns `true` when a verdict must BLOCK:
 *   - `rejected`    (gateway reviewed and rejected)                 → block
 *   - `local_error` (no valid verdict: offline / timeout / invalid response) → block
 *   - `auth_error`  (missing / expired managed login)              → block
 *   - `api_error`   (gateway reachable but 5xx-degraded)            → degrade-pass
 *
 * `local_error` ALWAYS fails closed — there is no path where a missing verdict is
 * allowed through. Callers MUST route every block/allow decision through this one
 * predicate instead of re-deriving from `errorKind`. Consumers that need
 * something other than a block decision (e.g. mapping to an HTTP error code) read
 * `errorKind` directly.
 */
export function reviewBlocks(result: SafetyCheckResult): boolean {
  return !result.pass && result.errorKind !== "api_error";
}

export const SAFETY_SCENE = {
  MessageOutput: 1,
  StreamChunk: 2,
  ThinkingContent: 3,
  // One content-safety scene for all user-controllable persisted config writes:
  // agent display name / description / persona / system prompt / avatar, user
  // skill name / description / content, and the session title. These values
  // flow into the `<agent-context>` block / skill roster / session list that
  // peer-agent LLMs read, so they are a cross-agent prompt-injection vector and
  // are gated at the owning Agent runtime service boundary and skill surfaces.
  // Reuses IDL `MavisSafetyScene` 205
  // rather than fanning out a per-field scene.
  ConfigField: 205,
  UserInput: 300,
} as const;

export type SafetyScene = (typeof SAFETY_SCENE)[keyof typeof SAFETY_SCENE];

export type SafetyAttachment =
  | { objectKey: string; fileUrl?: never; fileName?: string }
  | { fileUrl: string; objectKey?: never; fileName?: string };

const CONTENT_REVIEW_TIMEOUT_MS = 10_000;

const UPSTREAM_CODE = {
  SERVICE_UNAVAILABLE: 50200,
} as const;

export async function callSafetyApi(input: {
  content: string;
  scene: SafetyScene;
  attachments?: SafetyAttachment[];
  authContext?: LocalRuntimeAuthContext;
  routingContext?: LocalRuntimeRoutingContext;
  fetchImpl: typeof fetch;
  region?: () => MavisRegion;
  buildEnv?: () => MavisBuildEnv;
  /** Loopback-only endpoint used by deterministic external tests in test builds. */
  testBaseURL?: string;
}): Promise<SafetyCheckResult> {
  const region = input.region ?? getRuntimeRegion;
  const buildEnv = input.buildEnv ?? getRuntimeBuildEnv;
  const resolvedBuildEnv = buildEnv();
  // Keep legacy URL/text requests on the existing auth policy. Private keys
  // opt into authenticated ownership checks using the gateway's existing flag.
  const authQuery = input.attachments?.some(
    (attachment) => attachment.objectKey,
  )
    ? "?require_auth=true"
    : "";
  const url = `${resolveSafetyApiBase(region(), resolvedBuildEnv, input.testBaseURL)}/mavis/api/v1/content${authQuery}`;
  // Shared OAuth resource requests authenticate with the standard Bearer
  // scheme, matching the managed model and File API paths. Omit the header
  // entirely when there is no token so an anonymous request stays explicit.
  const accessToken =
    input.authContext?.accessToken?.trim() ||
    process.env.MAVIS_ACCESS_TOKEN?.trim();
  const reportFailure = createSafetyFailureReporter(url, "v1", input.scene);
  let response: Response;
  try {
    response = await input.fetchImpl(url, {
      method: "POST",
      headers: {
        "User-Agent": "MiniMaxAgent",
        "Content-Type": "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...managedBackendRoutingHeaders(
          input.routingContext,
          input.buildEnv ? resolvedBuildEnv : undefined,
        ),
      },
      body: JSON.stringify({
        content_text: input.content,
        scene: input.scene,
        ...(input.attachments?.length
          ? {
              files: input.attachments.map((attachment) => ({
                ...(attachment.objectKey
                  ? { object_key: attachment.objectKey }
                  : { file_url: attachment.fileUrl }),
                file_name: attachment.fileName,
              })),
            }
          : {}),
      }),
      signal: AbortSignal.timeout(CONTENT_REVIEW_TIMEOUT_MS),
    });
  } catch (error) {
    reportFailure({
      failureKind: "transport",
      transportKind: classifySafetyTransportError(error),
    });
    // fetch threw (offline / DNS / connection refused / TLS) or the 10s timeout
    // fired: we never reached a verdict. No gateway confirmation → fail closed.
    return {
      pass: false,
      reason: "Service unavailable",
      errorKind: "local_error",
    };
  }

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    reportFailure({
      failureKind: "transport",
      transportKind: classifySafetyTransportError(error),
      statusCode: response.status,
    });
    return {
      pass: false,
      reason: "Service response could not be read",
      errorKind: "local_error",
    };
  }
  if (!response.ok) {
    // Non-2xx from the gateway, split by class so an auth failure can never be a
    // bypass:
    //   5xx  → gateway reachable but genuinely degraded → `api_error` (fail open:
    //          a transient server hiccup must not block a legitimate turn / write).
    //   4xx  → client-side problem: missing / expired auth token (401/403), bad
    //          request, etc. We are not authenticated / the request is not
    //          acceptable, so there is NO valid verdict on our side → `local_error`
    //          (fail closed). Treating 401/403 as `api_error` would let an
    //          unauthenticated user bypass every content gate.
    reportFailure({
      failureKind: response.status === 401 || response.status === 403 ? "auth" : "http",
      statusCode: response.status,
    });
    const error = readErrorText(text);
    return {
      pass: false,
      reason: error ?? `Service returned ${response.status}`,
      errorKind:
        response.status === 401 || response.status === 403
          ? "auth_error"
          : response.status >= 500
            ? "api_error"
            : "local_error",
    };
  }

  let data: {
    pass?: unknown;
    safe?: unknown;
    reason?: unknown;
    error?: unknown;
    errorCode?: unknown;
    suggestion?: unknown;
    fix_response?: unknown;
  };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    reportFailure({ failureKind: "response", statusCode: response.status });
    // 2xx but the body is not JSON — we cannot read a verdict. Treat as no
    // gateway confirmation → fail closed on the input path.
    return {
      pass: false,
      reason: "Service returned non-JSON response",
      errorKind: "local_error",
    };
  }

  const pass = isSafetyCheckV2Record(data) ? data.pass ?? data.safe : undefined;
  if (typeof pass !== "boolean") {
    reportFailure({ failureKind: "response", statusCode: response.status });
    // 2xx JSON but no boolean pass/safe field — again no usable verdict → fail
    // closed on the input path.
    return {
      pass: false,
      reason: "Service returned unexpected response format",
      errorKind: "local_error",
    };
  }
  const activeRegion = region();
  const upstreamCode =
    typeof data.errorCode === "number" ? data.errorCode : undefined;
  if (!pass && upstreamCode === UPSTREAM_CODE.SERVICE_UNAVAILABLE) {
    reportFailure({ failureKind: "upstream", statusCode: upstreamCode });
  }
  return {
    pass,
    reason:
      typeof data.reason === "string"
        ? data.reason
        : typeof data.error === "string"
          ? data.error
          : undefined,
    suggestion:
      activeRegion === "cn"
        ? typeof data.suggestion === "string"
          ? data.suggestion
          : typeof data.fix_response === "string"
            ? data.fix_response
            : undefined
        : undefined,
    ...(!pass
      ? {
          errorKind:
            upstreamCode === UPSTREAM_CODE.SERVICE_UNAVAILABLE
              ? ("api_error" as const)
              : ("rejected" as const),
        }
      : {}),
  };
}

/**
 * A content-safety checker bound to one auth source at construction. Callers
 * (the runtime host's output review) create it once and then invoke it with only
 * the business payload — `content` + `scene` — never threading the access token
 * per call. Auth is resolved lazily inside the returned function so a refreshed
 * login (the daemon swaps its `authContext`) is always picked up, and `fetch` is
 * read at call time so a test `vi.spyOn(globalThis, 'fetch')` still intercepts.
 */
export type ContentSafetyChecker = (
  content: string,
  scene: SafetyScene,
) => Promise<SafetyCheckResult>;

export function createContentSafetyChecker(deps: {
  /** Explicit V2 routing opt-in; callers that omit it retain V1. */
  apiVersion?: "v1" | "v2";
  authContextGetter?: () => LocalRuntimeAuthContext | undefined;
  authContextInvalidator?: (
    rejectedAccessToken: string,
  ) => void | Promise<void>;
  routingContextGetter?: () => LocalRuntimeRoutingContext | undefined;
  fetchImpl?: typeof fetch;
  region?: () => MavisRegion;
  buildEnv?: () => MavisBuildEnv;
  testBaseURLGetter?: () => string | undefined;
}): ContentSafetyChecker {
  const callApi = deps.apiVersion === "v2" ? callTurnSafetyApi : callSafetyApi;
  return async (content, scene) => {
    try {
      const authContext = deps.authContextGetter?.();
      const rejectedToken =
        authContext?.accessToken?.trim() ||
        process.env.MAVIS_ACCESS_TOKEN?.trim();
      const request = {
        content,
        scene,
        authContext,
        routingContext: deps.routingContextGetter?.(),
        fetchImpl: deps.fetchImpl ?? fetch,
        ...(deps.region ? { region: deps.region } : {}),
        ...(deps.buildEnv ? { buildEnv: deps.buildEnv } : {}),
        ...(deps.testBaseURLGetter
          ? { testBaseURL: deps.testBaseURLGetter() }
          : {}),
      };
      const result = await callApi(request);
      if (
        result.errorKind !== "auth_error" ||
        !rejectedToken ||
        !deps.authContextInvalidator
      ) {
        return result;
      }
      try {
        await deps.authContextInvalidator(rejectedToken);
        const freshAuth = deps.authContextGetter?.();
        const freshToken =
          freshAuth?.accessToken?.trim() ||
          process.env.MAVIS_ACCESS_TOKEN?.trim();
        if (!freshToken || freshToken === rejectedToken) return result;
        // A failed V2 output stream retries as its V2 full-reply scene after auth refresh.
        const retryScene =
          result.retryWithV2 && request.scene === SAFETY_SCENE.StreamChunk
            ? SAFETY_SCENE.MessageOutput
            : request.scene;
        return await callApi({
          ...request,
          scene: retryScene,
          authContext: freshAuth,
        });
      } catch {
        return result;
      }
    } catch {
      // callSafetyApi is designed never to throw (it maps transport / parse
      // failures to a `local_error` result). This is a defensive backstop — e.g.
      // the auth getter throwing — so the checker's contract is airtight: it
      // ALWAYS resolves to a SafetyCheckResult and never rejects. That lets every
      // caller trust `errorKind` + `reviewBlocks` and drop its own try/catch.
      return { pass: false, errorKind: "local_error" };
    }
  };
}

function readErrorText(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}
