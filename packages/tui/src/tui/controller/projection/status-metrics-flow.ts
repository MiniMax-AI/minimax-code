import type {
  TuiAccountStatus,
  TuiConfigurationPort,
  TuiInspectionPort,
  TuiSessionUsageSummary,
  TuiContextSnapshotResponse,
} from '../../../runtime/port.js';

type StatusMetricsRuntime = Partial<Pick<TuiConfigurationPort, 'getAccountStatus'>> &
  Partial<Pick<TuiInspectionPort, 'getSessionUsageSummary' | 'getContextSnapshot'>>;

export interface TuiStatusMetricsFlowOptions {
  readonly runtime: StatusMetricsRuntime;
  readonly currentSessionId: () => string | undefined;
  readonly currentAccount: () => TuiAccountStatus | undefined;
  readonly apply: (patch: {
    account?: TuiAccountStatus;
    sessionUsage?: TuiSessionUsageSummary;
    contextSnapshot?: TuiContextSnapshotResponse;
  }) => void;
}

/**
 * Account reads without membership (login gates, the fast status pass) carry no
 * quota; normalization then reports a Token Plan account as `unavailable`. Keep
 * the Token Plan fields the status line already shows for the same signed-in
 * account until the membership refresh replaces them. Pass only reads without
 * membership; membership answers replace the account directly.
 */
export function withKnownTokenPlan(
  previous: TuiAccountStatus | undefined,
  next: TuiAccountStatus,
): TuiAccountStatus {
  const signedInTokenPlan = (account: TuiAccountStatus | undefined) =>
    account?.modelSource === 'token-plan' && account.managedTokenPresent === true;
  if (!previous || !signedInTokenPlan(previous) || !signedInTokenPlan(next)) return next;
  // Another signed-in account never inherits the previous account's quota.
  if (previous.identity?.email !== next.identity?.email) return next;
  // A read that carries quota is a membership answer and is authoritative.
  if (next.tokenPlanQuota || !previous.tokenPlanQuotaState) return next;
  const { tokenPlanQuotaState, tokenPlanQuota, tokenPlanSummary } = previous;
  return {
    ...next,
    tokenPlanQuotaState,
    ...(tokenPlanQuota ? { tokenPlanQuota } : {}),
    ...(tokenPlanSummary ? { tokenPlanSummary } : {}),
  };
}

export class TuiStatusMetricsFlow {
  private accountRefreshSequence = 0;
  private usageRefreshSequence = 0;
  private contextRefreshSequence = 0;

  constructor(private readonly options: TuiStatusMetricsFlowOptions) {}

  async refresh(sessionId: string): Promise<void> {
    await Promise.all([
      this.refreshAccount(sessionId),
      this.refreshSessionUsage(sessionId),
      this.refreshContext(sessionId),
    ]);
  }

  async refreshSessionUsage(sessionId: string): Promise<void> {
    const getSessionUsageSummary = this.options.runtime.getSessionUsageSummary;
    if (!getSessionUsageSummary) return;
    const refreshSequence = ++this.usageRefreshSequence;
    const summary = await getSessionUsageSummary
      .call(this.options.runtime, sessionId)
      .catch(() => undefined);
    if (refreshSequence !== this.usageRefreshSequence) return;
    if (this.options.currentSessionId() !== sessionId) return;
    this.options.apply({ sessionUsage: summary });
  }

  async refreshContext(sessionId: string): Promise<void> {
    const getContextSnapshot = this.options.runtime.getContextSnapshot;
    if (!getContextSnapshot) return;
    const sequence = ++this.contextRefreshSequence;
    const contextSnapshot = await Promise.resolve()
      .then(() => getContextSnapshot.call(this.options.runtime, sessionId))
      .catch(() => undefined);
    if (sequence !== this.contextRefreshSequence || this.options.currentSessionId() !== sessionId)
      return;
    this.options.apply({ contextSnapshot });
  }

  async refreshAccount(sessionId?: string): Promise<void> {
    const getAccountStatus = this.options.runtime.getAccountStatus;
    if (!getAccountStatus) return;
    const refreshSequence = ++this.accountRefreshSequence;
    await Promise.resolve()
      .then(() =>
        getAccountStatus.call(this.options.runtime, sessionId, { includeMembership: false }),
      )
      .then(
        (account) => {
          if (!account || refreshSequence !== this.accountRefreshSequence) return;
          if (sessionId && this.options.currentSessionId() !== sessionId) return;
          this.options.apply({
            account: withKnownTokenPlan(this.options.currentAccount(), account),
          });

          if (account.modelSource === 'token-plan' && account.managedTokenPresent === true) {
            void this.refreshMembership(sessionId, refreshSequence);
          }
        },
        () => {
          if (refreshSequence !== this.accountRefreshSequence || this.options.currentAccount())
            return;
          if (sessionId && this.options.currentSessionId() !== sessionId) return;
          this.options.apply({ account: { status: 'unknown', warnings: [] } });
        },
      );
  }

  private async refreshMembership(sessionId: string | undefined, refreshSequence: number) {
    const getAccountStatus = this.options.runtime.getAccountStatus;
    if (!getAccountStatus) return;
    const account = await getAccountStatus
      .call(this.options.runtime, sessionId, { includeMembership: true })
      .catch(() => undefined);
    if (!account || refreshSequence !== this.accountRefreshSequence) return;
    if (sessionId && this.options.currentSessionId() !== sessionId) return;
    this.options.apply({ account });
  }

  refreshCurrent(): void {
    const sessionId = this.options.currentSessionId();
    if (!sessionId) {
      void this.refreshAccount();
      return;
    }
    void this.refresh(sessionId);
  }
}
