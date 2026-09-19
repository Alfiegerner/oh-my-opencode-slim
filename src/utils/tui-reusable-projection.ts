import { updateSnapshot } from '../tui-state';
import type {
  BackgroundJobBoard,
  ReusableSessionSelection,
} from './background-job-board';

/**
 * Board → tui-state projection for the sidebar's reusable dot (#1197
 * follow-up). On every board mutation (set/delete/trim/drop — the
 * listener is intentionally payload-less), re-derive the latest
 * reconciled session per agent for every tracked parent session and
 * persist it into the snapshot's `reusableByAgent` section. The TUI is a
 * pure reader of this section; it never writes it.
 *
 * Tracked parents are learned from launches observed after creation (the
 * identity hook registers each parent on its first child launch). The set
 * grows monotonically: a parent whose records are all gone contributes
 * nothing to the derivation, so there is no need to prune it. The board
 * is process-local, so this section must never be restored from a stale
 * file — the creation sweep clears it and the projection repopulates
 * from the live board.
 *
 * Cost: O(jobs of the parent) per mutation — the derivation is a single
 * pass over the board scoped by parentSessionID. `updateSnapshot`
 * early-outs when the derived section is unchanged, so no-op mutations
 * (e.g. heartbeat status updates) never touch the filesystem.
 */

interface ProjectorHandle {
  /** Register a parent session as tracked (first child launch seen). */
  trackParent(parentSessionID: string): void;
  /** Cancel the projection permanently (host teardown). */
  dispose(): void;
}

export function createTuiReusableProjection(input: {
  board: BackgroundJobBoard;
  projectDir: string;
}): ProjectorHandle {
  const { board, projectDir } = input;
  const trackedParents = new Set<string>();
  let disposed = false;

  const project = (): void => {
    if (disposed) return;
    updateSnapshot(projectDir, (snapshot) => {
      const next: Record<string, Record<string, ReusableSessionSelection>> = {};
      for (const parentSessionID of trackedParents) {
        const byAgent = board.latestReconciledByAgent(parentSessionID);
        if (byAgent.size > 0)
          next[parentSessionID] = Object.fromEntries(byAgent);
      }
      snapshot.reusableByAgent = next;
    });
  };

  const listener = (): void => {
    try {
      project();
    } catch {
      // Best-effort: a projection failure must never break the board.
    }
  };

  board.addMutationListener(listener);

  // The board is process-local (board = store): any section persisted
  // by a previous host process is stale by construction. Clear it once
  // at creation so dead dots can never survive a host restart, even if
  // no board mutation ever follows.
  listener();

  return {
    trackParent(parentSessionID: string): void {
      trackedParents.add(parentSessionID);
    },
    dispose() {
      disposed = true;
      board.removeMutationListener(listener);
    },
  };
}
