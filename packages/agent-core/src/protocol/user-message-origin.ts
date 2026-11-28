/**
 * A user-role message the Host wrote to report finished background tasks, not
 * the user. Canonical history marks it with `hostMetadata.backgroundTaskOrigin`.
 */
export function isBackgroundTaskUserMessage(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false;
  const hostMetadata: unknown = Reflect.get(message, 'hostMetadata');
  return (
    typeof hostMetadata === 'object' &&
    hostMetadata !== null &&
    !Array.isArray(hostMetadata) &&
    Object.hasOwn(hostMetadata, 'backgroundTaskOrigin')
  );
}

/**
 * A user-role message the Host submitted as Turn input: the initial message, a
 * batch member or an accepted steer. The Host records query provenance
 * (`canonicalTextRange` or `genuineUserQueryText`) on every such message,
 * whoever wrote it. A reminder an extension steers into the running Turn
 * carries none, and neither do messages persisted before provenance existed.
 */
export function isHostSubmittedUserInput(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    Reflect.get(message, 'role') === 'user' &&
    (Object.hasOwn(message, 'canonicalTextRange') || Object.hasOwn(message, 'genuineUserQueryText'))
  );
}
