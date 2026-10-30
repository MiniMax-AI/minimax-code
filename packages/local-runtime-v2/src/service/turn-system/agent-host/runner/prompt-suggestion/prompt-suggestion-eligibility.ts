/**
 * Runtime gate for the composer's next-message suggestion.
 *
 * The extra generation is billed to the signed-in account, so it only runs for
 * a confirmed subscription. Every uncertain path — no session, transport
 * failure, a `base_resp` rejection, a plan we cannot name, or a login change
 * during the read — resolves to "not eligible" and no model request is issued.
 * The UI hint is advisory; this gate is the only enforcement point.
 */
/** A slow membership read must not hold the suggestion back for long. */
const MEMBERSHIP_CHECK_TIMEOUT_MS = 1_500;

export type PromptSuggestionIneligibility = 'not_signed_in' | 'no_plan' | 'unknown';

/** Plan fields only. Remaining credit, gifts or trial counters never qualify. */
const ELIGIBLE_SUBSCRIPTION_TYPES: ReadonlySet<string> = new Set(['mplan', 'token_plan', 'agent_plan']);

/** Structural view of the membership facts, so no compat layer is imported here. */
export interface MembershipFacts {
  readonly hasTokenPlan: boolean;
  /** Raw `subscription_type`; `'unknown'` / `'none'` never grants eligibility. */
  readonly subscriptionType: string;
}

/** Internal auth snapshot used only for equality checks; never log or publish it. */
interface AuthSnapshot {
  readonly accessToken?: string;
  readonly loginEpoch?: string;
}

export interface MembershipReader {
  readMembershipFacts(signal?: AbortSignal): Promise<MembershipFacts>;
  readAuthSnapshot(): AuthSnapshot;
}

export interface PromptSuggestionEligibilityPort {
  /** Resolves `undefined` when the account may run the extra generation. */
  check(signal: AbortSignal): Promise<PromptSuggestionIneligibility | undefined>;
}

export function createPromptSuggestionEligibility(
  commerce: MembershipReader,
): PromptSuggestionEligibilityPort {
  return {
    async check(signal) {
      const before = commerce.readAuthSnapshot();
      if (!before.accessToken?.trim()) return 'not_signed_in';
      const timeout = AbortSignal.timeout(MEMBERSHIP_CHECK_TIMEOUT_MS);
      let facts: MembershipFacts;
      try {
        facts = await commerce.readMembershipFacts(AbortSignal.any([signal, timeout]));
      } catch {
        // Fail closed: an unreachable, slow or rejected membership API must not
        // turn into a model request the account did not ask to pay for.
        return 'unknown';
      }
      if (signal.aborted || timeout.aborted) return 'unknown';
      // A logout, account switch or token refresh between the two reads means
      // the facts describe an identity this Turn no longer belongs to.
      const after = commerce.readAuthSnapshot();
      if (after.accessToken !== before.accessToken || after.loginEpoch !== before.loginEpoch)
        return 'unknown';
      if (isEligibleMembership(facts)) return undefined;
      // A plan we cannot name is not a confirmed refusal, and must not be
      // reported as one; either way no model request follows.
      return facts.subscriptionType === 'unknown' ? 'unknown' : 'no_plan';
    },
  };
}

export function isEligibleMembership(facts: MembershipFacts): boolean {
  if (facts.hasTokenPlan) return true;
  return ELIGIBLE_SUBSCRIPTION_TYPES.has(facts.subscriptionType);
}
