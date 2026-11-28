/**
 * Whether a process with this pid exists. POSIX and Windows: ESRCH means the
 * pid is gone; EPERM means it exists but belongs to another user. A live pid
 * does not prove a live lock holder (Windows reuses pids quickly), so lock
 * owners pair this with an age limit. Shared by the local runtime migration
 * lock and the config.yaml state lock.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code !== 'ESRCH';
  }
}
