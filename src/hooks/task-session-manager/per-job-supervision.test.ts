import { describe, expect, mock, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import { BackgroundJobSupervisor } from '../../utils/background-job-supervisor';
import {
  handleToolExecuteAfter,
  handleToolExecuteBefore,
  PER_JOB_ABORT_GRACE_MAX_MS,
  PER_JOB_ABORT_GRACE_MIN_MS,
  PER_JOB_WALL_CLOCK_TIMEOUT_MAX_MS,
  PER_JOB_WALL_CLOCK_TIMEOUT_MIN_MS,
  parsePerJobSupervision,
} from './tool-execute-hooks';

/**
 * Direct bounds matrix for parsePerJobSupervision. Every invalid shape
 * fails closed to disabled/collapsed ({} or timeout-only), never to an
 * armed supervision with a shortened or unbounded deadline.
 */
describe('parsePerJobSupervision bounds matrix', () => {
  test('0/undefined/absent disables (fail closed to {})', () => {
    expect(parsePerJobSupervision({})).toEqual({});
    expect(parsePerJobSupervision({ wallClockTimeoutMs: undefined })).toEqual(
      {},
    );
    expect(parsePerJobSupervision({ wallClockTimeoutMs: 0 })).toEqual({});
    // Grace alone, without a timeout, never arms anything.
    expect(parsePerJobSupervision({ abortGraceMs: 5_000 })).toEqual({});
  });

  test('timeout bounds: 59999/max+1 reject, 60000/max accept', () => {
    expect(
      parsePerJobSupervision({
        wallClockTimeoutMs: PER_JOB_WALL_CLOCK_TIMEOUT_MIN_MS - 1,
      }),
    ).toEqual({});
    expect(
      parsePerJobSupervision({
        wallClockTimeoutMs: PER_JOB_WALL_CLOCK_TIMEOUT_MIN_MS,
      }),
    ).toEqual({ wallClockTimeoutMs: PER_JOB_WALL_CLOCK_TIMEOUT_MIN_MS });
    expect(
      parsePerJobSupervision({
        wallClockTimeoutMs: PER_JOB_WALL_CLOCK_TIMEOUT_MAX_MS,
      }),
    ).toEqual({ wallClockTimeoutMs: PER_JOB_WALL_CLOCK_TIMEOUT_MAX_MS });
    expect(
      parsePerJobSupervision({
        wallClockTimeoutMs: PER_JOB_WALL_CLOCK_TIMEOUT_MAX_MS + 1,
      }),
    ).toEqual({});
  });

  test('non-integer, NaN, Infinity, and string timeouts fail closed', () => {
    for (const bad of [
      60_000.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      '60000',
      true,
      null,
      {},
      [],
      -1,
    ]) {
      expect(
        parsePerJobSupervision({ wallClockTimeoutMs: bad }),
        `timeout ${String(bad)} should fail closed`,
      ).toEqual({});
    }
  });

  test('bad grace with good timeout collapses to timeout-only (grace falls back to global)', () => {
    const timeoutOnly = {
      wallClockTimeoutMs: PER_JOB_WALL_CLOCK_TIMEOUT_MIN_MS,
    };
    for (const badGrace of [
      PER_JOB_ABORT_GRACE_MIN_MS - 1,
      PER_JOB_ABORT_GRACE_MAX_MS + 1,
      1_000.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '5000',
      true,
      null,
      -5,
      0,
    ]) {
      expect(
        parsePerJobSupervision({
          wallClockTimeoutMs: PER_JOB_WALL_CLOCK_TIMEOUT_MIN_MS,
          abortGraceMs: badGrace,
        }),
        `grace ${String(badGrace)} should collapse to timeout-only`,
      ).toEqual(timeoutOnly);
    }
  });

  test('supervisor clamp: out-of-range direct onLaunch values fail closed to global', async () => {
    function harness(globalTimeout: number) {
      const board = new BackgroundJobBoard();
      let now = 0;
      let nextID = 0;
      const timers = new Map<number, { at: number; cb: () => void }>();
      const abort = mock(async () => undefined);
      const supervisor = new BackgroundJobSupervisor({
        backgroundJobStore: board,
        wallClockTimeoutMs: globalTimeout,
        abortGraceMs: 20,
        abort: abort as unknown as (taskID: string) => Promise<unknown>,
        now: () => now,
        setTimeout: ((cb: () => void, delay: number) => {
          const id = ++nextID;
          timers.set(id, { at: now + delay, cb });
          return id;
        }) as unknown as typeof setTimeout,
        clearTimeout: ((id: unknown) => {
          timers.delete(id as number);
        }) as unknown as typeof clearTimeout,
      });
      return {
        board,
        supervisor,
        abort,
        timers,
        setNow: (v: number) => {
          now = v;
        },
      };
    }
    // Global disabled: a hostile direct caller passing 1ms must not arm.
    {
      const { board, supervisor, timers } = harness(0);
      const job = board.registerLaunch({
        taskID: 'clamp-1',
        parentSessionID: 'parent',
        agent: 'oracle',
        background: true,
        now: 0,
      });
      supervisor.onLaunch(job, { wallClockTimeoutMs: 1 });
      expect(timers.size).toBe(0);
    }
    // Global finite: an oversized direct value must not shorten/extend it —
    // the run still fires on the global deadline.
    {
      const { board, supervisor, abort, timers, setNow } = harness(100);
      const job = board.registerLaunch({
        taskID: 'clamp-2',
        parentSessionID: 'parent',
        agent: 'oracle',
        background: true,
        now: 0,
      });
      supervisor.onLaunch(job, {
        wallClockTimeoutMs: PER_JOB_WALL_CLOCK_TIMEOUT_MAX_MS + 1,
        abortGraceMs: 999_999,
      });
      expect(timers.size).toBe(1);
      setNow(100);
      for (const [, t] of [...timers]) {
        if (t.at <= 100) {
          timers.delete(1);
          t.cb();
        }
      }
      await Promise.resolve();
      expect(abort).toHaveBeenCalledTimes(1);
      expect(board.get('clamp-2')?.deadlineExceededAt).toBe(100);
    }
  });

  test('wiring: valid per-job args snapshot pending.supervision and forward as onLaunch second arg', async () => {
    const board = new BackgroundJobBoard();
    const seen: Array<{ record: unknown; perJob: unknown }> = [];
    const supervisor = {
      onLaunch: (record: unknown, perJob?: unknown) => {
        seen.push({ record, perJob });
      },
    };
    const pendingCalls = new Map<
      string,
      Parameters<
        typeof handleToolExecuteBefore
      >[2]['pendingCallTracker'] extends never
        ? never
        : import('./pending-call-tracker').PendingTaskCall
    >();
    const deps = {
      shouldManageSession: () => true,
      backgroundJobBoard: board,
      pendingCallTracker: {
        add: (call: import('./pending-call-tracker').PendingTaskCall) => {
          pendingCalls.set(call.callId, call);
        },
        pendingCallId: (_s?: string, c?: string) => c ?? 'anon',
      },
      taskContextTracker: { pendingManagedTaskIds: new Set<string>() },
      backgroundJobSupervisor: supervisor as never,
    };
    const afterDeps = {
      directory: '/tmp',
      backgroundJobBoard: board,
      pendingCallTracker: {
        take: (callID?: string) => pendingCalls.get(callID ?? ''),
      },
      taskContextTracker: {
        pendingManagedTaskIds: new Set<string>(),
        addContext: () => {},
        contextFilesForPrompt: () => [],
        prune: () => {},
      },
      backgroundJobSupervisor: supervisor as never,
    };
    const args = {
      subagent_type: 'oracle',
      background: true,
      description: 'long oracle run',
      prompt: 'investigate',
      wallClockTimeoutMs: 120_000,
      abortGraceMs: 5_000,
    };
    await handleToolExecuteBefore(
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      { args },
      deps,
    );
    const pending = pendingCalls.get('call-1');
    expect(pending?.supervision).toEqual({
      wallClockTimeoutMs: 120_000,
      abortGraceMs: 5_000,
    });
    await handleToolExecuteAfter(
      { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
      {
        output: [
          'task_id: ora-child-1',
          'state: running',
          '',
          '<task_result>',
          'Background task started.',
          '</task_result>',
        ].join('\n'),
      },
      afterDeps,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeDefined();
    expect((seen[0].record as { taskID?: string }).taskID).toBe('ora-child-1');
    expect(seen[0].perJob).toEqual({
      wallClockTimeoutMs: 120_000,
      abortGraceMs: 5_000,
    });
  });

  test('wiring: invalid/zero per-job args collapse to undefined and forward the global path', async () => {
    for (const badArgs of [
      { wallClockTimeoutMs: 1 },
      { wallClockTimeoutMs: '120000' },
      { wallClockTimeoutMs: 0, abortGraceMs: 5_000 },
      {},
    ]) {
      const board = new BackgroundJobBoard();
      const seen: Array<{ record: unknown; perJob: unknown }> = [];
      const supervisor = {
        onLaunch: (record: unknown, perJob?: unknown) => {
          seen.push({ record, perJob });
        },
      };
      const pendingCalls = new Map<
        string,
        import('./pending-call-tracker').PendingTaskCall
      >();
      const deps = {
        shouldManageSession: () => true,
        backgroundJobBoard: board,
        pendingCallTracker: {
          add: (call: import('./pending-call-tracker').PendingTaskCall) => {
            pendingCalls.set(call.callId, call);
          },
          pendingCallId: (_s?: string, c?: string) => c ?? 'anon',
        },
        taskContextTracker: { pendingManagedTaskIds: new Set<string>() },
        backgroundJobSupervisor: supervisor as never,
      };
      const afterDeps = {
        directory: '/tmp',
        backgroundJobBoard: board,
        pendingCallTracker: {
          take: (callID?: string) => pendingCalls.get(callID ?? ''),
        },
        taskContextTracker: {
          pendingManagedTaskIds: new Set<string>(),
          addContext: () => {},
          contextFilesForPrompt: () => [],
          prune: () => {},
        },
        backgroundJobSupervisor: supervisor as never,
      };
      await handleToolExecuteBefore(
        { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
        {
          args: {
            subagent_type: 'fixer',
            background: true,
            description: 'fix',
            prompt: 'fix it',
            ...badArgs,
          },
        },
        deps,
      );
      expect(
        pendingCalls.get('call-1')?.supervision,
        `args ${JSON.stringify(badArgs)} should collapse supervision`,
      ).toBeUndefined();
      await handleToolExecuteAfter(
        { tool: 'task', sessionID: 'parent-1', callID: 'call-1' },
        {
          output: [
            'task_id: fix-child-1',
            'state: running',
            '',
            '<task_result>',
            'Background task started.',
            '</task_result>',
          ].join('\n'),
        },
        afterDeps,
      );
      expect(seen).toHaveLength(1);
      expect(seen[0].perJob).toBeUndefined();
    }
  });

  test('valid timeout+grace pairs pass through exactly', () => {
    expect(
      parsePerJobSupervision({
        wallClockTimeoutMs: 120_000,
        abortGraceMs: 5_000,
      }),
    ).toEqual({ wallClockTimeoutMs: 120_000, abortGraceMs: 5_000 });
    expect(
      parsePerJobSupervision({
        wallClockTimeoutMs: PER_JOB_WALL_CLOCK_TIMEOUT_MAX_MS,
        abortGraceMs: PER_JOB_ABORT_GRACE_MAX_MS,
      }),
    ).toEqual({
      wallClockTimeoutMs: PER_JOB_WALL_CLOCK_TIMEOUT_MAX_MS,
      abortGraceMs: PER_JOB_ABORT_GRACE_MAX_MS,
    });
    // Grace bounds edges.
    expect(
      parsePerJobSupervision({
        wallClockTimeoutMs: 60_000,
        abortGraceMs: PER_JOB_ABORT_GRACE_MIN_MS,
      }),
    ).toEqual({
      wallClockTimeoutMs: 60_000,
      abortGraceMs: PER_JOB_ABORT_GRACE_MIN_MS,
    });
  });
});
