/**
 * Internal control-flow error for the immutable run-level time budget.
 * It is intentionally distinct from a per-tool timeout: the only permitted
 * terminal behavior is an audited abstention, never a partial publication.
 */
export class RunDeadlineExceeded extends Error {
  constructor() {
    super("research run deadline exceeded");
    this.name = "RunDeadlineExceeded";
  }
}

/**
 * Controlled worker-drain terminal signal. It is not a failed research run:
 * the runtime records an abstention after cancelling in-flight provider calls.
 */
export class RunShutdownRequested extends Error {
  constructor() {
    super("research worker shutdown requested");
    this.name = "RunShutdownRequested";
  }
}
