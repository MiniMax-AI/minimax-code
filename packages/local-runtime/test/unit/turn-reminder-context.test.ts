import { describe, expect, it } from 'vitest';
import {
  agentContextProvider,
  buildAgentContextBlock,
  buildSlimAgentContextBlock,
  type AgentEnv,
} from '@mavis/system-reminder';

import { formatReminderDate } from '../../src/api/host-memory.js';

const env: AgentEnv = {
  environmentInSystemPrompt: true,
  workspaceDir: '/w',
  agentConfigDir: '/d/agents/mavis',
  agentName: 'mavis',
  agentRole: 'orchestrator',
  sessionId: 'sess-123',
  platform: 'linux',
  scene: 'local',
  date: 'Fri Oct 09 2026 13:20 GMT+0800 (China Standard Time)',
};

describe('per-turn agent-context trimming', () => {
  it('formats the reminder clock to minute precision', () => {
    const ms = Date.UTC(2026, 9, 9, 5, 20, 45, 123);
    const formatted = formatReminderDate(ms);
    expect(formatted).toBe(new Date(ms).toString().replace(':20:45', ':20'));
    expect(formatted).not.toMatch(/\d{2}:\d{2}:\d{2}/u);
    expect(formatted).toMatch(/2026 \d{2}:\d{2} GMT[+-]\d{4}/u);
  });

  it('keeps the session id in the slim block unless the host says it is in context', () => {
    expect(buildSlimAgentContextBlock(env)).toContain('YOUR SESSION ID: sess-123');
    expect(buildSlimAgentContextBlock({ ...env, sessionIdInContext: false })).toContain(
      'YOUR SESSION ID: sess-123',
    );
    const trimmed = buildSlimAgentContextBlock({ ...env, sessionIdInContext: true });
    expect(trimmed).not.toContain('sess-123');
    expect(trimmed).toContain('SESSION ROLE: root');
    expect(trimmed).toContain(`date: ${env.date}`);
  });

  it('always keeps the session id in the first-turn full block', () => {
    expect(buildAgentContextBlock({ ...env, sessionIdInContext: true })).toContain(
      'YOUR SESSION ID: sess-123',
    );
    expect(
      agentContextProvider({ env: { ...env, sessionIdInContext: true }, turnCount: 1 } as never),
    ).toContain('YOUR SESSION ID: sess-123');
    expect(
      agentContextProvider({ env: { ...env, sessionIdInContext: true }, turnCount: 2 } as never),
    ).not.toContain('sess-123');
  });

  it('leaves cloud scene blocks unchanged when the flag is absent', () => {
    const cloud = { ...env, scene: 'cloud' as const };
    expect(buildSlimAgentContextBlock(cloud)).toContain('YOUR SESSION ID: sess-123');
  });
});
