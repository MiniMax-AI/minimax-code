import type { McpToolEntry } from '@mavis/agent-tools';
import type { LocalMavisMcpAdapter } from '@mavis/agent-tools/desktop';
import type { LocalRuntimeAuthContext } from '../model-system/index.js';
import type { LocalRuntimeRoutingContext } from '../../infra/config/routing-headers.js';

/** @deprecated Read-only wiring for old turn/Skill consumers; remove after their v2 cutover. */
export interface LocalMcpRuntimeCapability {
  isBuiltinMatrixAvailable(): boolean;
  readConfiguredServerNames(): Promise<Set<string>>;
  createMavisAdapter(
    emit: (type: string, payload: Record<string, unknown>) => void,
  ): LocalMavisMcpAdapter;
  listToolEntriesForTurn(input: {
    sessionId: string;
    workspaceRoot: string;
    turnId?: string;
    authContext?: LocalRuntimeAuthContext;
    routingContextGetter?: () => LocalRuntimeRoutingContext | undefined;
    emitBusEvent(type: string, payload: Record<string, unknown>): void;
  }): Promise<McpToolEntry[]>;
}
