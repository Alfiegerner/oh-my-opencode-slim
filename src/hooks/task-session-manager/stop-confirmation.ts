import type {
  BackgroundJobRecord,
  BackgroundJobStore,
  ContextFile,
} from '../../utils';
import {
  type ChildTerminalEvidence,
  classifyAssistantTurnEvidence,
  type TranscriptMessage,
} from '../../utils/child-transcript';
import { isRecord } from '../../utils/guards';

export const STOP_CONFIRMATION_GRACE_MS = 5_000;

/** Deadline for a single transcript read inside the stop gate. A hung
 * read must not block the reconciler loop (or join other confirmations)
 * indefinitely; timeout degrades to an unknown-evidence verdict. */
export const DEFAULT_EVIDENCE_READ_TIMEOUT_MS = 5_000;

/** Race a promise against a deadline. On timeout the CONSUMER is
 * released with `undefined` (unknown evidence) while the underlying
 * operation may keep running — callers that must not pile up reads
 * layer a single-open policy on top (see createStopEvidenceGate).
 * `timeoutMs <= 0` disables the deadline (the promise still maps
 * rejection to `undefined`). */
export function raceEvidenceDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  const settled = promise.catch(() => undefined);
  if (timeoutMs <= 0) return settled;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([settled, timeout]).finally(() => clearTimeout(timer));
}

/** Retry budget per quiescence EPISODE (the stop-confirmation anchor;
 * busy recovery opens a new episode and resets it). Unknown evidence
 * NEVER terminates into `stopped` — the budget only escalates the
 * statusUncertain diagnostic. Retries stay bounded in frequency (the
 * grace cadence) and self-heal: a later valid read settles the job.
 * The #1157 termination guarantee lives on the `absent` path, which
 * requires a VALID read that provably holds no result for this run
 * (declared limit: without any readable result source, "no false stop"
 * and "always terminates" cannot both hold). */
const DEFAULT_MAX_EVIDENCE_RETRIES = 3;

export const STOPPED_WITHOUT_TERMINAL_RESULT =
  'Background session stopped before a terminal task result was received.';

export const EVIDENCE_UNAVAILABLE_DIAGNOSTIC =
  'Terminal evidence could not be read after repeated attempts; task termination is unconfirmed (observation unavailable).';

export type StopConfirmationTracker = {
  pendingManagedTaskIds: Set<string>;
  contextFilesForPrompt(taskId: string): ContextFile[];
  prune(board: { taskIDs(): Set<string> }): void;
};

export function applyConfirmedStop(options: {
  backgroundJobBoard: BackgroundJobStore;
  taskID: string;
  observedAt: number;
  generation: number;
  taskContextTracker: StopConfirmationTracker;
}): BackgroundJobRecord | undefined {
  const stopped = options.backgroundJobBoard.markStopped(
    options.taskID,
    STOPPED_WITHOUT_TERMINAL_RESULT,
    options.observedAt,
    options.generation,
  );
  if (stopped?.state !== 'stopped') return stopped;
  options.taskContextTracker.pendingManagedTaskIds.delete(options.taskID);
  options.backgroundJobBoard.addContext(
    options.taskID,
    options.taskContextTracker.contextFilesForPrompt(options.taskID),
  );
  options.taskContextTracker.prune(options.backgroundJobBoard);
  return stopped;
}

/**
 * Idle/absent/non-busy is only a stop candidate. The first observation
 * starts a grace clock; a later observation after the grace confirms
 * the stop. Live busy after the observation wins and leaves the job running.
 *
 * When `confirmStop` is provided, the post-grace confirmation is delegated
 * to it (terminal-evidence gate): quiescence alone proves the session is
 * not running, not that no result exists — the transcript must be
 * consulted before publishing `stopped` (false-stop incident: a fallback
 * re-prompt completed its answer while the grace timer was still armed).
 */
export async function observeNonBusyRuntime(options: {
  backgroundJobBoard: BackgroundJobStore;
  taskID: string;
  observedAt: number;
  generation: number;
  graceMs: number;
  lastStatusError: string;
  taskContextTracker: StopConfirmationTracker;
  /** Idle timestamp the quiescence was first observed at (busy guard);
   * defaults to observedAt for periodic-poll callers. Stays IMMUTABLE
   * across retries — it is the real idle anchor that opened the
   * decision, never a synthetic grace-consuming timestamp. */
  idleObservedAt?: number;
  /** Delegated post-grace confirmation. Returns the updated record. */
  confirmStop?: (options: {
    taskID: string;
    observedAt: number;
    idleObservedAt: number;
    lastStatusError: string;
    onRetry?: () => void;
  }) => Promise<BackgroundJobRecord | undefined>;
}): Promise<BackgroundJobRecord | undefined> {
  const job = options.backgroundJobBoard.get(options.taskID);
  if (job?.state !== 'running' || job.generation !== options.generation) {
    return job;
  }
  if (
    job.lastLiveBusyAt !== undefined &&
    job.lastLiveBusyAt > options.observedAt
  ) {
    return job;
  }

  const observationTime = options.observedAt + 1;
  const startedAt = job.stopConfirmationStartedAt;
  if (
    startedAt === undefined ||
    observationTime - startedAt < options.graceMs
  ) {
    if (startedAt === undefined) {
      options.backgroundJobBoard.noteStopConfirmation(
        options.taskID,
        observationTime,
        options.generation,
      );
    }
    return options.backgroundJobBoard.markStatusUncertain(
      options.taskID,
      options.lastStatusError,
      options.generation,
      options.observedAt,
    );
  }

  if (options.confirmStop) {
    return options.confirmStop({
      taskID: options.taskID,
      observedAt: observationTime,
      idleObservedAt: options.idleObservedAt ?? options.observedAt,
      lastStatusError: options.lastStatusError,
    });
  }

  return applyConfirmedStop({
    backgroundJobBoard: options.backgroundJobBoard,
    taskID: options.taskID,
    observedAt: observationTime,
    generation: options.generation,
    taskContextTracker: options.taskContextTracker,
  });
}

export type TerminalEvidenceVerdict =
  | { verdict: 'completed'; text: string }
  | { verdict: 'error'; text: string }
  | { verdict: 'absent' }
  | { verdict: 'retry'; reason: string };

function messageRole(message: TranscriptMessage): unknown {
  return message.info?.role;
}

function isRecognizableMessage(message: TranscriptMessage): boolean {
  const role = messageRole(message);
  if (role === 'assistant' || role === 'user' || role === 'system') {
    return true;
  }
  return typeof message.info?.id === 'string';
}

/** Structural (non-assistant, non-user) tail entries the backward scan
 * may skip: synthetic/system/skill markers carrying a DEFINED string
 * role. An undefined role is never skippable — the entry may be the
 * newest tail. */
function isStructuralTail(message: TranscriptMessage): boolean {
  const role = messageRole(message);
  return typeof role === 'string' && role !== 'assistant' && role !== 'user';
}

/** Map the shared terminal classifier onto the stop decision. The gate
 * owns validity/provenance/absence/segment selection; the ONE-turn
 * terminality contract (pending finish states, completion time,
 * segment-wide pending tool calls, terminal error precedence, usable
 * text) is delegated to `classifyAssistantTurnEvidence` — the same
 * contract the revived-run tracker probe uses — so the two cannot
 * diverge. */
function verdictFromEvidence(
  evidence: ChildTerminalEvidence,
): TerminalEvidenceVerdict {
  switch (evidence.kind) {
    case 'ready':
      return { verdict: 'completed', text: evidence.text };
    case 'error':
      return { verdict: 'error', text: evidence.errorText };
    case 'pending':
      return { verdict: 'retry', reason: 'pending' };
    case 'textless':
      return { verdict: 'retry', reason: 'textless' };
    default:
      return { verdict: 'retry', reason: 'unrecognized segment shape' };
  }
}

/**
 * Classify a child transcript response for the stop decision. The
 * distinction that matters: `absent` means the transcript was read
 * correctly and provably holds no result for THIS run; `retry` means
 * the evidence is unknown (unreadable, malformed, provenance
 * unverifiable, or the answer has not materialized) and must never be
 * treated as proof of no result.
 *
 * Provenance rules:
 * - With a baseline: only the post-baseline segment is considered. An
 *   assistant turn is attributed to this run only when nothing newer
 *   than it represents pending work — the backward scan from a
 *   structural tail may NOT cross a real user message (that user
 *   message is work whose answer has not arrived yet → retry).
 * - Without a baseline (untracked native jobs): only the ABSOLUTE
 *   trailing message counts (strict semantics — no scan back through
 *   history), and an assistant turn is only attributed when its
 *   completion timestamp is at/after the run started.
 */
export function classifyTerminalEvidence(
  response: unknown,
  options: { baselineMessageID?: string; runStartedAt?: number } = {},
): TerminalEvidenceVerdict {
  if (response === undefined) {
    return { verdict: 'retry', reason: 'transcript source unavailable' };
  }
  if (!isRecord(response) || !Array.isArray(response.data)) {
    return { verdict: 'retry', reason: 'malformed transcript response' };
  }
  // Structural validity: an entry that is not a record or carries no
  // recognizable message shape makes the WHOLE read malformed — entries
  // are never silently dropped, because a dropped entry may be the
  // newest tail whose loss would "repair" the transcript into a false
  // absence or attribution.
  const all: TranscriptMessage[] = [];
  for (const entry of response.data) {
    if (!isRecord(entry) || !isRecognizableMessage(entry)) {
      return { verdict: 'retry', reason: 'malformed transcript entries' };
    }
    all.push(entry);
  }

  if (options.baselineMessageID) {
    const baselineIndex = all.findIndex(
      (m) => m.info?.id === options.baselineMessageID,
    );
    if (baselineIndex < 0) {
      // The baseline anchor is gone (compaction/revert): provenance for
      // "which run does this trailing answer belong to" cannot be verified.
      return { verdict: 'retry', reason: 'baseline message missing' };
    }
    const segment = all.slice(baselineIndex + 1);
    // Scan back from the tail across STRUCTURAL non-assistant tails
    // (synthetic/system markers). A real USER message after the last
    // assistant means re-prompted work whose answer has not arrived —
    // the older assistant is partial progress, never this observation's
    // final result.
    let targetIndex = segment.length - 1;
    while (targetIndex >= 0 && isStructuralTail(segment[targetIndex])) {
      targetIndex -= 1;
    }
    const target = segment[targetIndex];
    if (!target) {
      // Empty (or purely structural) post-baseline segment in an idle
      // session: no assistant output exists for this run.
      return { verdict: 'absent' };
    }
    if (messageRole(target) === 'user') {
      // The run's prompt is the newest message and the session is idle:
      // no answer will ever arrive — provably no result. (Partial
      // progress cases are caught below: an assistant followed by a
      // newer user message.)
      const hasAssistant = segment.some((m) => messageRole(m) === 'assistant');
      if (hasAssistant) {
        // assistant → newer user: partial progress + pending re-prompt —
        // delivering the older answer as final would be wrong.
        return {
          verdict: 'retry',
          reason: 'user message after last assistant',
        };
      }
      return { verdict: 'absent' };
    }
    return verdictFromEvidence(
      classifyAssistantTurnEvidence(
        all,
        baselineIndex + 1 + targetIndex,
        baselineIndex,
      ),
    );
  }

  // No baseline: strict trailing-message semantics only.
  const trailing = all[all.length - 1];
  if (!trailing) return { verdict: 'absent' };
  const trailingRole = messageRole(trailing);
  if (trailingRole === 'user') {
    // Idle session whose newest message is the prompt itself: no answer
    // exists to attribute.
    return { verdict: 'absent' };
  }
  if (trailingRole !== 'assistant') {
    return {
      verdict: 'retry',
      reason: 'no baseline; cannot attribute a historical assistant turn',
    };
  }
  const completedAt = trailing.info?.time?.completed;
  if (
    options.runStartedAt !== undefined &&
    typeof completedAt === 'number' &&
    completedAt < options.runStartedAt
  ) {
    // Pre-run answer: provably not this execution's output.
    return { verdict: 'absent' };
  }
  return verdictFromEvidence(
    classifyAssistantTurnEvidence(all, all.length - 1, -1),
  );
}

export interface StopEvidenceGate {
  confirm(options: {
    taskID: string;
    generation: number;
    observedAt: number;
    idleObservedAt: number;
    lastStatusError: string;
    taskContextTracker: StopConfirmationTracker;
    /** Invoked (for EVERY joined caller) when the verdict is a bounded
     * retry — callers re-arm their own confirmation timers with their
     * own immutable idle anchor. */
    onRetry?: () => void;
  }): Promise<BackgroundJobRecord | undefined>;
  dispose(): void;
}

interface EvidenceEpisode {
  generation: number;
  /** stopConfirmationStartedAt anchor identifying this quiescence
   * episode; a busy recovery clears it and the next idle opens a new
   * one, resetting the retry budget. */
  episode: number | undefined;
  count: number;
}

/**
 * Shared post-grace stop confirmation backed by transcript evidence.
 * Coalesces concurrent confirmations per task AND generation (timer +
 * periodic poll share one in-flight read and every joined `onRetry`
 * fires), bounds each read with a deadline, revalidates state, busy,
 * generation and observation identity after every await, and keeps the
 * #1157 termination guarantee exclusively on the `absent` path (valid
 * read, provably no result). Unknown evidence never terminates into
 * `stopped`; after the episode budget it stays `running` +
 * `statusUncertain` with an explicit diagnostic.
 */
export function createStopEvidenceGate(options: {
  backgroundJobBoard: BackgroundJobStore;
  readTerminalEvidence: (taskID: string) => Promise<unknown>;
  /** Baseline anchoring for tracker-registered runs (revive/fallback):
   * results from before the baseline belong to a substituted attempt. */
  baselineFor?: (taskID: string, generation: number) => string | undefined;
  /** Observation-identity fence: two distinct observations can share
   * the same baseline (especially undefined), so the tracker also
   * exposes a monotonic revision per tracked run; a revision change
   * during the read invalidates the snapshot. */
  observationRevisionFor?: (
    taskID: string,
    generation: number,
  ) => number | undefined;
  /** Fallback handoff deferral: while a fallback's admission await is
   * pending, terminal publication is deferred — the job may already
   * hold the re-prompted result but no delivery owner exists yet. */
  isObservationPending?: (taskID: string, generation: number) => boolean;
  maxEvidenceRetries?: number;
  readTimeoutMs?: number;
}): StopEvidenceGate {
  const maxRetries = options.maxEvidenceRetries ?? DEFAULT_MAX_EVIDENCE_RETRIES;
  const readTimeoutMs =
    options.readTimeoutMs ?? DEFAULT_EVIDENCE_READ_TIMEOUT_MS;
  const episodes = new Map<string, EvidenceEpisode>();
  const inFlight = new Map<
    string,
    {
      promise: Promise<BackgroundJobRecord | undefined>;
      retryCallbacks: Array<(() => void) | undefined>;
    }
  >();
  let disposed = false;

  // Single-open read policy: at most ONE underlying evidence read per
  // taskID is tracked at any moment, and the entry records the
  // OBSERVATION IDENTITY it was opened for (generation + revision +
  // baseline + quiescence episode at open time). Rules:
  // - A consumer with the SAME identity joins the open operation
  //   instead of piling up new SDK calls.
  // - A consumer with a DIFFERENT identity (the observation was
  //   substituted while the old read is still open) never reuses the
  //   stale snapshot: it settles as uncertainty immediately, and no new
  //   operation may open while the non-cancelable old one is pending —
  //   the explicit single-open limit. The entry is released ONLY when
  //   its underlying operation settles; age never drops it.
  const openReads = new Map<
    string,
    { identity: string; underlying: Promise<unknown> }
  >();

  const settle = (
    taskID: string,
    generation: number,
    fn: () => BackgroundJobRecord | undefined,
  ): BackgroundJobRecord | undefined => {
    const tracked = episodes.get(taskID);
    if (tracked?.generation === generation) episodes.delete(taskID);
    return fn();
  };

  async function confirmInternal(input: {
    taskID: string;
    generation: number;
    observedAt: number;
    idleObservedAt: number;
    lastStatusError: string;
    taskContextTracker: StopConfirmationTracker;
    onRetry?: () => void;
  }): Promise<BackgroundJobRecord | undefined> {
    const pre = options.backgroundJobBoard.get(input.taskID);
    if (pre?.state !== 'running' || pre.generation !== input.generation) {
      return pre;
    }

    // Fallback handoff deferral: no terminal publication while the
    // admission await is pending (the result may already exist but its
    // delivery owner does not). Deferral consumes NO retry budget.
    const deferForHandoff = (): BackgroundJobRecord | undefined => {
      input.onRetry?.();
      return options.backgroundJobBoard.markStatusUncertain(
        input.taskID,
        input.lastStatusError,
        input.generation,
        input.observedAt,
      );
    };
    if (options.isObservationPending?.(input.taskID, input.generation)) {
      return deferForHandoff();
    }

    const baseline = options.baselineFor?.(input.taskID, input.generation);
    const revisionBefore = options.observationRevisionFor?.(
      input.taskID,
      input.generation,
    );
    // Quiescence episode: a busy recovery can start a NEW confirmation
    // with the SAME generation, revision and baseline — those three
    // alone do not identify the observation a read was opened for.
    const episodeAnchor = pre.stopConfirmationStartedAt;
    // Open-time identity: the snapshot a read produces is only evidence
    // for the observation it was opened for. A consumer joins an open
    // read ONLY on identical identity.
    const identity = `${input.generation}:${revisionBefore ?? 'none'}:${baseline ?? 'none'}:${episodeAnchor ?? 'none'}`;
    let response: unknown;
    const existing = openReads.get(input.taskID);
    if (existing && existing.identity !== identity) {
      // The open read belongs to a SUBSTITUTED observation (or a prior
      // quiescence episode): its late snapshot can never be this
      // consumer's evidence. No new operation may open while the
      // non-cancelable one is pending (explicit single-open limit) →
      // settle as uncertainty via the unknown-evidence path below
      // (never a terminal, never a stop).
      response = undefined;
    } else {
      let read: Promise<unknown>;
      if (existing) {
        read = existing.underlying;
      } else {
        const underlying = Promise.resolve(
          options.readTerminalEvidence(input.taskID),
        );
        openReads.set(input.taskID, { identity, underlying });
        const release = () => {
          const entry = openReads.get(input.taskID);
          if (entry?.underlying === underlying) openReads.delete(input.taskID);
        };
        underlying.then(release, release);
        read = underlying;
      }
      try {
        response = await raceEvidenceDeadline(read, readTimeoutMs);
      } catch {
        response = undefined;
      }
    }

    // Revalidate after the await: disposed, generation, state, the
    // original idle anchor (a busy recovery wins and leaves the job
    // running), the observation identity (baseline, revision AND the
    // quiescence episode — a fallback that replaced the observation or
    // a busy recovery that opened a new episode during the read must
    // not classify this snapshot), and a handoff armed while we read.
    if (disposed) return undefined;
    const job = options.backgroundJobBoard.get(input.taskID);
    if (job?.state !== 'running' || job.generation !== input.generation) {
      return job;
    }
    if (
      job.lastLiveBusyAt !== undefined &&
      job.lastLiveBusyAt > input.idleObservedAt
    ) {
      return job;
    }
    if (options.isObservationPending?.(input.taskID, input.generation)) {
      return deferForHandoff();
    }
    const baselineAfter = options.baselineFor?.(input.taskID, input.generation);
    const revisionAfter = options.observationRevisionFor?.(
      input.taskID,
      input.generation,
    );
    const verdict =
      baseline !== baselineAfter ||
      revisionBefore !== revisionAfter ||
      job.stopConfirmationStartedAt !== episodeAnchor
        ? {
            verdict: 'retry' as const,
            reason: 'observation identity changed',
          }
        : classifyTerminalEvidence(response, {
            baselineMessageID: baseline,
            runStartedAt: job.runStartedAt,
          });
    if (verdict.verdict === 'completed' || verdict.verdict === 'error') {
      return settle(input.taskID, input.generation, () =>
        options.backgroundJobBoard.updateStatus({
          taskID: input.taskID,
          expectedGeneration: input.generation,
          state: verdict.verdict === 'completed' ? 'completed' : 'error',
          resultSummary: verdict.text,
        }),
      );
    }
    if (verdict.verdict === 'absent') {
      return settle(input.taskID, input.generation, () =>
        applyConfirmedStop({
          backgroundJobBoard: options.backgroundJobBoard,
          taskID: input.taskID,
          observedAt: input.observedAt,
          generation: input.generation,
          taskContextTracker: input.taskContextTracker,
        }),
      );
    }

    // Unknown evidence: bounded per-episode retries; NEVER terminates
    // into the absence-asserting stop. After the budget, stay running +
    // uncertain with an explicit observation-unavailable diagnostic.
    const currentEpisode = job.stopConfirmationStartedAt;
    const tracked = episodes.get(input.taskID);
    const isNewEpisode =
      !tracked ||
      tracked.generation !== input.generation ||
      tracked.episode !== currentEpisode;
    const count = isNewEpisode ? 1 : tracked.count + 1;
    episodes.set(input.taskID, {
      generation: input.generation,
      episode: currentEpisode,
      count,
    });
    input.onRetry?.();
    return options.backgroundJobBoard.markStatusUncertain(
      input.taskID,
      count > maxRetries
        ? EVIDENCE_UNAVAILABLE_DIAGNOSTIC
        : input.lastStatusError,
      input.generation,
      input.observedAt,
    );
  }

  return {
    confirm: (input) => {
      if (disposed) return Promise.resolve(undefined);
      // Join key includes the quiescence episode: callers from
      // DIFFERENT episodes must not share a decision, even with
      // identical generation/revision/baseline.
      const key = `${input.taskID}:${input.generation}:${input.idleObservedAt}`;
      const existing = inFlight.get(key);
      if (existing) {
        // Join the in-flight observation; every joined caller's retry
        // arming must fire, not just the first.
        existing.retryCallbacks.push(input.onRetry);
        return existing.promise;
      }
      const entry = {
        promise: undefined as unknown as Promise<
          BackgroundJobRecord | undefined
        >,
        retryCallbacks: [input.onRetry],
      };
      entry.promise = confirmInternal({
        ...input,
        onRetry: () => {
          for (const cb of entry.retryCallbacks) cb?.();
        },
      }).finally(() => {
        if (inFlight.get(key) === entry) inFlight.delete(key);
      });
      inFlight.set(key, entry);
      return entry.promise;
    },
    dispose: () => {
      disposed = true;
      episodes.clear();
      inFlight.clear();
    },
  };
}
