/** Observe best-effort work after its caller has returned. Callers own diagnostics and state. */
export function settleInBackground(promise: Promise<unknown>): void {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises -- this is the shared detached boundary; rejections are consumed locally
  (async () => {
    try {
      await promise;
    } catch {
      /* The caller owns failure reporting or recovery. */
    }
  })();
}
