/**
 * Ingress metadata a conversation request carries into the Application layer.
 * Public has no generated IDL, so the PTC admission only depends on the two
 * fields it actually reads.
 */
export interface ConversationRequestContext {
  /** Trusted ingress metadata minted by the HTTP front door or owned process-local delivery. */
  readonly ptcEligible?: true;
}

/** The request fields PTC admission reads; satisfied by send and enqueue alike. */
interface PtcAdmissionRequest {
  readonly id?: string;
  readonly reviewRequest?: unknown;
  readonly clientIntent?: string | null;
}

interface PtcAdmissionSessionReader {
  find(sessionId: string): Promise<
    | {
        readonly sessionType?: "root" | "branch";
        readonly sessionKind?: string;
        readonly parentSessionId?: string | null;
      }
    | undefined
  >;
}

/**
 * A fresh user message to a top-level conversation session is PTC eligible
 * only when its ingress was trusted; the session is read only in that case.
 */
export async function resolvePtcEligibility(
  ctx: ConversationRequestContext,
  req: PtcAdmissionRequest,
  sessionReader: PtcAdmissionSessionReader,
): Promise<boolean> {
  if (ctx.ptcEligible !== true || !isPtcEligibleUserMessage(req)) return false;
  const sessionId = req.id;
  if (!sessionId) return false;
  const session = await sessionReader.find(sessionId);
  return (
    (session?.sessionType === "root" || session?.sessionType === "branch") &&
    session.sessionKind === "conversation" &&
    (session.parentSessionId ?? null) === null
  );
}

function isPtcEligibleUserMessage(req: PtcAdmissionRequest): boolean {
  if (req.reviewRequest) return false;
  return ![
    "cloud-handoff",
    "retry-continuation",
    "turn-continuation",
    "paused-queue-keep",
    "paused-queue-clear",
    "composer-steer",
  ].includes(req.clientIntent ?? "");
}
