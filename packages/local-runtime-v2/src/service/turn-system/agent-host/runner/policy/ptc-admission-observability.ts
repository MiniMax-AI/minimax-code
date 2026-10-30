import { isPtcTurnEnabled } from '@mavis/config';

import { readTrustedBuiltinAgentProfileIdentity } from '../../assembly/local-turn-tool-catalog-source.js';
import type { LocalTurnExecutionInput } from '../contracts.js';
import {
  report,
  writeLog,
  type PtcLogger,
  type PtcMetrics,
  type PtcSurface,
} from '../ptc/ptc-observability.js';

/**
 * The `ptc admission` line and `ptc_turn_total` count. They read the profile
 * and gates the tool catalog decided from, which runner/ptc may not import;
 * the log and metrics wrappers are the ones in runner/ptc/ptc-observability.ts.
 */

/**
 * Why a PTC-mode Session's Turn has PTC on or off, named after the gate that decided it,
 * in the order the gates run (entry, then `isPtcTurnEnabled`).
 */
type PtcAdmissionReason =
  /** run_code is in the catalog. */
  | 'enabled'
  /** The Session has a parent (Task child, branch child); the entry never marks it. */
  | 'child_session'
  /** Slash cloud handoff wins the turn intent before PTC is considered. */
  | 'cloud_handoff'
  /** Not a user message (cron, task, background task, code review, ...). */
  | 'non_api_source'
  /**
   * A user message without the trusted PTC mark: not the Desktop renderer port
   * or a trusted TUI entry, a review request, a continuation or steer intent,
   * or a non-conversation Session.
   */
  | 'untrusted_entrypoint'
  /** Requested, but the profile renders for a task child. */
  | 'task_child_surface'
  /** Requested, but a trusted built-in role that keeps native tools (Explore, Peek). */
  | 'native_only_role'
  /** Requested and every known gate passed, yet the catalog has no run_code. */
  | 'other';

type PtcAdmissionInput = Pick<
  LocalTurnExecutionInput,
  'lease' | 'request' | 'session' | 'assemblyContext'
>;

/**
 * One `ptc admission` line and one `ptc_turn_total` count per Turn of a Session in PTC mode
 * (`toolCallMode: 'ptc'`, carried as agentConfig.ptc_enabled).
 * Without them, "PTC did not kick in" cannot be told apart from an untrusted
 * entry, a subagent Turn or an Explore profile, and the share of beta Turns
 * that really run PTC is unknown. Turns of native-mode Sessions report nothing.
 */
export function observePtcAdmission(
  input: PtcAdmissionInput,
  admitted: boolean,
  options: {
    readonly logger?: PtcLogger;
    readonly metricsClient?: PtcMetrics;
    readonly ptcSurface?: PtcSurface;
  },
): void {
  try {
    if (input.assemblyContext.agentConfig.ptc_enabled !== true) return;
    const reason = ptcAdmissionReason(input, admitted);
    const surface = options.ptcSurface ?? 'other';
    writeLog(options.logger, 'ptc admission', {
      session_id: input.lease.sessionId,
      turn_id: input.lease.turnId,
      admitted,
      reason,
      surface,
      // Internal source enum only (local log), so a non_api_source line says which one.
      ...(reason === 'non_api_source' ? { source: input.request.provenance?.source } : {}),
    });
    report(() =>
      options.metricsClient?.counter('ptc_turn_total', 1, {
        admitted: String(admitted),
        reason,
        surface,
      }),
    );
  } catch {
    // Diagnostics must not affect the Turn.
  }
}

/** Reads the same frozen facts the tool catalog decided from (assemblyContext). */
function ptcAdmissionReason(input: PtcAdmissionInput, admitted: boolean): PtcAdmissionReason {
  if (admitted) return 'enabled';
  if (input.assemblyContext.turnIntent?.kind !== 'desktop-ptc') return ptcEntryReason(input);
  const profile = readRecord(input.assemblyContext.agentConfig.agent_profile);
  // isPtcTurnEnabled admits only the interactive and cli surfaces.
  if (profile.surface === 'task-child') return 'task_child_surface';
  const identity = readTrustedBuiltinAgentProfileIdentity(profile);
  const canonicalRole = identity.trustedBuiltin ? identity.canonicalViewName : undefined;
  if (canonicalRole && !isPtcTurnEnabled({ requested: true, canonicalRole }))
    return 'native_only_role';
  return 'other';
}

function ptcEntryReason(input: PtcAdmissionInput): PtcAdmissionReason {
  if (input.session.parentSessionId) return 'child_session';
  // Direct test seams may omit provenance; PTC needs trusted provenance.
  const provenance = input.request.provenance as
    | PtcAdmissionInput['request']['provenance']
    | undefined;
  if (!provenance) return 'untrusted_entrypoint';
  const cloudHandoff = readRecord(provenance.sourceContext?.cloudHandoff);
  if (cloudHandoff.trigger === 'slash') return 'cloud_handoff';
  if (provenance.source !== 'api') return 'non_api_source';
  return 'untrusted_entrypoint';
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}
