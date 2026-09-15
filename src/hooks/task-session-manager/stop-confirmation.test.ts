import { describe, expect, mock, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils';
import {
  classifyTerminalEvidence,
  createStopEvidenceGate,
  EVIDENCE_UNAVAILABLE_DIAGNOSTIC,
  raceEvidenceDeadline,
  STOPPED_WITHOUT_TERMINAL_RESULT,
} from './stop-confirmation';

function tracker() {
  return {
    pendingManagedTaskIds: new Set(['child-1']),
    contextFilesForPrompt: mock(() => []),
    prune: mock(() => {}),
  };
}

function launch(board: BackgroundJobBoard) {
  return board.registerLaunch({
    taskID: 'child-1',
    parentSessionID: 'parent-1',
    agent: 'fixer',
    description: 'gate',
    now: 0,
  });
}

const assistantDone = {
  data: [
    { info: { id: 'm1', role: 'user' }, parts: [] },
    {
      info: {
        id: 'm2',
        role: 'assistant',
        finish: 'stop',
        time: { completed: 1 },
      },
      parts: [{ type: 'text', text: 'Fallback final answer.' }],
    },
  ],
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('classifyTerminalEvidence', () => {
  test('malformed entries are retry, not a provably-empty transcript', () => {
    expect(classifyTerminalEvidence({ data: [{}] })).toEqual({
      verdict: 'retry',
      reason: 'malformed transcript entries',
    });
    expect(classifyTerminalEvidence({ data: [null] })).toEqual({
      verdict: 'retry',
      reason: 'malformed transcript entries',
    });
  });

  test('an assistant turn followed by a newer user message is pending work', () => {
    expect(
      classifyTerminalEvidence(
        {
          data: [
            { info: { id: 'm0', role: 'user' }, parts: [] },
            {
              info: {
                id: 'm1',
                role: 'assistant',
                finish: 'stop',
                time: { completed: 1 },
              },
              parts: [{ type: 'text', text: 'Older answer.' }],
            },
            {
              info: { id: 'm2', role: 'user' },
              parts: [{ type: 'text', text: 'new instruction' }],
            },
          ],
        },
        { baselineMessageID: 'm0' },
      ),
    ).toEqual({
      verdict: 'retry',
      reason: 'user message after last assistant',
    });
  });

  test('a valid empty post-baseline segment is absent', () => {
    expect(
      classifyTerminalEvidence(
        {
          data: [
            {
              info: {
                id: 'm0',
                role: 'assistant',
                finish: 'stop',
                time: { completed: 1 },
              },
              parts: [{ type: 'text', text: 'stale' }],
            },
            { info: { id: 'm1', role: 'user' }, parts: [] },
          ],
        },
        { baselineMessageID: 'm1' },
      ),
    ).toEqual({ verdict: 'absent' });
  });

  test('a pending tool call in the segment blocks attribution (extractor contract)', () => {
    // The exact fixture of child-transcript.test.ts: baseline, an
    // assistant with a RUNNING tool, then a completed assistant with
    // text. The strict tracker probe answers pending; the gate must
    // agree instead of publishing the trailing answer.
    expect(
      classifyTerminalEvidence(
        {
          data: [
            { info: { id: 'base', role: 'user' }, parts: [] },
            {
              info: {
                id: 'tool',
                role: 'assistant',
                time: { completed: 4 },
              },
              parts: [{ type: 'tool', state: { status: 'running' } }],
            },
            {
              info: {
                id: 'last',
                role: 'assistant',
                finish: 'stop',
                time: { completed: 5 },
              },
              parts: [{ type: 'text', text: 'the answer' }],
            },
          ],
        },
        { baselineMessageID: 'base' },
      ),
    ).toEqual({ verdict: 'retry', reason: 'pending' });
  });

  test('invalid entries mixed with valid ones make the whole read malformed', () => {
    // Dropping the null entry would "repair" the transcript into
    // attributing the previous assistant as trailing.
    expect(
      classifyTerminalEvidence({
        data: [
          {
            info: {
              id: 'last',
              role: 'assistant',
              finish: 'stop',
              time: { completed: 5 },
            },
            parts: [{ type: 'text', text: 'answer' }],
          },
          null,
        ],
      }),
    ).toEqual({ verdict: 'retry', reason: 'malformed transcript entries' });
  });

  test('terminal error precedence over residual finish flags', () => {
    // An error turn with leftover finish state settles as error rather
    // than parking forever in retry.
    expect(
      classifyTerminalEvidence({
        data: [
          {
            info: {
              id: 'last',
              role: 'assistant',
              finish: 'tool-calls',
              time: { completed: 5 },
              error: 'model exploded',
            },
            parts: [],
          },
        ],
      }),
    ).toEqual({ verdict: 'error', text: 'model exploded' });
  });
});

describe('raceEvidenceDeadline', () => {
  test('timeoutMs <= 0 disables the deadline', async () => {
    const value = await raceEvidenceDeadline(
      new Promise((resolve) => setTimeout(() => resolve('ok'), 15)),
      0,
    );
    expect(value).toBe('ok');
  });
});

describe('createStopEvidenceGate', () => {
  /** Standard single-child gate fixture. The default read is a manually
   * resolved deferred (counted); every scenario action — busy recovery,
   * episode re-arm, identity mutation, dispose — stays explicit in the
   * test body. */
  function gateHarness(options?: {
    maxEvidenceRetries?: number;
    readTimeoutMs?: number;
    readTerminalEvidence?: (taskID: string) => Promise<unknown>;
    baselineFor?: (taskID: string, generation: number) => string | undefined;
    observationRevisionFor?: (
      taskID: string,
      generation: number,
    ) => number | undefined;
    isObservationPending?: (taskID: string, generation: number) => boolean;
  }) {
    const board = new BackgroundJobBoard();
    const run = launch(board);
    board.noteStopConfirmation('child-1', 1, run.generation);
    let reads = 0;
    let resolveRead: ((value: unknown) => void) | undefined;
    const gate = createStopEvidenceGate({
      backgroundJobBoard: board,
      maxEvidenceRetries: options?.maxEvidenceRetries,
      readTimeoutMs: options?.readTimeoutMs,
      readTerminalEvidence:
        options?.readTerminalEvidence ??
        (() => {
          reads += 1;
          return new Promise((resolve) => {
            resolveRead = resolve;
          });
        }),
      baselineFor: options?.baselineFor,
      observationRevisionFor: options?.observationRevisionFor,
      isObservationPending: options?.isObservationPending,
    });
    const confirm = (
      overrides: {
        idleObservedAt?: number;
        observedAt?: number;
        onRetry?: () => void;
      } = {},
    ) =>
      gate.confirm({
        taskID: 'child-1',
        generation: run.generation,
        observedAt: overrides.observedAt ?? 10,
        idleObservedAt: overrides.idleObservedAt ?? 1,
        lastStatusError: 'idle',
        taskContextTracker: tracker(),
        onRetry: overrides.onRetry,
      });
    return {
      board,
      run,
      gate,
      confirm,
      readCount: () => reads,
      resolveRead: (value: unknown) => resolveRead?.(value),
    };
  }

  test('unknown-evidence retries stay running; a later valid read settles', async () => {
    let reads = 0;
    const h = gateHarness({
      maxEvidenceRetries: 2,
      baselineFor: () => 'm1',
      readTerminalEvidence: async () => {
        reads += 1;
        return reads >= 5 ? assistantDone : undefined;
      },
    });

    for (let i = 0; i < 4; i += 1) {
      await h.confirm();
      expect(h.board.get('child-1')?.state).toBe('running');
    }
    expect(h.board.get('child-1')?.lastStatusError).toBe(
      EVIDENCE_UNAVAILABLE_DIAGNOSTIC,
    );

    const settled = await h.confirm();
    expect(settled).toMatchObject({
      state: 'completed',
      resultSummary: 'Fallback final answer.',
    });
    expect(h.board.get('child-1')?.state).not.toBe('stopped');
  });

  test('busy recovery opens a new episode and resets the retry budget', async () => {
    let reads = 0;
    const h = gateHarness({
      maxEvidenceRetries: 1,
      readTerminalEvidence: async () => {
        reads += 1;
        return undefined;
      },
    });

    await h.confirm();
    await h.confirm();
    expect(h.board.get('child-1')?.lastStatusError).toBe(
      EVIDENCE_UNAVAILABLE_DIAGNOSTIC,
    );

    h.board.markRunningFromLiveSession('child-1', 20, h.run.generation);
    h.board.noteStopConfirmation('child-1', 21, h.run.generation);
    await h.confirm({ idleObservedAt: 20, observedAt: 29 });
    expect(h.board.get('child-1')).toMatchObject({
      state: 'running',
      lastStatusError: 'idle',
    });
    expect(reads).toBe(3);
  });

  test('a hung read is bounded by the deadline and does not block other jobs', async () => {
    const board = new BackgroundJobBoard();
    const hung = board.registerLaunch({
      taskID: 'child-1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'hung',
      now: 0,
    });
    board.noteStopConfirmation('child-1', 1, hung.generation);
    const other = board.registerLaunch({
      taskID: 'child-2',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'other',
      now: 0,
    });
    board.noteStopConfirmation('child-2', 1, other.generation);

    const gate = createStopEvidenceGate({
      backgroundJobBoard: board,
      readTimeoutMs: 20,
      readTerminalEvidence: async (taskID) => {
        if (taskID === 'child-1') return new Promise(() => {});
        return assistantDone;
      },
      baselineFor: (taskID) => (taskID === 'child-2' ? 'm1' : undefined),
    });
    const context = tracker();

    const hungConfirm = gate.confirm({
      taskID: 'child-1',
      generation: hung.generation,
      observedAt: 10,
      idleObservedAt: 1,
      lastStatusError: 'idle',
      taskContextTracker: context,
    });
    const otherConfirm = gate.confirm({
      taskID: 'child-2',
      generation: other.generation,
      observedAt: 10,
      idleObservedAt: 1,
      lastStatusError: 'idle',
      taskContextTracker: context,
    });

    const otherSettled = await Promise.race([
      otherConfirm,
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 200)),
    ]);
    expect(otherSettled).toMatchObject({
      state: 'completed',
      resultSummary: 'Fallback final answer.',
    });

    await hungConfirm;
    expect(board.get('child-1')).toMatchObject({ state: 'running' });
  });

  test('joined callers all receive onRetry from ONE shared open read', async () => {
    const h = gateHarness();
    const retries: string[] = [];

    const first = h.confirm({ onRetry: () => retries.push('a') });
    // Joins the in-flight observation AFTER the read started, while it
    // is still deferred — joining must be observable, not two
    // independent confirmations.
    await tick();
    const second = h.confirm({ onRetry: () => retries.push('b') });
    await tick();
    expect(h.readCount()).toBe(1);

    h.resolveRead(undefined); // unknown evidence → retry verdict
    await Promise.all([first, second]);

    expect(retries).toContain('a');
    expect(retries).toContain('b');
    expect(h.readCount()).toBe(1);
    expect(h.board.get('child-1')).toMatchObject({ state: 'running' });
  });

  // Identity substitution while an open read is pending: each row keeps
  // generation and baseline identical and changes ONE identity
  // component. The stale open read must never become the new
  // observation's evidence, and the single-open limit holds.
  const substitutions: Array<{
    label: string;
    idle: number;
    mutate: (
      h: ReturnType<typeof gateHarness>,
      ctx: { revision: number },
    ) => void;
  }> = [
    {
      label:
        'busy recovery re-arms the episode with same gen/revision/baseline',
      idle: 32,
      mutate: (h) => {
        h.board.markRunningFromLiveSession('child-1', 30);
        h.board.noteStopConfirmation('child-1', 31, h.run.generation);
      },
    },
    {
      label: 're-registration substitutes the observation revision',
      idle: 1,
      mutate: (_h, ctx) => {
        ctx.revision = 2;
      },
    },
  ];
  for (const { label, idle, mutate } of substitutions) {
    test(`a stale open read is never evidence: ${label}`, async () => {
      const ctx = { revision: 1 };
      const h = gateHarness({
        readTimeoutMs: 20,
        baselineFor: () => 'm1',
        observationRevisionFor: () => ctx.revision,
      });

      // The first consumer is released on its deadline; the operation
      // stays open under the original identity.
      await h.confirm();
      expect(h.readCount()).toBe(1);

      mutate(h, ctx);

      // No join (identity differs) and no new operation (single-open).
      const next = await h.confirm({
        idleObservedAt: idle,
        observedAt: idle + 1,
      });
      expect(next).toMatchObject({ state: 'running' });
      expect(h.readCount()).toBe(1);

      // The stale snapshot finally resolves with a terminal — it can
      // never be the substituted observation's evidence.
      h.resolveRead(assistantDone);
      await settle();
      expect(h.board.get('child-1')).toMatchObject({ state: 'running' });
      expect(h.board.get('child-1')?.resultSummary).toBeUndefined();
    });
  }

  test('dispose ignores a late read', async () => {
    const h = gateHarness();
    const pending = h.confirm();

    h.gate.dispose();
    h.resolveRead(assistantDone);
    await pending;
    expect(h.board.get('child-1')?.state).toBe('running');
    expect(h.board.get('child-1')?.resultSummary).toBeUndefined();
  });

  test('a pending handoff defers terminal publication without consuming budget', async () => {
    let pendingHandoff = true;
    const h = gateHarness({
      readTerminalEvidence: async () => assistantDone,
      baselineFor: () => 'm1',
      isObservationPending: () => pendingHandoff,
    });

    // Handoff armed before the admission resolved: the already-persisted
    // result must NOT be published (no delivery owner yet).
    await h.confirm();
    expect(h.board.get('child-1')).toMatchObject({ state: 'running' });
    expect(h.board.get('child-1')?.resultSummary).toBeUndefined();

    // Admission rejected/expired: the gate proceeds and settles.
    pendingHandoff = false;
    const settled = await h.confirm();
    expect(settled).toMatchObject({
      state: 'completed',
      resultSummary: 'Fallback final answer.',
    });
  });

  test('a handoff armed during the read also defers classification', async () => {
    let pendingHandoff = false;
    const h = gateHarness({
      baselineFor: () => 'm1',
      isObservationPending: () => pendingHandoff,
    });
    const pending = h.confirm();

    // The fallback prepares its handoff while the read is in flight.
    pendingHandoff = true;
    h.resolveRead(assistantDone);
    await pending;
    expect(h.board.get('child-1')).toMatchObject({ state: 'running' });
    expect(h.board.get('child-1')?.resultSummary).toBeUndefined();
  });

  test('a hung read is rejoined, not piled up: one underlying read across deadlines', async () => {
    const h = gateHarness({ readTimeoutMs: 20 });

    // Two deadline-expired attempts while the transport hangs: both
    // consumers were released, but only ONE SDK operation was opened.
    await h.confirm();
    await tick();
    await h.confirm();
    expect(h.readCount()).toBe(1);
    expect(h.board.get('child-1')).toMatchObject({ state: 'running' });

    // The hung transport finally settles: the (still single) read's
    // late value must not retroactively terminalize a consumer that
    // already timed out — identity revalidation discards it.
    h.resolveRead(assistantDone);
    await settle();
    expect(h.board.get('child-1')).toMatchObject({ state: 'running' });
  });

  test('a baseline change during the read invalidates the snapshot', async () => {
    let baseline = 'm1';
    const h = gateHarness({ baselineFor: () => baseline });
    const pending = h.confirm();

    baseline = 'm9';
    h.resolveRead(assistantDone);
    await pending;
    expect(h.board.get('child-1')?.state).toBe('running');
    expect(h.board.get('child-1')?.resultSummary).not.toBe(
      'Fallback final answer.',
    );
  });

  test('valid absence after grace still stops (#1157)', async () => {
    const h = gateHarness({
      readTerminalEvidence: async () => ({
        data: [{ info: { id: 'm1', role: 'user' }, parts: [] }],
      }),
      baselineFor: () => 'm1',
    });
    const stopped = await h.confirm();
    expect(stopped).toMatchObject({
      state: 'stopped',
      resultSummary: STOPPED_WITHOUT_TERMINAL_RESULT,
    });
  });
});
