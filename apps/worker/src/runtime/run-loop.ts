/**
 * Drives one-worker polling without converting a graceful shutdown into a
 * failed run. The abort signal cancels only the next idle long-poll; an
 * already received message remains under normal consumer acknowledgement.
 */
export async function runUntilAborted(
  signal: AbortSignal,
  processOnce: (signal: AbortSignal) => Promise<unknown>,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await processOnce(signal);
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    }
  }
}
