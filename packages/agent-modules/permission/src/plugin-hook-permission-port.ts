import type { PermissionRule } from './types.js';

export type PluginHookPermissionUpdateDestination =
  | 'session'
  | 'localSettings'
  | 'projectSettings'
  | 'userSettings';

export type PluginHookPermissionUpdateMode =
  | 'default'
  | 'auto'
  | 'acceptEdits'
  | 'dontAsk'
  | 'bypassPermissions'
  | 'plan';

export interface PluginHookPermissionRuleValue {
  readonly toolName: string;
  readonly ruleContent?: string;
}

/** Structural projection of the validated Hook permission mutation contract. */
export type PluginHookPermissionUpdate =
  | {
      readonly type: 'addRules' | 'replaceRules' | 'removeRules';
      readonly rules: readonly PluginHookPermissionRuleValue[];
      readonly behavior: 'allow' | 'deny' | 'ask';
      readonly destination: PluginHookPermissionUpdateDestination;
    }
  | {
      readonly type: 'setMode';
      readonly mode: PluginHookPermissionUpdateMode;
      readonly destination: PluginHookPermissionUpdateDestination;
    }
  | {
      readonly type: 'addDirectories' | 'removeDirectories';
      readonly directories: readonly string[];
      readonly destination: PluginHookPermissionUpdateDestination;
    };

export interface LocalPluginHookEffectivePermissions {
  readonly mode?: Exclude<PluginHookPermissionUpdateMode, 'plan'>;
  readonly rules: readonly PermissionRule[];
  readonly directories: readonly string[];
}

export interface LocalPluginHookPermissionMutationInput {
  readonly sessionId: string;
  readonly cwd: string;
  readonly updates: readonly PluginHookPermissionUpdate[];
  /** Product-owned launch capability; Hook output can never grant it. */
  readonly bypassAvailable: boolean;
}

/** Plugin-owned state consumed by the public permission policy; no persistence ownership. */
export interface LocalPluginHookPermissionCapability {
  effective(input: {
    readonly sessionId?: string;
    readonly cwd: string;
  }): Promise<LocalPluginHookEffectivePermissions>;
  applyAtomic(input: LocalPluginHookPermissionMutationInput): Promise<void>;
  clearSession(sessionId: string): Promise<void>;
}

/** Instance-local binding only. Missing or released owners always fail closed. */
export function createDeferredPluginHookPermissionCapability(): {
  capability: LocalPluginHookPermissionCapability;
  bind(owner: LocalPluginHookPermissionCapability): () => void;
} {
  let current: LocalPluginHookPermissionCapability | undefined;
  const requireOwner = () => {
    if (!current)
      throw new Error('Plugin Hook permission owner is not initialized or has been closed.');
    return current;
  };
  return {
    capability: {
      effective: async (input) => requireOwner().effective(input),
      applyAtomic: async (input) => requireOwner().applyAtomic(input),
      clearSession: async (sessionId) => requireOwner().clearSession(sessionId),
    },
    bind: (owner) => {
      if (current) throw new Error('Plugin Hook permission owner is already bound.');
      current = owner;
      return () => {
        if (current === owner) current = undefined;
      };
    },
  };
}
