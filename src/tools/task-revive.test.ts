import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import { createOpencodeClient } from '@opencode-ai/sdk';
import { createRevivedRunTracker } from '../hooks/task-session-manager/revived-run-tracker';
import { BackgroundJobBoard } from '../utils/background-job-fixture';
import {
  type BackgroundJobTerminalGate,
  createBackgroundJobTerminalGate,
} from '../utils/background-job-terminal-gate';
import * as opencodeClient from '../utils/opencode-client';
import { createCancelTaskTool } from './cancel-task';
import { createTaskReviveTool } from './task-revive';

const gates: BackgroundJobTerminalGate[] = [];

function createTool(overrides?: {
  abort?: () => Promise<unknown>;
  status?: () => Promise<unknown>;
  /** v2 hosts expose no session.status map at all (see client-shim.ts). */
  omitStatus?: boolean;
  promptAsync?: () => Promise<unknown>;
  messages?: () => Promise<unknown>;
  revivedRunTracker?: {
    captureBaseline: () => Promise<string | undefined>;
    register: (input: unknown) => void;
    isTracked: (taskID: string, generation: number) => boolean;
    probe: (taskID: string, generation: number) => Promise<boolean>;
    onTerminal: (record: unknown) => void;
    dispose: () => void;
  };
}) {
  const board = new BackgroundJobBoard();
  const abort = mock(overrides?.abort ?? (async () => ({})));
  const status = mock(
    overrides?.status ?? (async () => ({ data: { ses_1: { type: 'idle' } } })),
  );
  const promptAsync = mock(overrides?.promptAsync ?? (async () => ({})));
  const input = {
    directory: '/test/project',
    client: {
      session: {
        abort,
        status: overrides?.omitStatus ? undefined : status,
        promptAsync,
        messages: overrides?.messages,
      },
    },
  } as never;
  const terminalGate = createBackgroundJobTerminalGate({
    backgroundJobBoard: board,
    input,
  });
  gates.push(terminalGate);
  const revivedRunTracker =
    overrides?.revivedRunTracker ??
    createRevivedRunTracker({
      input,
      backgroundJobBoard: board,
      terminalGate,
    });
  const tools = createTaskReviveTool({
    input,
    backgroundJobBoard: board,
    shouldManageSession: () => true,
    verifyAbortMs: 10,
    abortRetryIntervalMs: 0,
    stableStoppedMs: 0,
    revivedRunTracker,
  });
  const cancelTools = createCancelTaskTool({
    input,
    backgroundJobBoard: board,
    terminalGate,
    shouldManageSession: () => true,
    verifyAbortMs: 10,
    abortRetryIntervalMs: 0,
    stableStoppedMs: 0,
  });
  return {
    board,
    abort,
    status,
    promptAsync,
    revivedRunTracker,
    taskCancel: cancelTools.task_cancel,
    taskRevive: tools.task_revive,
  };
}

const context = { sessionID: 'parent-1', agent: 'orchestrator' } as any;

beforeEach(() => {
  // Other suites can leave module mocks installed. Override only for this
  // test; mock.restore below restores the previous implementation afterward.
  spyOn(opencodeClient, 'getClient').mockImplementation(
    (input) => input.client,
  );
});

afterEach(() => {
  for (const gate of gates.splice(0)) gate.dispose();
  mock.restore();
});

function acknowledgedCompleted(board: BackgroundJobBoard, taskID = 'ses_1') {
  board.registerLaunch({
    taskID,
    parentSessionID: 'parent-1',
    agent: 'explorer',
  });
  board.updateStatus({ taskID, state: 'completed', resultSummary: 'done' });
  board.markReconciled(taskID);
}

function stoppedSession(
  board: BackgroundJobBoard,
  taskID = 'ses_1',
  acknowledge = false,
) {
  board.registerLaunch({
    taskID,
    parentSessionID: 'parent-1',
    agent: 'explorer',
    now: 100,
  });
  board.markStopped(taskID, 'no native result', 110, undefined, 110);
  if (acknowledge) board.markReconciled(taskID);
}

describe('task_revive tool', () => {
  test.each(['success', 'rejection', 'error envelope'])(
    'notification timeout permits a real revive; old %s leaves the new generation and lease intact',
    async (outcome) => {
      const timers = new Map<number, { delay: number; callback: () => void }>();
      let nextID = 0;
      spyOn(globalThis, 'setTimeout').mockImplementation(((
        callback: () => void,
        delay: number,
      ) => {
        const id = ++nextID;
        timers.set(id, { delay, callback });
        return id;
      }) as typeof setTimeout);
      spyOn(globalThis, 'clearTimeout').mockImplementation(((id: number) => {
        timers.delete(id);
      }) as typeof clearTimeout);
      const flush = async () => {
        for (let i = 0; i < 50; i++) await Promise.resolve();
      };
      let resolve!: (value: unknown) => void;
      let reject!: (error: unknown) => void;
      const pending = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const { board, promptAsync, taskRevive, revivedRunTracker } = createTool({
        messages: async () => ({
          data: [
            {
              info: {
                id: 'old-result',
                role: 'assistant',
                finish: 'stop',
                time: { completed: 1 },
              },
              parts: [{ type: 'text', text: 'done' }],
            },
          ],
        }),
      });
      promptAsync.mockImplementationOnce(() => pending);
      const run = board.registerLaunch({
        taskID: 'ses_1',
        parentSessionID: 'parent-1',
        agent: 'explorer',
        background: true,
      });
      revivedRunTracker.register(run);
      const terminal = board.updateStatus({
        taskID: run.taskID,
        state: 'completed',
        resultSummary: 'done',
      });
      if (!terminal) throw new Error('missing terminal record');
      revivedRunTracker.onTerminal(terminal);
      await flush();
      const args = {
        task_id: run.taskID,
        prompt: 'Continue the investigation',
      };
      await expect(taskRevive.execute(args, context)).rejects.toThrow(
        'relaunch lease unavailable',
      );
      expect(promptAsync).toHaveBeenCalledTimes(1);
      const timeout = [...timers.values()].find(
        (timer) => timer.delay === 10_000,
      );
      expect(timeout).toBeDefined();
      timeout?.callback();
      await flush();
      try {
        const output = await taskRevive.execute(args, context);
        expect(String(output)).toContain('status: started');
        expect(promptAsync).toHaveBeenCalledTimes(2);
        expect(promptAsync.mock.calls[1]?.[0]).toMatchObject({
          path: { id: run.taskID },
          delivery: 'queue',
        });
        const current = board.get(run.taskID);
        if (!current) throw new Error('missing revived record');
        expect(current).toMatchObject({
          generation: run.generation + 1,
          state: 'running',
        });
        const lease = board.acquireMessageLease(
          current.taskID,
          current.generation,
        );
        if (!lease) throw new Error('missing new-generation lease');
        if (outcome === 'success') resolve({});
        else if (outcome === 'rejection')
          reject(new Error('old transport failed'));
        else resolve({ error: 'old transport failed' });
        await flush();
        expect(board.get(run.taskID)).toEqual(current);
        expect(board.validateLease(lease)).toBe(true);
        expect(
          board.acquireRelaunchLease(current.taskID, current.generation),
        ).toBeUndefined();
        expect(board.releaseLease(lease)).toBe(true);
        expect(
          [...timers.values()].some((timer) => timer.delay === 1_000),
        ).toBe(false);
        expect(promptAsync).toHaveBeenCalledTimes(2);
      } finally {
        revivedRunTracker.dispose();
      }
    },
  );

  test('uses promptAsync, starts a new board generation, and retains the session', async () => {
    const { board, promptAsync, taskRevive } = createTool();
    acknowledgedCompleted(board);

    const output = await taskRevive.execute(
      { task_id: 'ses_1', prompt: 'Continue the investigation' },
      context,
    );

    expect(promptAsync).toHaveBeenCalledWith({
      path: { id: 'ses_1' },
      query: { directory: '/test/project' },
      body: {
        agent: 'explorer',
        parts: [{ type: 'text', text: 'Continue the investigation' }],
      },
      delivery: 'queue',
    });
    const call = promptAsync.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.body).not.toHaveProperty('noReply', true);
    expect(String(output)).toContain('state: running');
    expect(String(output)).toContain('status: started');
    expect(board.get('ses_1')).toMatchObject({
      generation: 2,
      state: 'running',
    });
    const lease = board.acquireRelaunchLease('ses_1', 2);
    expect(lease).toBeDefined();
    if (lease) board.releaseLease(lease);
  });

  test('reports a fast terminal completion observed by the immediate probe', async () => {
    let board: BackgroundJobBoard;
    const tracker = {
      captureBaseline: async () => undefined,
      register: () => {},
      isTracked: () => false,
      probe: async (_taskID: string, generation: number) => {
        board.updateStatus({
          taskID: 'ses_1',
          expectedGeneration: generation,
          state: 'completed',
          resultSummary: 'fast completion',
        });
        return true;
      },
      onTerminal: () => {},
      dispose: () => {},
    };
    const tools = createTool({ revivedRunTracker: tracker });
    board = tools.board;
    acknowledgedCompleted(board);

    const output = await tools.taskRevive.execute(
      { task_id: 'ses_1', prompt: 'finish quickly' },
      context,
    );

    expect(String(output)).toContain('state: completed');
    expect(String(output)).toContain('status: completed');
    expect(String(output)).toContain('fast completion');
    expect(String(output)).not.toContain('state: running');
    expect(tools.board.get('ses_1')).toMatchObject({
      generation: 2,
      state: 'completed',
    });
  });

  test('cancels a running generation and launches its replacement in order', async () => {
    const events: string[] = [];
    const { board, abort, promptAsync, taskRevive } = createTool({
      abort: async () => {
        events.push('abort');
        return {};
      },
      status: async () => ({ data: { ses_1: { type: 'idle' } } }),
      promptAsync: async () => {
        events.push('promptAsync');
        return {};
      },
    });
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });

    await taskRevive.execute(
      { task_id: 'ses_1', prompt: 'Resume with a new objective' },
      context,
    );

    expect(abort).toHaveBeenCalledTimes(1);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['abort', 'promptAsync']);
    expect(board.get('ses_1')).toMatchObject({
      generation: 2,
      state: 'running',
    });
  });

  test('revives a directly cancelled retained session before acknowledgement', async () => {
    const { board, promptAsync, taskCancel, taskRevive } = createTool();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });

    await taskCancel.execute({ task_id: 'ses_1', reason: 'obsolete' }, context);
    expect(board.get('ses_1')).toMatchObject({
      state: 'cancelled',
      terminalUnreconciled: true,
      statusUncertain: false,
    });

    const output = await taskRevive.execute(
      { task_id: 'ses_1', prompt: 'try again' },
      context,
    );

    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(String(output)).toContain('state: running');
    expect(board.get('ses_1')).toMatchObject({
      generation: 2,
      state: 'running',
    });
  });

  test('revives a stopped session before and after acknowledgement', async () => {
    for (const acknowledge of [false, true]) {
      const { board, promptAsync, taskRevive } = createTool();
      stoppedSession(board, 'ses_1', acknowledge);
      expect(board.get('ses_1')).toMatchObject({
        state: 'stopped',
        terminalUnreconciled: !acknowledge,
      });

      const output = await taskRevive.execute(
        { task_id: 'ses_1', prompt: 'continue from the retained session' },
        context,
      );

      expect(promptAsync).toHaveBeenCalledTimes(1);
      expect(String(output)).toContain('state: running');
      expect(board.get('ses_1')).toMatchObject({
        generation: 2,
        state: 'running',
      });
    }
  });

  test('revives a stopped session on a v2 host with no live session-status map', async () => {
    // Regression: v2 hosts omit session.status entirely (client-shim.ts).
    // getRuntimeSessionStatusSnapshot always errors without that method,
    // and task_revive used to treat any such error as unverifiable and
    // permanently refuse to revive on v2. The board's own event-driven
    // generation fencing is the only liveness signal v2 provides, so the
    // live-map check must be skipped, not turned into a hard failure.
    const { board, status, promptAsync, taskRevive } = createTool({
      omitStatus: true,
    });
    stoppedSession(board);

    const output = await taskRevive.execute(
      { task_id: 'ses_1', prompt: 'continue from the retained session' },
      context,
    );

    expect(status).not.toHaveBeenCalled();
    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(String(output)).toContain('state: running');
    expect(board.get('ses_1')).toMatchObject({
      generation: 2,
      state: 'running',
    });
  });

  test('refuses to relaunch when a late busy revives the generation during baseline capture', async () => {
    // P1 regression: captureBaseline awaits network I/O. If a live busy
    // observation arrives while the baseline is in flight, the revive
    // must NOT send promptAsync over the still-active generation, must
    // not bump the board generation, and must release the relaunch
    // lease. With the lease held, the busy observation keeps the record
    // stopped and only advances lastLiveBusyAt; the revive refuses on
    // that fresh-activity signal.
    let resolveBaseline: (id: string | undefined) => void = () => {};
    const baselineGate = new Promise<string | undefined>((resolve) => {
      resolveBaseline = resolve;
    });
    const deferredTracker = {
      captureBaseline: () => baselineGate,
      register: () => {},
      isTracked: () => false,
      probe: () => Promise.resolve(true),
      onTerminal: () => {},
      dispose: () => {},
    };
    const { board, promptAsync, taskRevive } = createTool({
      revivedRunTracker: deferredTracker as any,
    });
    stoppedSession(board);

    const pending = taskRevive.execute(
      { task_id: 'ses_1', prompt: 'continue' },
      context,
    );
    // Late busy observation lands while captureBaseline is in flight.
    board.markRunningFromLiveSession('ses_1', 115);
    resolveBaseline(undefined);

    await expect(pending).rejects.toThrow(/became active again/);
    expect(promptAsync).toHaveBeenCalledTimes(0);
    expect(board.get('ses_1')).toMatchObject({
      state: 'running',
      generation: 1,
      lastLiveBusyAt: 115,
    });
    // The relaunch lease was released: a new acquire on the same
    // generation succeeds.
    const reLease = board.acquireRelaunchLease('ses_1', 1);
    expect(reLease).toBeDefined();
    if (reLease) board.releaseLease(reLease);
  });

  test('refuses to relaunch when the host reports the session busy even if the board is stopped', async () => {
    // P1 regression (host fence): the board record stays stopped under
    // the relaunch lease, but the session may have resumed
    // independently at the host. On v2 hosts promptAsync degrades to
    // steering an in-flight run instead of rejecting it, so a live
    // busy/retry entry must refuse before the prompt is sent.
    const { board, promptAsync, status, taskRevive } = createTool({
      status: async () => ({ data: { ses_1: { type: 'busy' } } }),
    });
    stoppedSession(board);

    await expect(
      taskRevive.execute({ task_id: 'ses_1', prompt: 'continue' }, context),
    ).rejects.toThrow(/executing at the host/);

    expect(promptAsync).toHaveBeenCalledTimes(0);
    expect(status).toHaveBeenCalled();
    expect(board.get('ses_1')).toMatchObject({
      state: 'stopped',
      generation: 1,
    });
    const reLease = board.acquireRelaunchLease('ses_1', 1);
    expect(reLease).toBeDefined();
    if (reLease) board.releaseLease(reLease);
  });

  test('rejects an uncertain retained terminal job', async () => {
    const { board, promptAsync, taskRevive } = createTool();
    board.registerLaunch({
      taskID: 'ses_1',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });
    board.updateStatus({
      taskID: 'ses_1',
      state: 'error',
      statusUncertain: true,
    });

    await expect(
      taskRevive.execute({ task_id: 'ses_1', prompt: 'try again' }, context),
    ).rejects.toThrow('verified retained terminal session');
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('rejects foreign, parent, and stale task requests', async () => {
    const { board, promptAsync, taskRevive } = createTool();
    acknowledgedCompleted(board, 'ses_foreign');
    const foreignRecord = board.get('ses_foreign');
    if (!foreignRecord) throw new Error('missing foreign record');
    board.updateStatus({ taskID: 'ses_foreign', state: 'completed' });
    board.markReconciled('ses_foreign');
    board.registerLaunch({
      taskID: 'ses_stale',
      parentSessionID: 'parent-1',
      agent: 'explorer',
    });
    board.updateStatus({ taskID: 'ses_stale', state: 'completed' });
    board.markReconciled('ses_stale');

    await expect(
      taskRevive.execute({ task_id: 'ses_foreign', prompt: 'x' }, {
        sessionID: 'parent-2',
        agent: 'orchestrator',
      } as any),
    ).rejects.toThrow('Unknown or unowned');
    await expect(
      taskRevive.execute({ task_id: 'parent-1', prompt: 'x' }, context),
    ).rejects.toThrow('Unknown or unowned');

    const originalResolve = board.resolve.bind(board);
    let mutated = false;
    board.resolve = mock((parent, requested) => {
      const result = originalResolve(parent, requested);
      if (result && requested === 'ses_stale' && !mutated) {
        mutated = true;
        const lease = board.acquireRelaunchLease(
          'ses_stale',
          result.generation,
        );
        if (!lease) throw new Error('missing stale relaunch lease');
        board.registerLaunch({
          taskID: 'ses_stale',
          parentSessionID: 'parent-1',
          agent: 'explorer',
          relaunchLease: lease,
        });
      }
      return result;
    });
    await expect(
      taskRevive.execute({ task_id: 'ses_stale', prompt: 'x' }, context),
    ).rejects.toThrow('run generation changed');
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('releases the relaunch lease when promptAsync fails', async () => {
    const { board, promptAsync, taskRevive } = createTool({
      promptAsync: async () => {
        throw new Error('host unavailable');
      },
    });
    acknowledgedCompleted(board);

    await expect(
      taskRevive.execute({ task_id: 'ses_1', prompt: 'retry' }, context),
    ).rejects.toThrow('host unavailable');
    expect(promptAsync).toHaveBeenCalledTimes(1);
    const lease = board.acquireRelaunchLease('ses_1', 1);
    expect(lease).toBeDefined();
    if (lease) board.releaseLease(lease);
    expect(board.get('ses_1')).toMatchObject({
      generation: 1,
      state: 'reconciled',
      statusUncertain: false,
    });
  });

  test('v1 SDK serializes only the body: the delivery hint never reaches the wire', async () => {
    // v1 compatibility evidence for the queue-delivery fence: the hint
    // travels as a client-side argument, and the real @opencode-ai/sdk
    // request pipeline must serialize ONLY `body` into the HTTP request.
    // A captured fetch observes the wire shape directly.
    const captured = new Map<string, unknown>();
    const client = createOpencodeClient({
      baseUrl: 'http://127.0.0.1:1',
      fetch: async (request: Request) => {
        captured.set('url', request.url);
        captured.set('body', await request.text());
        return new Response('{}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    await client.session.promptAsync({
      path: { id: 'ses_1' },
      query: { directory: '/test/project' },
      body: { agent: 'explorer', parts: [{ type: 'text', text: 'go' }] },
      // Extra top-level argument, exactly as task-revive sends it.
      delivery: 'queue',
    } as Parameters<typeof client.session.promptAsync>[0] &
      Record<string, unknown>);

    expect(captured.get('url')).toContain('/session/ses_1/prompt_async');
    const wireBody = JSON.parse(String(captured.get('body')));
    expect(wireBody).toEqual({
      agent: 'explorer',
      parts: [{ type: 'text', text: 'go' }],
    });
  });
});
