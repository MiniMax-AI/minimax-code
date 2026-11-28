/**
 * Where a session_create call says the new session works, read once for the
 * permission gate, the Runtime's project approval and the tool itself, so the
 * directory the user approves is the one the session is created in. Values are
 * trimmed and a blank value counts as omitted. `both` is refused by the tool
 * before anything is created, so it leaves no scope to approve. With neither
 * `project` nor `workspace_dir`, an `existing_worktree` location names its
 * `worktree_dir`; anything else is `none`, the Agent default, which a
 * `new_worktree` branches from.
 */
export type SessionCreateScope =
  | { readonly kind: 'none' }
  | { readonly kind: 'both' }
  | { readonly kind: 'project'; readonly value: string }
  | { readonly kind: 'workspace_dir'; readonly value: string }
  | { readonly kind: 'worktree_dir'; readonly value: string };

export function readSessionCreateScope(args: object): SessionCreateScope {
  const project = nonBlank(Reflect.get(args, 'project'));
  const workspaceDir = nonBlank(Reflect.get(args, 'workspace_dir'));
  if (project !== undefined && workspaceDir !== undefined) return { kind: 'both' };
  if (project !== undefined) return { kind: 'project', value: project };
  if (workspaceDir !== undefined) return { kind: 'workspace_dir', value: workspaceDir };
  const worktreeDir = existingWorktreeDir(Reflect.get(args, 'location'));
  return worktreeDir === undefined
    ? { kind: 'none' }
    : { kind: 'worktree_dir', value: worktreeDir };
}

/** Whether the call names a scope, which is what asks the user to approve that project. */
export function namesSessionCreateScope(args: object): boolean {
  const { kind } = readSessionCreateScope(args);
  return kind !== 'none' && kind !== 'both';
}

function existingWorktreeDir(location: unknown): string | undefined {
  if (typeof location !== 'object' || location === null) return undefined;
  if (Reflect.get(location, 'mode') !== 'existing_worktree') return undefined;
  return nonBlank(Reflect.get(location, 'worktree_dir'));
}

function nonBlank(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
