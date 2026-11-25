/**
 * `cancel-in-progress: false` on one concurrency group.
 * The running workflow is left alone. GitHub keeps a single pending run,
 * so a newer schedule or chained dispatch replaces whatever was waiting.
 * Every trigger runs the same full collect (`--if-incomplete --recover-npm`),
 * so whichever pending run survives still finishes core sources and npm.
 */
export const COLLECT_TRIGGERS = ["00:20", "05:41", "08:47", "19:23", "chain"] as const;

export type CollectTrigger = (typeof COLLECT_TRIGGERS)[number];

export type CollectQueueState = {
  active: CollectTrigger | null;
  pending: CollectTrigger | null;
};

export type CollectRunPlan = {
  ifIncomplete: true;
  recoverNpm: true;
  /** npm is resumed by `--recover-npm`, never as an npm-only run. */
  npmOnly: false;
};

export function collectRunPlan(trigger: CollectTrigger): CollectRunPlan {
  if (!COLLECT_TRIGGERS.includes(trigger)) {
    throw new Error(`unknown collect trigger ${trigger}`);
  }
  return { ifIncomplete: true, recoverNpm: true, npmOnly: false };
}

export function enqueueCollectRun(
  state: CollectQueueState,
  next: CollectTrigger,
): { state: CollectQueueState; cancelled: CollectTrigger | null } {
  if (state.active == null) {
    return { state: { active: next, pending: null }, cancelled: null };
  }
  return {
    state: { active: state.active, pending: next },
    cancelled: state.pending,
  };
}
