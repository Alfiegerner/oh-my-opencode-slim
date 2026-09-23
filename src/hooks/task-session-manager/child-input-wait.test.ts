import { describe, expect, mock, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import { resetChildInputWaitForTests } from './child-input-wait';
import { createTaskSessionManagerHook } from './index';
import { resetUserWaitGateForTests } from './user-wait-gate';

// Route getClient back to _ctx.client so _ctx.client.session mocks work.
mock.module('../../utils/opencode-client', () => ({
  getClient: (input: { client: unknown }) => input.client as never,
}));

function createHook(options?: {
  backgroundJobBoard?: BackgroundJobBoard;
  shouldManageSession?: (sessionID: string) => boolean;
  onChildInputWait?: (notification: {
    parentSessionID: string;
    taskID: string;
    kind: 'question' | 'permission';
    requestID: string;
  }) => void;
}) {
  const hook = createTaskSessionManagerHook(
    {
      client: {
        session: {
          status: mock(async () => ({ data: {} })),
        },
      },
      directory: '/tmp',
      worktree: '/tmp',
    } as never,
    {
      maxSessionsPerAgent: 2,
      maxRetainedSnapshots: 20,
      backgroundJobBoard: options?.backgroundJobBoard,
      shouldManageSession:
        options?.shouldManageSession ??
        ((sessionID: string) => sessionID === 'parent-1'),
      idleReconcileDelayMs: 0,
      runtimeStatusReconcileDelayMs: 0,
      onChildInputWait: options?.onChildInputWait,
    },
  );
  return { hook };
}

function questionAskedEvent(childID: string, requestID: string) {
  return {
    event: {
      type: 'question.asked',
      properties: {
        id: requestID,
        sessionID: childID,
        questions: [
          {
            question: 'Which browser env should PLAN13 use?',
            header: 'Browser env',
            options: [
              { label: 'Shared staging', description: 'Use the shared env' },
              { label: 'Local docker', description: 'Spin up local' },
            ],
          },
        ],
      },
    },
  };
}

describe('background child input wait surfacing (RED)', () => {
  test('a background child question notifies the parent with the question content', async () => {
    resetUserWaitGateForTests();
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement',
      background: true,
    });
    const notified: unknown[] = [];
    const { hook } = createHook({
      backgroundJobBoard: board,
      onChildInputWait: (n) => notified.push(n),
    });

    await hook.event(questionAskedEvent('ses_child1', 'que_1'));

    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({
      parentSessionID: 'parent-1',
      taskID: 'ses_child1',
      kind: 'question',
      requestID: 'que_1',
    });
  });

  test('duplicate question.asked events do not double-notify', async () => {
    resetUserWaitGateForTests();
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement',
      background: true,
    });
    const notified: unknown[] = [];
    const { hook } = createHook({
      backgroundJobBoard: board,
      onChildInputWait: (n) => notified.push(n),
    });

    await hook.event(questionAskedEvent('ses_child1', 'que_1'));
    await hook.event(questionAskedEvent('ses_child1', 'que_1'));

    expect(notified).toHaveLength(1);
  });

  test('a replied question clears: a later ask notifies again', async () => {
    resetUserWaitGateForTests();
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'implement',
      background: true,
    });
    const notified: unknown[] = [];
    const { hook } = createHook({
      backgroundJobBoard: board,
      onChildInputWait: (n) => notified.push(n),
    });

    await hook.event(questionAskedEvent('ses_child1', 'que_1'));
    await hook.event({
      event: {
        type: 'question.replied',
        properties: { sessionID: 'ses_child1', requestID: 'que_1' },
      },
    });
    expect(hook.hasInputWait('ses_child1')).toBe(false);
    await hook.event(questionAskedEvent('ses_child1', 'que_2'));
    expect(notified).toHaveLength(2);
  });

  test('a foreground (non-background) child question does not notify', async () => {
    resetUserWaitGateForTests();
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_fg1',
      parentSessionID: 'parent-1',
      agent: 'fixer',
      description: 'foreground work',
      background: false,
    });
    const notified: unknown[] = [];
    const { hook } = createHook({
      backgroundJobBoard: board,
      onChildInputWait: (n) => notified.push(n),
    });

    await hook.event(questionAskedEvent('ses_fg1', 'que_1'));

    expect(notified).toHaveLength(0);
  });

  test('an unmanaged session question does not notify', async () => {
    resetUserWaitGateForTests();
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    const notified: unknown[] = [];
    const { hook } = createHook({
      backgroundJobBoard: board,
      onChildInputWait: (n) => notified.push(n),
    });

    await hook.event(questionAskedEvent('ses_unknown', 'que_1'));

    expect(notified).toHaveLength(0);
  });
});
