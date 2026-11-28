import { describe, expect, it, vi } from 'vitest';

import {
  clearManagedSkillReceiptsOutsideHistory,
  logManagedSkillReceiptsCleared,
  ManagedSkillReceipts,
  restoreManagedSkillReceiptsFromHistory,
  skillsHeldInHistory,
} from '../../src/local-runtime-managed-skills.js';

describe('ManagedSkillReceipts', () => {
  it('lists what a conversation loaded, in read order', () => {
    const receipts = new ManagedSkillReceipts();
    receipts.markLoaded('session-1', 'sidebar-project');
    receipts.markLoaded('session-1', 'session-manage');
    receipts.markLoaded('session-1', 'sidebar-project');
    receipts.markLoaded('session-2', 'agent-manage');

    expect(receipts.loadedSkills('session-1')).toEqual(['sidebar-project', 'session-manage']);
    expect(receipts.loadedSkills('session-2')).toEqual(['agent-manage']);
    expect(receipts.loadedSkills('session-3')).toEqual([]);
  });

  it('drops one Skill without touching the rest', () => {
    const receipts = new ManagedSkillReceipts();
    receipts.markLoaded('session-1', 'sidebar-project');
    receipts.markLoaded('session-1', 'session-manage');

    expect(receipts.clearSkill('session-1', 'agent-manage')).toBe(false);
    expect(receipts.clearSkill('session-1', 'sidebar-project')).toBe(true);
    expect(receipts.hasLoaded('session-1', 'sidebar-project')).toBe(false);
    expect(receipts.hasLoaded('session-1', 'session-manage')).toBe(true);
    // The last receipt takes the conversation's entry with it.
    expect(receipts.clearSkill('session-1', 'session-manage')).toBe(true);
    expect(receipts.loadedSkills('session-1')).toEqual([]);
  });

  it('reports how many receipts a conversation clear dropped', () => {
    const receipts = new ManagedSkillReceipts();
    receipts.markLoaded('session-1', 'sidebar-project');
    receipts.markLoaded('session-1', 'session-manage');

    expect(receipts.clearSession('session-1')).toBe(2);
    expect(receipts.clearSession('session-1')).toBe(0);
    expect(receipts.clearSession('session-2')).toBe(0);
  });

  it('remembers a failed preload per conversation until that conversation is cleared', () => {
    const receipts = new ManagedSkillReceipts();

    expect(receipts.hasPreloadFailed('session-1', 'session-manage')).toBe(false);
    receipts.markPreloadFailed('session-1', 'session-manage');

    // The failure is the conversation's, not the process's: another Session
    // still gets to try the same Skill.
    expect(receipts.hasPreloadFailed('session-1', 'session-manage')).toBe(true);
    expect(receipts.hasPreloadFailed('session-1', 'sidebar-project')).toBe(false);
    expect(receipts.hasPreloadFailed('session-2', 'session-manage')).toBe(false);

    receipts.clearSession('session-1');
    expect(receipts.hasPreloadFailed('session-1', 'session-manage')).toBe(false);

    receipts.markPreloadFailed('session-2', 'session-manage');
    receipts.clear();
    expect(receipts.hasPreloadFailed('session-2', 'session-manage')).toBe(false);
  });
});

/** The `skill` tool's own result, the one shape that carries a loaded body. */
const skillToolResult = (name: string, toolName = 'skill') => ({
  role: 'toolResult',
  toolName,
  content: [{ type: 'text', text: `# Skill: ${name}\n\n${name} body` }],
});
/** The first user message of a Session that preloaded the Skill. */
const preloadedUserMessage = (name: string) => ({
  role: 'user',
  content: `<preloaded-skill name="${name}">\n# Skill: ${name}\n\n${name} body\n</preloaded-skill>`,
});

describe('skillsHeldInHistory', () => {
  it('counts a skill tool result and a preloaded block, and nothing else', () => {
    const held = skillsHeldInHistory([
      skillToolResult('session-manage'),
      preloadedUserMessage('sidebar-project'),
      // Another tool's result that happens to open with the same header.
      skillToolResult('agent-manage', 'read'),
      // A summary that merely quotes the header is not the body.
      { role: 'compactionSummary', summary: '# Skill: cron-manage\nthe model read it earlier.' },
      { role: 'user', content: 'Checkpoint summary:\n# Skill: panel-manage\nread earlier.' },
      { role: 'assistant', content: [{ type: 'text', text: '# Skill: app-manage' }] },
    ]);

    expect([...held].sort()).toEqual(['session-manage', 'sidebar-project']);
  });
});

describe('clearManagedSkillReceiptsOutsideHistory', () => {
  const loaded = () => {
    const receipts = new ManagedSkillReceipts();
    receipts.markLoaded('session-1', 'sidebar-project');
    receipts.markLoaded('session-1', 'session-manage');
    return receipts;
  };

  it('drops only the receipts whose Skill body the history no longer holds', () => {
    const receipts = loaded();
    const info = vi.fn();

    const cleared = clearManagedSkillReceiptsOutsideHistory(receipts, {
      sessionId: 'session-1',
      messages: [skillToolResult('session-manage')],
      reason: 'compaction',
      logger: { info },
    });

    expect(cleared).toBe(1);
    expect(receipts.hasLoaded('session-1', 'session-manage')).toBe(true);
    expect(receipts.hasLoaded('session-1', 'sidebar-project')).toBe(false);
    expect(info).toHaveBeenCalledWith(
      {
        event: 'managed_skill_receipts_cleared',
        session_id: 'session-1',
        reason: 'compaction',
        cleared: 1,
      },
      '[local-runtime-v2] managed skill receipts cleared',
    );
  });

  it('keeps a receipt whose Skill was preloaded into the first user message', () => {
    const receipts = loaded();

    const cleared = clearManagedSkillReceiptsOutsideHistory(receipts, {
      sessionId: 'session-1',
      messages: [preloadedUserMessage('sidebar-project')],
      reason: 'context_reset',
    });

    expect(cleared).toBe(1);
    expect(receipts.hasLoaded('session-1', 'sidebar-project')).toBe(true);
    expect(receipts.hasLoaded('session-1', 'session-manage')).toBe(false);
  });

  it('drops every receipt when the history keeps no Skill body', () => {
    const receipts = loaded();

    expect(
      clearManagedSkillReceiptsOutsideHistory(receipts, {
        sessionId: 'session-1',
        messages: [{ role: 'user', content: 'hello' }],
        reason: 'compaction',
      }),
    ).toBe(2);
    expect(receipts.loadedSkills('session-1')).toEqual([]);
  });

  it('logs nothing and touches nothing when the conversation never loaded a Skill', () => {
    const receipts = new ManagedSkillReceipts();
    const info = vi.fn();

    expect(
      clearManagedSkillReceiptsOutsideHistory(receipts, {
        sessionId: 'session-1',
        messages: [],
        reason: 'compaction',
        logger: { info },
      }),
    ).toBe(0);
    expect(info).not.toHaveBeenCalled();
  });

  it('never lets a broken store reach the caller', () => {
    const broken = {
      ...new ManagedSkillReceipts(),
      loadedSkills: () => {
        throw new Error('store down');
      },
    };

    expect(
      clearManagedSkillReceiptsOutsideHistory(broken, {
        sessionId: 'session-1',
        messages: [],
        reason: 'compaction',
      }),
    ).toBe(0);
  });
});

describe('logManagedSkillReceiptsCleared', () => {
  it('writes one line carrying the session, the reason and the count', () => {
    const info = vi.fn();

    logManagedSkillReceiptsCleared(
      { info },
      { sessionId: 'session-1', reason: 'compaction', cleared: 2 },
    );

    expect(info).toHaveBeenCalledWith(
      {
        event: 'managed_skill_receipts_cleared',
        session_id: 'session-1',
        reason: 'compaction',
        cleared: 2,
      },
      '[local-runtime-v2] managed skill receipts cleared',
    );
  });

  it('never lets a broken or missing sink reach the caller', () => {
    expect(() =>
      logManagedSkillReceiptsCleared(
        {
          info: () => {
            throw new Error('sink down');
          },
        },
        { sessionId: 'session-1', reason: 'session_deleted', cleared: 0 },
      ),
    ).not.toThrow();
    expect(() =>
      logManagedSkillReceiptsCleared(undefined, {
        sessionId: 'session-1',
        reason: 'context_reset',
        cleared: 1,
      }),
    ).not.toThrow();
  });
});

describe('restoreManagedSkillReceiptsFromHistory', () => {
  it('marks every Skill whose body the history still holds', () => {
    const receipts = new ManagedSkillReceipts();
    const info = vi.fn();

    const restored = restoreManagedSkillReceiptsFromHistory(receipts, {
      sessionId: 'session-1',
      messages: [
        preloadedUserMessage('sidebar-project'),
        skillToolResult('session-manage'),
        // A summary that merely quotes the header is not the body.
        { role: 'compactionSummary', summary: '# Skill: cron-manage\nread earlier.' },
      ],
      logger: { info },
    });

    expect(restored).toBe(2);
    expect(receipts.loadedSkills('session-1')).toEqual(['sidebar-project', 'session-manage']);
    expect(info).toHaveBeenCalledWith(
      {
        event: 'managed_skill_receipts_restored',
        session_id: 'session-1',
        restored: 2,
        skills: ['sidebar-project', 'session-manage'],
      },
      '[local-runtime-v2] managed skill receipts restored',
    );
  });

  it('runs once per process per conversation', () => {
    const receipts = new ManagedSkillReceipts();
    const first = [skillToolResult('session-manage')];

    expect(
      restoreManagedSkillReceiptsFromHistory(receipts, {
        sessionId: 'session-1',
        messages: first,
      }),
    ).toBe(1);
    // The same conversation's next Turn does not re-derive, and a Skill read
    // after the restore is dropped again by a clear without coming back.
    receipts.clearSession('session-1');
    expect(
      restoreManagedSkillReceiptsFromHistory(receipts, {
        sessionId: 'session-1',
        messages: first,
      }),
    ).toBe(1);
    receipts.clearSkill('session-1', 'session-manage');
    expect(
      restoreManagedSkillReceiptsFromHistory(receipts, {
        sessionId: 'session-1',
        messages: first,
      }),
    ).toBe(0);
    expect(receipts.loadedSkills('session-1')).toEqual([]);
  });

  it('keeps the claim unspent while the history holds no Skill body', () => {
    const receipts = new ManagedSkillReceipts();

    // The first Turn of a brand-new conversation: nothing to restore yet.
    expect(
      restoreManagedSkillReceiptsFromHistory(receipts, { sessionId: 'session-1', messages: [] }),
    ).toBe(0);
    expect(
      restoreManagedSkillReceiptsFromHistory(receipts, {
        sessionId: 'session-1',
        messages: [skillToolResult('session-manage')],
      }),
    ).toBe(1);
  });

  it('scopes the claim to one conversation', () => {
    const receipts = new ManagedSkillReceipts();
    const messages = [skillToolResult('session-manage')];

    for (const sessionId of ['session-1', 'session-2']) {
      expect(
        restoreManagedSkillReceiptsFromHistory(receipts, { sessionId, messages }),
      ).toBe(1);
    }
    expect(receipts.hasLoaded('session-1', 'session-manage')).toBe(true);
    expect(receipts.hasLoaded('session-2', 'session-manage')).toBe(true);
  });

  it('never lets a broken store or sink reach the caller', () => {
    const broken = {
      ...new ManagedSkillReceipts(),
      claimHistoryRestore: () => {
        throw new Error('store down');
      },
    };

    expect(
      restoreManagedSkillReceiptsFromHistory(broken, {
        sessionId: 'session-1',
        messages: [skillToolResult('session-manage')],
      }),
    ).toBe(0);
    expect(() =>
      restoreManagedSkillReceiptsFromHistory(new ManagedSkillReceipts(), {
        sessionId: 'session-1',
        messages: [skillToolResult('session-manage')],
        logger: {
          info: () => {
            throw new Error('sink down');
          },
        },
      }),
    ).not.toThrow();
  });
});

