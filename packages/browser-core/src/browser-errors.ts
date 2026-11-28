/**
 * The Browser error contract shared by every provider and both ends: a stable
 * code, why the call failed, and what the caller should do next.
 *
 * Failure results carry it as `{ code, error: reason, recovery: next }`;
 * thrown errors carry it as one message, `CODE: reason Next: next`, which the
 * desktop broker forwards unchanged.
 */
export interface BrowserErrorTriple {
  readonly code: string;
  readonly reason: string;
  readonly next: string;
}

export function formatBrowserErrorTriple(triple: BrowserErrorTriple): string {
  return `${triple.code}: ${triple.reason} Next: ${triple.next}`;
}

export function browserErrorTripleResult(triple: BrowserErrorTriple): {
  success: false;
  code: string;
  error: string;
  recovery: string;
} {
  return { success: false, code: triple.code, error: triple.reason, recovery: triple.next };
}
