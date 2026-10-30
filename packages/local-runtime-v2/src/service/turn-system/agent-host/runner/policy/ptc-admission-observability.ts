import type { PiTurnRunnerLogger } from '@mavis/agent-core/pi-turn-runner';

import type { LocalTurnExecutionInput } from '../contracts.js';
import { report, writeLog, type PtcMetrics, type PtcSurface } from '../ptc/ptc-observability.js';
import {
  comparePtcPrefix,
  fingerprintPtcPrefix,
  type PtcPrefixFingerprint,
  type PtcPrefixInput,
} from './ptc-prefix-fingerprint.js';

/**
 * The `ptc admission` line and `ptc_turn_total` count. They read the frozen
 * facts the tool catalog decided from, which runner/ptc may not import; the
 * log and metrics wrappers are the ones in runner/ptc/ptc-observability.ts.
 */

/**
 * Why a PTC-mode Session's Turn has PTC on or off. The Session mode is the
 * only gate (isPtcTurnEnabled), so a PTC-mode Turn without run_code means the
 * catalog chain broke somewhere.
 */
type PtcAdmissionReason =
  /** run_code is in the catalog. */
  | 'enabled'
  /** The Session runs in PTC mode, yet the catalog has no run_code. */
  | 'other';

/**
 * Turn sources reported as is (`provenance.source`, an internal enum). Anything
 * else reports `other`, so a label never carries an unexpected value.
 */
const REPORTED_SOURCES: ReadonlySet<string> = new Set([
  'api',
  'cron',
  'task',
  'background-task',
  'team',
  'thread-goal',
  'questionnaire',
  'communication',
  'code_review',
  'greeting',
  'channel:wechat',
  'channel:feishu',
  'channel:telegram',
  'miniapp',
  /** Explicit Continue of an interrupted Turn. */
  'turn-continuation',
  /** Edit-and-resend of an earlier message. */
  'conversation-mutation',
]);

const REPORTED_SESSION_KINDS: ReadonlySet<string> = new Set([
  'conversation',
  'task',
  'peek',
  'channel',
  'cron',
  'unknown',
]);

type PtcAdmissionInput = Pick<
  LocalTurnExecutionInput,
  'lease' | 'request' | 'session' | 'assemblyContext'
>;

/**
 * One `ptc admission` line and one `ptc_turn_total` count per Turn of a Session in PTC mode
 * (`toolCallMode: 'ptc'`, carried as agentConfig.ptc_enabled), with the source and Session kind
 * of the Turn and the fingerprint of the prefix it sends. Without them, "PTC did not kick in"
 * and "the prefix changed" cannot be told apart from an ordinary Turn, and the share of beta
 * Turns that really run PTC is unknown. Turns of native-mode Sessions report nothing.
 */
export function observePtcAdmission(
  input: PtcAdmissionInput,
  admitted: boolean,
  options: {
    readonly logger?: Pick<PiTurnRunnerLogger, 'info' | 'warn'>;
    readonly metricsClient?: PtcMetrics;
    readonly ptcSurface?: PtcSurface;
  },
  prefix: PtcPrefixInput,
): void {
  let facts: {
    reason: PtcAdmissionReason;
    surface: PtcSurface;
    source: string;
    sessionKind: string;
  };
  try {
    if (input.assemblyContext.agentConfig.ptc_enabled !== true) return;
    facts = {
      reason: admitted ? 'enabled' : 'other',
      surface: options.ptcSurface ?? 'other',
      source: reportedSource(input),
      sessionKind: reportedSessionKind(input),
    };
  } catch {
    // Diagnostics must not affect the Turn.
    return;
  }
  const { reason, surface, source, sessionKind } = facts;
  // The fingerprint only adds hashes: when it fails, the line and the count
  // still go out, without the hashes and without a prefix comparison.
  const fingerprint = tryFingerprint(prefix);
  writeLog(options.logger, 'ptc admission', {
    session_id: input.lease.sessionId,
    turn_id: input.lease.turnId,
    admitted,
    reason,
    surface,
    source,
    session_kind: sessionKind,
    ...fingerprint,
  });
  report(() =>
    options.metricsClient?.counter('ptc_turn_total', 1, {
      admitted: String(admitted),
      reason,
      surface,
      source,
      session_kind: sessionKind,
    }),
  );
  if (!fingerprint) return;
  try {
    comparePtcPrefix(
      { sessionId: input.lease.sessionId, turnId: input.lease.turnId, source, fingerprint },
      options.logger,
    );
  } catch {
    // Diagnostics must not affect the Turn.
  }
}

function tryFingerprint(prefix: PtcPrefixInput): PtcPrefixFingerprint | undefined {
  try {
    return fingerprintPtcPrefix(prefix);
  } catch {
    return undefined;
  }
}

function reportedSource(input: PtcAdmissionInput): string {
  // Direct test seams may omit provenance.
  const provenance = input.request.provenance as
    | PtcAdmissionInput['request']['provenance']
    | undefined;
  const source = provenance?.source;
  return typeof source === 'string' && REPORTED_SOURCES.has(source) ? source : 'other';
}

function reportedSessionKind(input: PtcAdmissionInput): string {
  const kind = input.session.sessionKind;
  return typeof kind === 'string' && REPORTED_SESSION_KINDS.has(kind) ? kind : 'unknown';
}
