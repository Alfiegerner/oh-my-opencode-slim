import type { PerJobSupervision } from '../hooks/task-session-manager/pending-call-tracker';
import type { BackgroundJobRecord } from './background-job-board';
import type { BackgroundJobStore } from './background-job-store';

type TimerHandle = ReturnType<typeof setTimeout>;

export interface BackgroundJobSupervisorOptions {
  backgroundJobStore: BackgroundJobStore;
  wallClockTimeoutMs: number;
  abortGraceMs: number;
  abort: (taskID: string) => Promise<unknown>;
  now?: () => number;
  setTimeout?: (callback: () => void, delay: number) => TimerHandle;
  clearTimeout?: (timer: TimerHandle) => void;
}

interface RunTimers {
  generation: number;
  parentSessionID: string;
  wallClockTimeoutMs: number;
  abortGraceMs: number;
  deadlineTimer?: TimerHandle;
  graceTimer?: TimerHandle;
}

/**
 * Per-job opt-in supervision for one launch observation. Alias of the
 * canonical PerJobSupervision from pending-call-tracker (single source of
 * truth — the two seams share one shape). When `wallClockTimeoutMs` is a
 * finite per-job deadline it overrides the global default for this run only
 * (global default stays 0 = disabled). `abortGraceMs` overrides the global
 * grace for this run only. A `wallClockTimeoutMs` of 0/undefined keeps the
 * global behavior unchanged.
 */
export type PerJobSupervisorLaunch = PerJobSupervision;

/**
 * One-shot wall-clock supervision for native background task sessions.
 *
 * This class owns only timer/generation/abort mechanics. The board/coordinator
 * remains the atomic state and terminal-publication boundary.
 */
export class BackgroundJobSupervisor {
  private readonly now: () => number;
  private readonly setTimer: (
    callback: () => void,
    delay: number,
  ) => TimerHandle;
  private readonly clearTimer: (timer: TimerHandle) => void;
  private readonly runs = new Map<string, RunTimers>();
  private disposed = false;

  constructor(private readonly options: BackgroundJobSupervisorOptions) {
    this.now = options.now ?? Date.now;
    this.setTimer =
      options.setTimeout ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimeout ?? ((timer) => clearTimeout(timer));
  }

  /**
   * Register the first observation of a launch or an explicit new run.
   *
   * Per-job opt-in path for oracle/fixer long runs: pass `perJob` with a
   * finite `wallClockTimeoutMs` to arm a deadline for this run only, plus
   * an optional per-job `abortGraceMs`. Deadline → abort → grace →
   * terminal, using the same board/coordinator seams as the global path.
   * The global default stays 0 (disabled); omitting `perJob` preserves the
   * prior global-only behavior exactly.
   */
  onLaunch(record: BackgroundJobRecord, perJob?: PerJobSupervisorLaunch): void {
    if (this.disposed || record.background !== true) {
      this.clear(record.taskID);
      return;
    }
    // Defense-in-depth clamp: parsePerJobSupervision already bounds these,
    // but a direct onLaunch caller could pass anything. Out-of-range or
    // non-integer per-job values fail closed to the global option (which
    // itself stays 0 = disabled by default).
    const perJobTimeout =
      perJob?.wallClockTimeoutMs !== undefined &&
      Number.isInteger(perJob.wallClockTimeoutMs) &&
      perJob.wallClockTimeoutMs >= 60_000 &&
      perJob.wallClockTimeoutMs <= 2_147_483_647
        ? perJob.wallClockTimeoutMs
        : undefined;
    const perJobGrace =
      perJob?.abortGraceMs !== undefined &&
      Number.isInteger(perJob.abortGraceMs) &&
      perJob.abortGraceMs >= 1_000 &&
      perJob.abortGraceMs <= 60_000
        ? perJob.abortGraceMs
        : undefined;
    const wallClockTimeoutMs = perJobTimeout ?? this.options.wallClockTimeoutMs;
    const abortGraceMs = perJobGrace ?? this.options.abortGraceMs;
    if (wallClockTimeoutMs <= 0 || record.state !== 'running') {
      this.clear(record.taskID);
      return;
    }

    const current = this.runs.get(record.taskID);
    if (current?.generation === record.generation) return;
    this.clear(record.taskID);

    const run: RunTimers = {
      generation: record.generation,
      parentSessionID: record.parentSessionID,
      wallClockTimeoutMs,
      abortGraceMs,
    };
    run.deadlineTimer = this.setTimer(
      () => this.onDeadline(record.taskID, record.generation),
      Math.max(0, record.runStartedAt + wallClockTimeoutMs - this.now()),
    );
    this.runs.set(record.taskID, run);
  }

  /** Clear one-shot timers after any canonical terminal publication. */
  onTerminal(record: BackgroundJobRecord): void {
    if (
      record.state === 'completed' ||
      record.state === 'error' ||
      record.state === 'cancelled' ||
      record.state === 'reconciled'
    ) {
      const run = this.runs.get(record.taskID);
      if (run?.generation === record.generation) this.clear(record.taskID);
    }
  }

  /**
   * Handle a child deletion before the normal board drop callback. A deletion
   * during grace confirms the timed-out terminal; an ordinary deletion simply
   * invalidates the run without inventing a terminal result.
   */
  onSessionDeleted(taskID: string): boolean {
    if (this.disposed) {
      this.clear(taskID);
      return false;
    }
    const record = this.options.backgroundJobStore.get(taskID);
    if (!record) {
      this.clear(taskID);
      return false;
    }
    if (record.deadlineExceededAt !== undefined && record.state === 'running') {
      this.options.backgroundJobStore.finalizeWallClockTimeout({
        taskID,
        generation: record.generation,
        now: this.now(),
        statusUncertain: false,
        resultSummary:
          'Background task exceeded its wall-clock deadline; session deletion confirmed the abort.',
      });
      this.clear(taskID);
      return true;
    }
    this.clear(taskID);
    return false;
  }

  drop(taskID: string): void {
    this.clear(taskID);
  }

  clearParent(parentSessionID: string): void {
    for (const [taskID] of this.runs) {
      if (this.runs.get(taskID)?.parentSessionID === parentSessionID) {
        this.clear(taskID);
      }
    }
  }

  /** Idempotent local cleanup. It never aborts or writes terminal state. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const taskID of this.runs.keys()) this.clear(taskID);
    this.runs.clear();
  }

  private onDeadline(taskID: string, generation: number): void {
    const run = this.runs.get(taskID);
    if (this.disposed || !run || run.generation !== generation) return;
    run.deadlineTimer = undefined;

    const claimed = this.options.backgroundJobStore.claimWallClockDeadline({
      taskID,
      generation,
      now: this.now(),
    });
    if (!claimed) {
      this.clear(taskID);
      return;
    }

    // The grace timer is armed before abort is invoked. A rejected or hanging
    // SDK promise must never prevent the bounded terminal transition.
    // Per-job runs use their own grace; global runs use the global grace.
    run.graceTimer = this.setTimer(
      () => this.onGraceExpired(taskID, generation),
      run.abortGraceMs,
    );
    Promise.resolve()
      .then(() => this.options.abort(taskID))
      .catch(() => undefined);
  }

  private onGraceExpired(taskID: string, generation: number): void {
    const run = this.runs.get(taskID);
    if (this.disposed || !run || run.generation !== generation) return;
    run.graceTimer = undefined;
    this.options.backgroundJobStore.finalizeWallClockTimeout({
      taskID,
      generation,
      now: this.now(),
      statusUncertain: true,
      resultSummary:
        'Background task exceeded its wall-clock deadline; abort was not confirmed before the grace period expired.',
    });
    this.clear(taskID);
  }

  private clear(taskID: string): void {
    const run = this.runs.get(taskID);
    if (!run) return;
    if (run.deadlineTimer !== undefined) this.clearTimer(run.deadlineTimer);
    if (run.graceTimer !== undefined) this.clearTimer(run.graceTimer);
    this.runs.delete(taskID);
  }
}
