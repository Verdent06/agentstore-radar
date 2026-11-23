/**
 * `cancel-in-progress: false` on one concurrency group.
 * The running workflow is left alone. GitHub keeps a single pending run,
 * so a newer schedule replaces whatever was waiting.
 */
export type CollectQueueRun = "npm" | "collect";

export type CollectQueueState = {
  active: CollectQueueRun | null;
  pending: CollectQueueRun | null;
};

export function enqueueCollectRun(
  state: CollectQueueState,
  next: CollectQueueRun,
): { state: CollectQueueState; cancelled: CollectQueueRun | null } {
  if (state.active == null) {
    return { state: { active: next, pending: null }, cancelled: null };
  }
  return {
    state: { active: state.active, pending: next },
    cancelled: state.pending,
  };
}
