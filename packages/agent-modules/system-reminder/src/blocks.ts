/**
 * System-reminder block builders — pure functions that produce XML/markdown
 * blocks for injection into <system-reminder>.
 *
 * Migrated from legacy prompt transform to enable
 * framework-agnostic system-reminder injection.
 */

// Memory threshold constants no longer needed here — cleanup is triggered
// silently by daemon (MemoryCleanupSpawner) without agent-facing warnings.
import type {
  AgentEnv,
  AgentIdentity,
  ActivePlanSummary,
  CliSunsetMemoryNotice,
  MemorySkillReminderStatus,
  MemoryTopicSummary,
  PeerInfo,
  SkillEntry,
} from './types.js';

// ─── Peer Formatting ─────────────────────────────────────────────────────────

/** Format peer sessions grouped by agent — used in agent-context and peers_update. */
export function formatPeersAggregated(peers: PeerInfo[]): string {
  if (peers.length === 0) return '    (none)';

  // Filter out worktree agents (long names, rarely useful in context) and
  // terminal sessions (finished/error) that the agent won't interact with.
  const activePeers = peers.filter((p) => {
    if (p.agentName.includes('worktrees')) return false;
    if (p.status === 'finished' || p.status === 'error') return false;
    return true;
  });

  if (activePeers.length === 0) {
    const hidden = peers.length;
    return `    (${hidden} peer sessions, all finished/worktree — use \`mavis session ls\` to browse)`;
  }

  const groups = new Map<
    string,
    { displayName?: string; agentRole: string; sessions: PeerInfo[] }
  >();
  for (const p of activePeers) {
    const group = groups.get(p.agentName);
    if (group) {
      group.sessions.push(p);
    } else {
      groups.set(p.agentName, {
        displayName: p.displayName,
        agentRole: p.agentRole,
        sessions: [p],
      });
    }
  }

  const MAX_SESSIONS_PER_AGENT = 5;
  const lines: string[] = [];
  for (const [agentName, group] of groups) {
    const displayStr = group.displayName ? `${group.displayName}, ` : '';
    lines.push(`    ${agentName} (${displayStr}${group.agentRole}):`);

    const sorted = [...group.sessions].sort((a, b) => {
      if (a.title && !b.title) return -1;
      if (!a.title && b.title) return 1;
      return 0;
    });

    const shown = sorted.slice(0, MAX_SESSIONS_PER_AGENT);
    const remaining = sorted.length - shown.length;

    for (const s of shown) {
      const titleStr = s.title ? ` "${s.title}"` : ' (untitled)';
      const statusStr = s.status ? ` [${s.status}]` : '';
      lines.push(`      - ${s.sessionId}${titleStr}${statusStr}`);
    }

    if (remaining > 0) {
      lines.push(`      ... and ${remaining} more`);
    }
  }

  return lines.join('\n');
}

// ─── Block Builders ──────────────────────────────────────────────────────────

export function buildAgentContextBlock(env: AgentEnv, opts?: { teamModeOff?: boolean }): string {
  // SESSION ROLE is derived from parentSessionId: a session is `branch` iff it
  // was spawned by another session (it has a parent). Otherwise it is `root`.
  // This is the agent's role in the *session tree*, not the same as `agentRole`
  // (orchestrator/worker, the agent type) or `session.sessionType` (Root/Branch
  // — daemon-internal classification used for routing/storage).
  const sessionRole = env.parentSessionId ? 'branch' : 'root';
  const displayName = env.displayName ?? env.agentName;
  // Cloud scene trims duplicates / fields that have no analogue in the cloud
  // runtime: the internal `agentName:` ID line (cloud has no CLI/routing/
  // storage layer that needs the ID separately from the user-facing display
  // name), `agentRole:` (AgentConfig.agent_role was removed from the protocol on 2026-05-24;
  // the cloud no longer routes Worker/Orchestrator separately), `IS_DEFAULT_WORKSPACE` (cloud always
  // uses the managed workspace), and `YOUR AGENT CONFIG DIRECTORY` (no
  // on-disk config).
  const isCloud = env.scene === 'cloud';
  const lines = ['<agent-context>'];
  lines.push(`  agent: ${displayName}  # display name`);
  const userConfiguredName = formatUserConfiguredName(env.userConfiguredName);
  if (userConfiguredName) {
    lines.push(`  user: ${userConfiguredName}  # user name`);
  }
  if (!isCloud) {
    lines.push(`  agentName: ${env.agentName}  # routing ID`);
    lines.push(`  agentRole: ${env.agentRole}  # agent type`);
  }
  lines.push(`  SESSION ROLE: ${sessionRole}`, `  YOUR SESSION ID: ${env.sessionId}`);
  if (env.parentSessionId) {
    lines.push(`  PARENT SESSION: ${env.parentSessionId}`);
    lines.push(buildParentResultDeliveryLine(env, isCloud));
  }
  if (env.sessionType !== 1 && env.rootSessionId) {
    lines.push(`  YOUR AGENT ROOT SESSION: ${env.rootSessionId}`);
  }
  if (!env.environmentInSystemPrompt) {
    lines.push(`  YOUR WORKSPACE DIRECTORY: ${env.workspaceDir}`);
    if (!isCloud) {
      lines.push(
        `  IS_DEFAULT_WORKSPACE: ${env.isDefaultWorkspace ?? true}`,
        `  YOUR AGENT CONFIG DIRECTORY: ${env.agentConfigDir}`,
      );
    }
  }
  if (env.scratchpadPath) {
    lines.push(
      `  YOUR SCRATCHPAD: available via the MAVIS_SCRATCHPAD env var`,
      `    (shared free-form whiteboard rooted at this session tree's root session;`,
      `     read/write with normal Read/Write tools; child sessions inherit the same path`,
      `     via the same env var. Use it for cross-session notes that don't`,
      `     fit the structured team board. Do not print the scratchpad path in`,
      `     user-facing replies.)`,
    );
  }
  if (!env.environmentInSystemPrompt) {
    lines.push(`  platform: ${env.platform}`);
  }
  lines.push(`  date: ${env.date}`);
  if (!env.environmentInSystemPrompt) {
    lines.push(`  systemLocale: ${env.systemLocale ?? 'en'}`);
    if (env.region) {
      lines.push(`  region: ${env.region}`);
    }
  }
  if (env.runtimePort) {
    lines.push(`  runtimePort: ${String(env.runtimePort)}`);
  }
  if (env.profile) {
    lines.push(`  profile: ${env.profile}`);
  }
  if (!env.environmentInSystemPrompt && env.dataDir) {
    lines.push(`  dataDir: ${env.dataDir}`);
  }
  addBrowserBridgeContextLines(lines, env.browserBridge);
  if (env.isMonorepoDev) {
    lines.push(
      `  runtimeMode: monorepo-dev`,
      `  cliUsage: Use \`${env.dataDir}/bin/mavis <command>\` to invoke CLI commands.`,
    );
  }
  if (env.importedFrom) {
    lines.push(`  YOU ARE ACTUALLY IMPORTED FROM: ${env.importedFrom}`);
  }
  if (env.projectInstructions) {
    lines.push(`  projectInstructions: ${env.projectInstructions}`);
  }

  const teamOff = opts?.teamModeOff === true;

  // Peer sessions and agent rosters are no longer inlined here — both grew unbounded
  // (every finished session, every imported agent) and wasted tokens on every
  // first-message injection. Surface a one-line pointer so agents know to query
  // on demand. The `peers` field stays on AgentEnv so other consumers (e.g.
  // peers_update event block) can still receive it via formatPeersAggregated.
  //
  // Cloud diverges from daemon: the `mavis-session` / `mavis-agent` skill
  // names referenced by the daemon string don't exist in the cloud skill
  // registry — observed in OSS session `401960923238467` where the model
  // called `skill(name='mavis-agent')` and got "Cloud Host skill not found".
  // Cloud has the `mavis` LLM tool instead, so point at it directly.
  if (!teamOff) {
    if (isCloud) {
      lines.push(
        '  peers (for `communicate`):  `mavis({ command: "session list", args: { mode: "peers", session_id: "me" } })`',
        '  agents (your roster):       `mavis({ command: "agent list" })`',
      );
    } else {
      lines.push(
        '  teamDiscovery: peers and agents are NOT inlined. Load skill `mavis-session` to list peer sessions; load skill `mavis-agent` to list available agents.',
      );
    }
  }

  lines.push('</agent-context>');
  return lines.join('\n');
}

/** Slim agent-context for subsequent messages — only dynamic/critical fields. */
export function buildSlimAgentContextBlock(env: AgentEnv): string {
  const sessionRole = env.parentSessionId ? 'branch' : 'root';
  const displayName = env.displayName ?? env.agentName;
  const isCloud = env.scene === 'cloud';
  const lines = ['<agent-context>'];
  lines.push(`  agent: ${displayName}`);
  const userConfiguredName = formatUserConfiguredName(env.userConfiguredName);
  if (userConfiguredName) {
    lines.push(`  user: ${userConfiguredName}`);
  }
  if (!isCloud) {
    lines.push(`  agentName: ${env.agentName}`);
  }
  lines.push(`  SESSION ROLE: ${sessionRole}`);
  if (!env.sessionIdInContext) {
    lines.push(`  YOUR SESSION ID: ${env.sessionId}`);
  }
  if (env.parentSessionId) {
    lines.push(`  PARENT SESSION: ${env.parentSessionId}`);
    lines.push(buildParentResultDeliveryLine(env, isCloud));
  }
  if (env.sessionType !== 1 && env.rootSessionId) {
    lines.push(`  YOUR AGENT ROOT SESSION: ${env.rootSessionId}`);
  }
  lines.push(`  date: ${env.date}`);
  if (!env.environmentInSystemPrompt) {
    lines.push(`  systemLocale: ${env.systemLocale ?? 'en'}`);
    if (env.region) {
      lines.push(`  region: ${env.region}`);
    }
  }
  addBrowserBridgeContextLines(lines, env.browserBridge);
  lines.push('</agent-context>');
  return lines.join('\n');
}

function buildParentResultDeliveryLine(env: AgentEnv, isCloud: boolean): string {
  if (!isCloud && env.taskResultDelivery === 'runtime-managed') {
    return '  TASK RESULT DELIVERY: Return your result normally; the runtime delivers it through whichever path opened this Turn — the task result, the session send completion, or a task_append result the owner reads with task_output. Do not send a separate message to the parent session.';
  }
  if (!isCloud) {
    return '  RESULT DELIVERY: Return your result normally in this session. The parent can retrieve the completed branch result through native session tools; do not shell out to message another session.';
  }
  return `  REPORT-BACK REQUIRED: When your task is complete or blocked, you MUST report results back to your parent session via the \`communicate\` tool with to_session="${env.parentSessionId}" and content="<your report>".`;
}

function escapeAgentContextValue(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatUserConfiguredName(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 100) return undefined;
  return escapeAgentContextValue(normalized);
}

function addBrowserBridgeContextLines(lines: string[], snapshot: AgentEnv['browserBridge']): void {
  if (!snapshot) return;
  const claimedTabs = snapshot.claimedTabs > 0 ? String(snapshot.claimedTabs) : 'none';
  lines.push(
    '  browserBridge: connected',
    `    profile: ${snapshot.profile}`,
    `    claimedTabs: ${claimedTabs}`,
  );
}

export function buildPeersUpdateBlock(peers: PeerInfo[]): string {
  return [
    '<peers_update>',
    'Your reachable peer sessions have changed:',
    formatPeersAggregated(peers),
    '</peers_update>',
  ].join('\n');
}

/**
 * Build a <memory-skill-reminder> block with file path, size, and line count.
 * Returns empty string if the memory file does not exist yet.
 *
 * The block has two independently-gated sections:
 *
 *   1. Skill issue/proposal trigger checklist (only when at least one of
 *      `skillEvolveEnabled` or `skillProposalEnabled` is true). Within this
 *      section, the signal trigger line and the proposal trigger line gate
 *      independently — when only one is enabled, only that line appears.
 *
 *   2. Three-question memory-layer attribution test (always included). Even
 *      when the skill section is fully suppressed (both gates off), agents
 *      still need the user/agent/project memory routing rubric.
 *
 * When the skill section is suppressed, the leading "Before writing, FIRST
 * ask" preamble and the "Yes/No fall-through" line are omitted as well; the
 * block jumps straight from the file metadata into the memory-layer test.
 */
export function buildMemorySkillReminder(
  status: MemorySkillReminderStatus | undefined,
  opts: {
    skillEvolveEnabled?: boolean;
    skillProposalEnabled?: boolean;
    scene?: 'cloud' | 'local' | undefined;
    dataDir?: string;
  } = {},
): string {
  if (!status) return '';

  const memoryPath = status.path;
  const lines = status.lines;
  const sizeKB = (status.sizeBytes / 1024).toFixed(1);
  const signalEnabled = opts.skillEvolveEnabled === true;
  const proposalEnabled = opts.skillProposalEnabled === true;
  const anySkillSection = signalEnabled || proposalEnabled;
  const isCloud = opts.scene === 'cloud';
  const dataDirDisplay = opts.dataDir || '~/.minimax';

  const statusLines = [
    '<memory-skill-reminder>',
    `  path: ${memoryPath}`,
    `  lines: ${lines}`,
    `  size: ${sizeKB}KB`,
  ];

  if (anySkillSection) {
    statusLines.push('  Before writing, FIRST ask: is this a skill issue/proposal?');
    if (signalEnabled) {
      statusLines.push(
        '    - existing skill is wrong / outdated / has bad triggers / missing a step → `mavis skill signal report`',
      );
    }
    if (proposalEnabled) {
      statusLines.push(
        '    - this session reveals a clearly reusable new pattern with no skill coverage → `mavis skill proposal report`',
      );
    }
    statusLines.push(
      '    Yes → use the skill channel (NOT memory). Load the `skill-evolution` skill for the full schema and decision rubric.',
      '    No → fall through to the three-question memory-layer test.',
    );
  }

  statusLines.push(
    '  Apply the three-question test. Write to the FIRST matching layer, not the default (agent memory).',
    `    1. 换用户结论会变？→ User Memory (${dataDirDisplay}/memory/user.md)`,
    '       Examples: "MR 不可自动 merge", "飞书通知群", "序号指代习惯", "沟通风格"',
    `    2. 换项目结论仍成立？→ Agent Memory (${dataDirDisplay}/agents/<name>/memory/MEMORY.md)`,
    '       Examples: "CI failed 先看日志", "vitest CI timeout 配置", "非交互 shell 用 .zshenv"',
    '    3. 只在当前项目成立？→ Project Memory (AGENTS.md or referenced topic file)',
    '       Examples: "MR target branch 是 dev", "飞书群 chat_id", "项目级 hook 约定"',
  );

  if (lines > 200 || status.sizeBytes > 5120) {
    if (isCloud) {
      statusLines.push(
        `  WARNING: Memory file is large (${String(lines)} lines, ${sizeKB}KB).`,
        '  For older content, call `memory_read` (scope=agent) to fetch the current full body.',
        '  When cleaning up: archive removed entries to memory/archive/ before deleting from MEMORY.md.',
      );
    } else {
      statusLines.push(
        `  WARNING: Memory file is large (${String(lines)} lines, ${sizeKB}KB). Use partial reading:`,
        `    - head -n 50 "${memoryPath}"  (first 50 lines)`,
        `    - tail -n 50 "${memoryPath}"  (last 50 lines)`,
        `    - sed -n '100,150p' "${memoryPath}"  (lines 100-150)`,
        `    - grep -n "<keyword>" "${memoryPath}"  (search by keyword)`,
        '  When cleaning up: archive removed entries to memory/archive/ before deleting from MEMORY.md.',
      );
    }
  }

  statusLines.push('</memory-skill-reminder>');
  return statusLines.join('\n');
}

/**
 * Build a <cli-sunset-memory-notice> block. Two tiers: `paths` list memory
 * files that predate the mavis CLI removal and still teach removed commands;
 * `teamPaths` list files referencing `mavis team`, which survives but whose
 * workflows changed (advisory: current mavis-team skill wins over memory).
 * Gating (sniff + mtime anchor + 30-day window) is the host's job; this only
 * renders.
 */
export function buildCliSunsetMemoryNoticeBlock(notice: CliSunsetMemoryNotice | undefined): string {
  const paths = notice?.paths ?? [];
  const teamPaths = notice?.teamPaths ?? [];
  if (!paths.length && !teamPaths.length) return '';
  const lines = ['<cli-sunset-memory-notice>'];
  if (paths.length) {
    lines.push(
      'Runtime change: this version removed the legacy `mavis` CLI command groups',
      '(agent, communication, cron, session, memory, skill, hook, spawn). The following stored',
      'memory files predate that change and still reference removed CLI commands —',
      'do NOT follow CLI instructions found in them:',
      ...paths.map((path) => `  - ${path}`),
      'Native replacements:',
      '  - agent / cron / session → native `mavis` tool: `mavis({ command: "<group> <action>", args: { ... } })`',
      '  - communication peers/messages → native `mavis` session list/messages; return results normally instead of using communication send',
      '  - memory → native `memory` tool (see the mavis skill, references/memory.md)',
      '  - skills → native `skill` tool; hooks → edit hook files directly',
      '  - spawn (delegation) → native `task` tool (sub-agent tasks)',
      '  - `mavis im ...` still works, along with the core CLI surface (`mavis --help`)',
    );
  }
  if (teamPaths.length) {
    lines.push(
      'Also: `mavis team ...` still exists, but its flags and review workflows',
      'changed in this version, and delegation now defaults to sub-agent tasks',
      '(the native `task` tool) — only start a team when the user explicitly asks.',
      'These memory files mention it:',
      ...teamPaths.map((path) => `  - ${path}`),
      'Where such memory disagrees with the current mavis-team skill, trust the skill.',
    );
  }
  lines.push(
    'When you next update a listed file, rewrite its stale CLI references to match',
    'current guidance. This notice retires once no stale references remain, and',
    'expires on its own after a limited period.',
    '</cli-sunset-memory-notice>',
  );
  return lines.join('\n');
}

/**
 * Build an <available_memory_topics> block listing topic files with frontmatter descriptions.
 * The host collector scans memory/*.md (excluding MEMORY.md and archive/) and
 * passes parsed summaries in, keeping agent-core free of filesystem reads.
 */
export function buildMemoryTopicsBlock(topics: readonly MemoryTopicSummary[] | undefined): string {
  if (!topics?.length) return '';

  const topicEntries = topics.map((t) =>
    [
      '  <topic>',
      `    <name>${t.name}</name>`,
      `    <description>${t.description}</description>`,
      `    <path>${t.path}</path>`,
      '  </topic>',
    ].join('\n'),
  );

  return `<available_memory_topics>\n${topicEntries.join('\n')}\n</available_memory_topics>`;
}

export function buildIdentityUpdateBlock(identity: AgentIdentity): string {
  const lines = ['<identity_update>', 'Your identity has been updated:'];
  if (identity.display_name) {
    lines.push(`- Name: ${identity.display_name}`);
  }
  lines.push('Please adjust your behavior to reflect these changes.');
  lines.push('</identity_update>');
  return lines.join('\n');
}

export function buildConfigUpdateBlock(): string {
  return [
    '<config_update>',
    'Your configuration has been updated. Key changes may include your persona or description.',
    'Re-read and internalize your updated role and identity.',
    '</config_update>',
  ].join('\n');
}

export function buildBootstrapBlock(
  workspaceDir?: string,
  opts?: { scene?: 'cloud' | 'local' | undefined },
): string {
  const dir = workspaceDir ?? '';
  // Scene no longer changes the instruction: bootstrap is a single-file
  // AGENTS.md generation handled by the `init` skill in the current session.
  void opts;
  return [
    '<bootstrap_check>',
    `Your workspace (${dir}) has no root AGENTS.md — this project has no agent-facing setup notes yet.`,
    '',
    'Before starting any work, ask yourself: would a root AGENTS.md help agents work on this repo?',
    'If yes (this is a git repository with meaningful code), load the `init` skill and follow it to',
    'generate `AGENTS.md` at the repo root, then let the user review and commit it.',
    '',
    'If the repo does not need it (scratch dir, no real code), say so and skip the bootstrap.',
    '</bootstrap_check>',
  ].join('\n');
}

export function buildTeamMemoryBlock(index: string): string {
  return [
    '<team_memory>',
    'Knowledge index from your project teammates. If any topic seems relevant to your current task,',
    'query the full entry: mavis memory show <project>--<agent-name>',
    '',
    index,
    '</team_memory>',
  ].join('\n');
}

export function buildEvolutionReminderBlock(reminder: string): string {
  return reminder;
}

export function buildRelevantMemoryBlock(memory: string): string {
  return [
    '<relevant-memory>',
    'The following agent memory sections are relevant to your current task:',
    '',
    memory,
    '</relevant-memory>',
  ].join('\n');
}

/** Build the opt-in hot-path rubric for deciding whether this turn created durable memory. */
export function buildProactiveMemoryBlock(): string {
  return [
    '<proactive-memory>',
    'Proactive Memory is enabled. While completing the current request, check whether this turn produced information worth retaining long-term without the user having to ask again: an explicit durable user preference or correction, a recurring collaboration constraint, or a reusable lesson that is likely to prevent a repeated mistake when Memory is unavailable.',
    '',
    'If qualifying information exists, use only the `memory` tool to access Memory; do not bypass it with a shell or general-purpose file tools. You MUST NOT use `bash`, `read`, `write`, or `grep` to access Memory paths. Read or search the correct scope first: put user-specific information in User Memory, where the first step MUST be memory(target=user, operation=read/search), even if the file does not exist yet, and only then append. Put lessons that remain valid across users and projects in Agent Memory. Append only genuinely new information, and revise an existing entry only when the tool supports it and the evidence is sufficient. Do not modify tracked project files solely for this check.',
    '',
    'Do not store secrets, credentials, tokens, private keys, irrelevant sensitive personal information, speculation, one-off parameters, temporary task state, routine events, facts that are easy to recover from the current repository or official documentation, or duplicate content. If there is no qualifying information, do not call the Memory tool and do not mention this check to the user.',
    '',
    'Memory is potentially stale supporting evidence and must not override the current user request, repository source, current configuration, or official documentation.',
    '</proactive-memory>',
  ].join('\n');
}

export function buildUserMemoryUpdateBlock(userMemory: string): string {
  return [
    '<user_memory_update>',
    'User memory has been updated since your session started. Here is the latest version:',
    '',
    userMemory,
    '</user_memory_update>',
  ].join('\n');
}

export function buildAgentMemoryUpdateBlock(memory: string): string {
  return [
    '<agent_memory_update>',
    'New entries have been appended to your agent memory (MEMORY.md) since this session started:',
    '',
    memory,
    '</agent_memory_update>',
  ].join('\n');
}

export function buildMemorySummaryUpdateBlock(summary: string): string {
  return [
    '<memory_summary_update>',
    'Your memory summary index (memory/.summary.md) has been regenerated. Here is the latest version:',
    '',
    summary,
    '</memory_summary_update>',
  ].join('\n');
}

export function buildDailyMemoryUpdateBlock(dailyMemory: string): string {
  return [
    '<daily_memory_update>',
    'Daily memory has been updated since your session started. Here is the latest digest:',
    '',
    dailyMemory,
    '</daily_memory_update>',
  ].join('\n');
}

/**
 * Build a `<persona_missing>` block — fired when the agent has no real persona yet
 * (no display_name, empty PERSONA.md, or body looks like a template default).
 *
 * Aligned with the greeting philosophy: task first, collect identity naturally,
 * one or two questions at a time — never a setup wizard.
 *
 * `scene: 'cloud'` activates the cloud-tailored variant — there is no on-disk
 * PERSONA.md to point at, and the agent talks to its own metadata through the
 * `mavis` LLM tool (no CLI), so the closing instructions reference the tool
 * call shape instead of a CLI command + filesystem path.
 */
export function buildPersonaMissingBlock(
  personaPath: string,
  agentName: string,
  opts?: { scene?: 'cloud' | 'local' | undefined },
): string {
  const isCloud = opts?.scene === 'cloud';
  const lines: string[] = [
    '<persona_missing>',
    isCloud
      ? "You don't have a persona of your own yet. Your persona is empty or still a default template."
      : "You don't have a persona of your own yet. Your PERSONA.md is missing, empty, or still a default template.",
  ];
  if (!isCloud) {
    lines.push(`Path: ${personaPath}`);
  }
  lines.push(
    '',
    '## Task first, then shape your identity',
    '',
    'If the user has given you a task, do it first. They learn about you by watching you work,',
    'not by hearing you describe yourself.',
    '',
    "After the task (or when there's a natural opening), pick up one or two of these:",
    '- **Display name** — What should they call you?',
    '- **Species / nature** — Optional. Human, cat, owl, robot — anything that fits.',
    '- **Voice (tone)** — Direct? Playful? Formal? Dry wit?',
    "- **Boundaries** — What you won't do, how blunt you can be.",
    '- **Brevity** — Default short / thorough / depends-on-context?',
    '',
    "Don't dump all five questions at once. Identity first, voice and boundaries can emerge",
    'over the next few conversations. Let it be organic.',
    '',
  );
  if (isCloud) {
    lines.push(
      'Save voice / boundaries / brevity with the `mavis` tool:',
      `  mavis({ command: "agent update", args: { agent_name: "me", persona: "<one or two paragraphs in your own voice>" } })`,
      '(use `new_name` in the same call to update your display name)',
    );
  } else {
    lines.push(
      'Save identity with:',
      `  mavis agent identity set ${agentName} --display-name "<name>"`,
      'Save voice / boundaries / brevity with:',
      `  mavis agent update ${agentName} --persona "<one or two paragraphs in your own voice>"`,
    );
  }
  lines.push('</persona_missing>');
  return lines.join('\n');
}

/**
 * Build an inbound metadata block for injection into <system-reminder>.
 * Surfaces trusted platform/sender/chat metadata from channel messages.
 */
export function buildInboundMetaBlock(meta: Record<string, unknown>): string {
  const lines: string[] = ['# Inbound Message Context'];
  for (const [key, value] of Object.entries(meta)) {
    if (value !== undefined && value !== null) {
      lines.push(
        `- **${key}**: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`,
      );
    }
  }
  return lines.join('\n');
}

/**
 * Build an <available_skills> block listing agent skills.
 * Migrated from legacy prompt transform.
 */
export function buildSkillsBlock(skills: SkillEntry[]): string {
  const entries = skills.map((s) => {
    return [
      '  <skill>',
      `    <name>${s.name}</name>`,
      `    <description>${s.description}</description>`,
      '  </skill>',
    ].join('\n');
  });

  return `<available_skills>\n${entries.join('\n')}\n</available_skills>`;
}

/**
 * Build a <skill-evolution-channels> block — teaches agents the two channels
 * for shaping Mavis's skill set as they work: signals (existing skill is wrong
 * or missing) and proposals (this session reveals a reusable new skill).
 *
 * v3 design: short trigger conditions in the reminder block, full how-to
 * lazy-loaded via the `skill-evolution` skill (avoids bloating every prompt
 * with rubrics and CLI flag tables).
 *
 * Renamed from <skill-signal-reporting> in v3 — proposals are now equally
 * first-class, and the previous name implied signal-only.
 *
 * Only injected when skillEvolve is enabled and the agent is not excluded
 * (controlled by the provider via `input.skillEvolveEnabled`). The proposal
 * section is independently gated by `skillProposalEnabled` — when proposal
 * is off, only the Signal section is rendered. When the entire block would
 * be signal-only AND signal is also off (only via excludeAgents), the
 * provider should not call this builder at all.
 */
export function buildSkillEvolutionChannelsBlock(
  opts: { skillProposalEnabled?: boolean } = {},
): string {
  const proposalEnabled = opts.skillProposalEnabled === true;
  const lines: string[] = [
    '<skill-evolution-channels>',
    `You can shape Mavis's skill set as you work.${proposalEnabled ? ' Two channels:' : ''}`,
    '',
    '**1. Signal — when an existing skill is wrong or missing**',
    'Trigger conditions (any one):',
    '- A loaded skill gave wrong / outdated / contradictory / incomplete instructions',
    "- A loaded skill's trigger conditions are too broad or too narrow",
    '- You wanted to do something but no skill covered it (issueKind = missing-skill)',
    '',
    'Action: `mavis skill signal report --issue-kind <kind> --evidence "<excerpt>"`',
    'Full command, issue-kind & attribution rubric, what NOT to report → **load `skill-evolution` skill** before your first signal this session.',
    '',
  ];
  if (proposalEnabled) {
    lines.push(
      '**2. Proposal — when this session reveals a reusable new skill**',
      'Trigger conditions (must satisfy ALL):',
      '- A clearly reusable working pattern emerged in this session',
      '- No existing skill covers it',
      '- Pattern repeats / will repeat (not a one-off task)',
      '- You can summarize what the skill would do in 1-2 sentences',
      '',
      'Action: `mavis skill proposal report --name <kebab> --scope agent-self --summary <text> --rationale <text>`',
      'Full schema, scope decision tree, good/bad examples → **load `skill-evolution` skill**.',
      '',
    );
  }
  lines.push(
    `Important: only act when the trigger conditions hold. Do NOT signal${
      proposalEnabled ? '/propose' : ''
    } just because a task was complex — that's noise. The nightly skill-evolve cron will handle whatever you submit.`,
    '',
    proposalEnabled
      ? 'If the user retracts their criticism, dismiss the report:'
      : 'If the user retracts their criticism, dismiss the signal:',
    '```',
    'mavis skill signal cancel --signal-id <prev-id>',
  );
  if (proposalEnabled) {
    lines.push('mavis skill proposal cancel --proposal-id <prev-id>');
  }
  lines.push('```', '</skill-evolution-channels>');
  return lines.join('\n');
}

/**
 * Backward-compatible alias for the renamed block builder. New code should
 * call `buildSkillEvolutionChannelsBlock` directly. This re-export exists
 * only to keep external imports compiling during the rename window — it can
 * be removed in a follow-up cleanup.
 *
 * @deprecated Use `buildSkillEvolutionChannelsBlock`.
 */
export function buildSkillSignalReportingBlock(): string {
  return buildSkillEvolutionChannelsBlock();
}

// ─── Note ────────────────────────────────────────────────────────────────────
// The monolithic buildSystemReminders() assembler has been replaced by
// the chain-of-responsibility pattern in providers.ts + registry.ts.
// Each block builder above is now called by an individual ReminderProviderFn.

/**
 * Build an <active-plan-reminder> block for orchestrator sessions that own
 * one or more active team plans. The block reminds the orchestrator that
 * any new work the user proposes likely belongs to an existing plan and
 * should be incorporated via `mavis team plan pause` + `decision` rather
 * than spawned as a standalone session.
 */
export function buildActivePlanReminderBlock(plans: ActivePlanSummary[]): string {
  const bullets = plans
    .map(
      (p) =>
        `  - ${p.plan_id} (cycle ${String(p.cycle)}, phase ${p.phase}, status: ${p.status}) — last updated: ${p.updated_at}`,
    )
    .join('\n');
  const planRef = plans[0]?.plan_id ?? '<plan_id>';
  return [
    '<active-plan-reminder>',
    `You own ${String(plans.length)} active team plan(s):`,
    bullets,
    'The `team` tool runs a producer-vs-verifier adversarial workflow — built for complex, high-stakes, or deeply-investigative work where independent verification matters more than raw speed.',
    `Treat any new work the user raises as in-scope for these plans by default. Fold it in via the existing plan rather than spawning a fresh session — before you start a new session, state in your reply why the work falls OUTSIDE ${planRef}.`,
    '</active-plan-reminder>',
  ].join('\n');
}

// ─── Async Audit ─────────────────────────────────────────────────────────────

export function buildAsyncAuditBlock(opts?: { scene?: 'cloud' | 'local' | undefined }): string {
  if (opts?.scene === 'cloud') {
    return (
      `<async-audit>\n` +
      `Review pending async work before scheduling a follow-up:\n` +
      `- If the current tool says it will resume this conversation when it finishes, rely on that result; do not create Cron.\n` +
      `- Waiting for a user reply alone: do not create Cron.\n` +
      `- For external state with no completion signal that needs a future Agent turn, use \`cron create\`\n` +
      `  through the \`mavis\` tool for a periodic re-check. State when to report and delete it.\n` +
      `- Otherwise do not create Cron.\n` +
      `</async-audit>`
    );
  }
  return (
    `<async-audit>\n` +
    `Review pending async work before scheduling a follow-up:\n` +
    `- If the current tool says it will resume this conversation when it finishes, rely on that result; do not create Cron.\n` +
    `- Waiting for a user reply alone: do not create Cron.\n` +
    `- For external state with no completion signal that needs a future Agent turn, use \`cron self\`\n` +
    `  to re-check it periodically. State when to report and delete it.\n` +
    `- Otherwise do not create Cron.\n` +
    `</async-audit>`
  );
}

/** Periodic reminder of the current surface's system-prompt delivery protocol. */
export function buildMediaOutputReminderBlock(_opts?: {
  scene?: 'cloud' | 'local' | undefined;
}): string {
  return [
    '<media-output-reminder>',
    "You MUST include file deliverables in the final response using the delivery format specified by the current surface's system prompt. Verify their current state; report failed or unverified outputs instead of claiming delivery.",
    '</media-output-reminder>',
  ].join('\n');
}

/** Build a <task-completion-reminder> block for active TodoWrite state. */
export function buildTaskCompletionReminderBlock(summary: {
  total: number;
  active: number;
  completed: number;
  cancelled: number;
}): string {
  return (
    `<task-completion-reminder>\n` +
    `You still have active TodoWrite items (${summary.active}/${summary.total} active; ` +
    `${summary.completed} completed, ${summary.cancelled} cancelled).\n` +
    `Before final delivery, either continue the unfinished work or update the todo list: ` +
    `mark completed work as completed and obsolete work as cancelled.\n` +
    `Do not present the task as complete while pending or in_progress todos remain.\n` +
    `</task-completion-reminder>`
  );
}

/**
 * Build an <engine-nudge> block for system-reminder injection.
 * Tells the agent to update the plan board file with a progress entry.
 */
export function buildBoardNudgeBlock(boardPath: string): string {
  return [
    '<engine-nudge>',
    'Please append a progress entry to the board file to report your current status.',
    `File path: ${boardPath}`,
    '</engine-nudge>',
  ].join('\n');
}

// ─── Worktree Reminder ───────────────────────────────────────────────────────

/**
 * Build a <worktree-reminder> block for git workspaces.
 *
 * Fired when the agent's workspace is a git checkout (and not already inside
 * a worktree). The selected workspace remains the default. The reminder asks
 * the agent to reuse an existing worktree before creating another one and to
 * follow repository-specific branch rules.
 */
export function buildWorktreeReminderBlock(): string {
  return [
    '<worktree-reminder>',
    'This workspace is a git repository. Use the workspace selected for this session by default:',
    '',
    '1. Read the repository instructions before changing tracked files. Do not commit directly to the default branch (for example `main`, `master`, `dev`, or `trunk`).',
    '2. Before creating a worktree, run `git worktree list --porcelain` and reuse a matching existing worktree when one is available.',
    '3. Create a new worktree only when the user explicitly requests one or the selected workspace cannot safely host the required branch.',
    '4. Do not create a nested worktree, install all dependencies, build the whole repository, or remove worktrees as task initialization or cleanup defaults.',
    '',
    'A read-only task does not need a branch or worktree.',
    '</worktree-reminder>',
  ].join('\n');
}

// ─── Secret Env Reminder ────────────────────────────────────────────────────

/**
 * Build a <secret-env> block listing the encrypted secret env var names the
 * agent can reference.
 *
 * Only NAMES are emitted — never values. The cloud-runtime `SecretMasker`
 * + `injectSecretEnvPrefix` (cloud-bash export-prefix path) handle the value
 * side; this block teaches the LLM what `${SECRET_NAME}` references are
 * resolvable in shell commands and that the `secret` tool manages them.
 *
 * Returns an empty string when `names` is empty — caller decides whether to
 * skip the emission entirely or render the block with a "(none)" line. The
 * default cloud provider (`secretEnvReminderProvider`) treats empty as
 * "stay silent".
 *
 * Names are emitted in the order supplied; caller should sort if a stable
 * order matters (the provider sorts before hashing for change-detection, so
 * it also sorts here for visual consistency).
 */
export function buildSecretEnvBlock(names: readonly string[]): string {
  if (names.length === 0) return '';
  const lines = [
    '<secret-env>',
    'Available encrypted secret env vars (managed via the `secret` tool):',
  ];
  for (const name of names) {
    lines.push(`  - ${name}`);
  }
  lines.push(
    // Literal `${SECRET_NAME}` placeholder shown to the LLM, not a JS template.
    // eslint-disable-next-line no-template-curly-in-string
    'Reference values in bash commands as ${SECRET_NAME} — they are auto-exported per command and masked in your output.',
    'Manage with `secret({command: "list" | "create" | "update" | "delete", args: "--name=... --value=..."})`.',
    '</secret-env>',
  );
  return lines.join('\n');
}
