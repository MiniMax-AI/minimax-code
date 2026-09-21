import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoundedInternalTurnPromptReadRegistry } from '@mavis/agent-runtime';

import { DatabaseClient } from '../../infra/db/client.js';
import { initializeDatabase } from '../../infra/db/initialize.js';
import { AgentImportService } from '../../service/agent/index.js';
import { DrizzleAgentRepository } from '../../service/agent/storage/agent.repository.js';
import { ContentSafetyService, type SafetyCheckResult } from '../../service/content-safety/index.js';
import { type LocalRuntimeConfig } from '../../service/model-system/index.js';
import { createTestAgentService } from '../../../test/helpers/agent-service.js';
import { createRuntimeAgentApplication } from './agent-application.js';

const BYOK = 'custom_provider:local/test-model';
const MANAGED = 'minimax/MiniMax-M3';
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function fixture(runtimeOwnerKind: string | undefined = 'tui') {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-config-review-'));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const database = new DatabaseClient({ dataDir });
  cleanup.push(() => database.close());
  await initializeDatabase({ database, dataDir });
  const repository = new DrizzleAgentRepository({ db: database.db, dataDir });
  const service = createTestAgentService({ repository, nowMs: () => 10 });
  cleanup.push(() => service.close());
  const config: LocalRuntimeConfig = {
    dataDir,
    defaultModel: BYOK,
    provider: {
      minimax: {
        options: { authMode: 'managed-login' },
        models: { 'MiniMax-M3': {} },
      },
    },
    custom_provider: {
      local: {
        options: { baseURL: 'https://example.test/v1' },
        models: { 'test-model': {} },
      },
    },
  };
  const review = vi.fn(async (): Promise<SafetyCheckResult> => ({
    pass: false, errorKind: 'auth_error',
  }));
  const application = createRuntimeAgentApplication({
    agentService: service,
    config: () => config,
    pinService: { removeAgent: vi.fn() },
    safety: new ContentSafetyService({ review }),
    writeGlobalEvent: vi.fn(),
    internalTurnPromptReads: new BoundedInternalTurnPromptReadRegistry(),
    product: {},
    options: {
      runtimeOwnerKind,
      compatibility: {
        cron: { deleteAgentTasks: vi.fn(async () => undefined) },
        greeting: { canSend: () => false, sendSystemReminder: vi.fn(async () => 'finished' as const) },
      },
    },
  }, { session: { root: { getRootSessionByAgent: vi.fn() } } });
  cleanup.push(() => application.close());
  return { application, service, config, review };
}

function definition(name: string, model?: string) {
  return { name, description: 'Synthetic agent', model, systemPrompt: 'Write clearly.' };
}

function markdown(name: string, model?: string) {
  return `---\nname: ${name}\ndescription: Synthetic agent\n${model ? `model: ${model}\n` : ''}---\nWrite carefully.\n`;
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Operation = 'create' | 'update' | 'document' | 'import';
const operations: Operation[] = ['create', 'update', 'document', 'import'];

async function operation(f: Fixture, kind: Operation, model?: string) {
  const name = `${kind}-agent`;
  if (kind === 'create') {
    await f.application.createDefinition({ name, initialDefinition: definition(name, model) });
  } else if (kind === 'import') {
    const content = markdown(name, model);
    const preview = new AgentImportService().preview('claude-code', content);
    await f.application.createImportedDefinition({
      format: 'claude-code', content, expectedDigest: preview.sourceDigest, targetName: name,
    });
  } else {
    await f.service.create({ name, initialDefinition: definition(name, model) });
    if (kind === 'update') {
      await f.application.update({
        requestRef: `agent:${name}`, displayName: 'Renamed agent',
        description: 'New description',
      });
    } else {
      const current = await f.service.getConfigDocument(`agent:${name}`);
      await f.application.putConfigDocument({
        requestRef: `agent:${name}`, content: markdown(name, model),
        expectedRevision: current.revision, expectedOwnerInstanceId: current.ownerInstanceId,
      });
    }
  }
  return f.service.getConfigDocument(`agent:${name}`);
}

describe('production Agent configuration review', () => {
  it.each(operations)('persists signed-out BYOK %s without calling the managed gateway', async (kind) => {
    const f = await fixture();
    const saved = await operation(f, kind, BYOK);
    expect(saved.configured.model).toBe(BYOK);
    expect(saved.configured.systemPrompt).toContain(
      kind === 'create' || kind === 'update' ? 'Write clearly.' : 'Write carefully.',
    );
    if (kind === 'update') {
      expect((await f.service.get('agent:update-agent')).displayName).toBe('Renamed agent');
    }
    expect(f.review).not.toHaveBeenCalled();
  });

  it.each(operations)('uses the runtime default only when %s has no explicit Agent model', async (kind) => {
    const f = await fixture();
    await operation(f, kind);
    expect(f.review).not.toHaveBeenCalled();
  });

  it.each(operations)('retains managed review for %s even with a BYOK runtime default', async (kind) => {
    const f = await fixture();
    await expect(operation(f, kind, MANAGED)).rejects.toMatchObject({ code: 'CONTENT_POLICY_VIOLATION' });
    expect(f.review).toHaveBeenCalled();
    if (kind === 'create' || kind === 'import') {
      await expect(f.service.get(`agent:${kind}-agent`)).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
    } else {
      const saved = await f.service.getConfigDocument(`agent:${kind}-agent`);
      expect(saved.configured.systemPrompt).toBe('Write clearly.');
      expect((await f.service.get(`agent:${kind}-agent`)).displayName).not.toBe('Renamed agent');
    }
  });

  it.each(['cli', 'tui'])('uses the explicit BYOK Agent model over a managed default in %s', async (owner) => {
    const f = await fixture(owner);
    f.config.defaultModel = MANAGED;
    await operation(f, 'update', BYOK);
    expect(f.review).not.toHaveBeenCalled();
  });

  it.each(['electron', 'unknown'])('preserves %s configuration review for BYOK', async (owner) => {
    const f = await fixture(owner);
    await expect(operation(f, 'create', BYOK)).rejects.toMatchObject({ code: 'CONTENT_POLICY_VIOLATION' });
    expect(f.review).toHaveBeenCalled();
  });

  it('resolves bare custom-provider keys using the Agent catalog rules', async () => {
    const f = await fixture();
    await operation(f, 'create', 'local/test-model');
    expect(f.review).not.toHaveBeenCalled();
  });

  it('does not mistake a managed provider with the same key for a custom provider', async () => {
    const f = await fixture();
    f.config.provider.local = { options: { authMode: 'managed-login' }, models: { 'test-model': {} } };
    await expect(operation(f, 'create', 'local/test-model')).rejects.toMatchObject({ code: 'CONTENT_POLICY_VIOLATION' });
  });

  it.each(['missing/test-model', 'custom_provider:local/missing', 'malformed'])('keeps the gate for unresolved model %s', async (model) => {
    const f = await fixture();
    await expect(operation(f, 'create', model)).rejects.toMatchObject({ code: 'CONTENT_POLICY_VIOLATION' });
    expect(f.review).toHaveBeenCalled();
  });

  it('keeps the gate for a disabled custom provider', async () => {
    const f = await fixture();
    f.config.custom_provider!.local!.enabled = false;
    await expect(operation(f, 'create', BYOK)).rejects.toMatchObject({ code: 'CONTENT_POLICY_VIOLATION' });
  });

  it.each([MANAGED, undefined])('reviews the candidate when a BYOK document changes its model to %s', async (model) => {
    const f = await fixture();
    await f.application.createDefinition({ name: 'writer', initialDefinition: definition('writer', BYOK) });
    const current = await f.service.getConfigDocument('agent:writer');
    f.config.defaultModel = MANAGED;
    const content = markdown('writer', model);
    await expect(f.application.putConfigDocument({
      requestRef: 'agent:writer', content, expectedRevision: current.revision,
      expectedOwnerInstanceId: current.ownerInstanceId,
    })).rejects.toMatchObject({ code: 'CONTENT_POLICY_VIOLATION' });
    expect(f.review).toHaveBeenCalledWith(content.trim(), 205);
    expect((await f.service.getConfigDocument('agent:writer')).revision).toBe(current.revision);
  });

  it('can explicitly switch a managed document to BYOK without a managed login', async () => {
    const f = await fixture();
    await f.service.create({ name: 'writer', initialDefinition: definition('writer', MANAGED) });
    const current = await f.service.getConfigDocument('agent:writer');
    await f.application.putConfigDocument({
      requestRef: 'agent:writer', content: markdown('writer', BYOK),
      expectedRevision: current.revision, expectedOwnerInstanceId: current.ownerInstanceId,
    });
    expect((await f.service.getConfigDocument('agent:writer')).configured.model).toBe(BYOK);
    expect(f.review).not.toHaveBeenCalled();
  });

  it('reads current inherited defaults again on every edit', async () => {
    const f = await fixture();
    await f.application.createDefinition({ name: 'writer', displayName: 'Original' });
    await f.application.update({ requestRef: 'agent:writer', displayName: 'Local name' });
    f.config.defaultModel = MANAGED;
    await expect(f.application.update({ requestRef: 'agent:writer', displayName: 'Blocked name' }))
      .rejects.toMatchObject({ code: 'CONTENT_POLICY_VIOLATION' });
    expect((await f.service.get('agent:writer')).displayName).toBe('Local name');
  });

  it.each([
    { pass: true }, { pass: false, errorKind: 'api_error' },
    { pass: false, errorKind: 'rejected' }, { pass: false, errorKind: 'auth_error' },
    { pass: false, errorKind: 'local_error' }, { pass: false },
  ] satisfies SafetyCheckResult[])('preserves managed verdict semantics for %j', async (verdict) => {
    const f = await fixture();
    f.review.mockResolvedValue(verdict);
    const save = operation(f, 'create', MANAGED);
    if (verdict.pass || ('errorKind' in verdict && verdict.errorKind === 'api_error')) await save;
    else await expect(save).rejects.toMatchObject({ code: 'CONTENT_POLICY_VIOLATION' });
    expect(f.review).toHaveBeenCalled();
  });

  it('preserves model validation and canonical document conflict checks', async () => {
    const f = await fixture();
    await operation(f, 'create', BYOK);
    const current = await f.service.getConfigDocument('agent:create-agent');
    await expect(f.application.putConfigDocument({
      requestRef: 'agent:create-agent', content: markdown('create-agent', BYOK),
      expectedRevision: 'stale-revision', expectedOwnerInstanceId: current.ownerInstanceId,
    })).rejects.toMatchObject({ code: 'AGENT_CONFIG_REVISION_CONFLICT' });
    f.service.bindCandidateModelValidator(async () => ({ ok: false, reason: 'unavailable' }));
    await expect(f.application.update({ requestRef: 'agent:create-agent', displayName: 'Blocked' }))
      .rejects.toMatchObject({ code: 'AGENT_CONFIG_INVALID' });
    expect(f.review).not.toHaveBeenCalled();
  });

  it('rejects malformed documents without persistence or an unrelated managed request', async () => {
    const f = await fixture();
    await operation(f, 'create', BYOK);
    const current = await f.service.getConfigDocument('agent:create-agent');
    await expect(f.application.putConfigDocument({
      requestRef: 'agent:create-agent', content: '---\nname: [\n---\nInvalid',
      expectedRevision: current.revision, expectedOwnerInstanceId: current.ownerInstanceId,
    })).rejects.toMatchObject({ code: 'AGENT_CONFIG_INVALID' });
    expect((await f.service.getConfigDocument('agent:create-agent')).revision).toBe(current.revision);
    expect(f.review).not.toHaveBeenCalled();
  });

  it.each(['persona', 'systemPrompt'] as const)('keeps the canonical editing requirement for legacy %s patches', async (field) => {
    const f = await fixture();
    await operation(f, 'create', BYOK);
    await expect(f.application.update({ requestRef: 'agent:create-agent', [field]: 'New instructions' }))
      .rejects.toMatchObject({ code: 'AGENT_CONFIG_INVALID' });
    expect(f.review).not.toHaveBeenCalled();
  });
});
