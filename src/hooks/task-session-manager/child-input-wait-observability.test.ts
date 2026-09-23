import { describe, expect, mock, test } from 'bun:test';

const logMock = mock(() => {});
mock.module('../../utils/logger', () => ({ log: logMock }));
mock.module('../../utils/opencode-client', () => ({
  getClient: (input: { client: unknown }) => input.client as never,
}));

import { BackgroundJobBoard } from '../../utils/background-job-board';
import { resetChildInputWaitForTests } from './child-input-wait';
import { createTaskSessionManagerHook } from './index';
import { resetUserWaitGateForTests } from './user-wait-gate';

function createHook(board: BackgroundJobBoard) {
  return createTaskSessionManagerHook(
    {
      client: { session: { status: mock(async () => ({ data: {} })) } },
      directory: '/tmp',
      worktree: '/tmp',
    } as never,
    {
      maxSessionsPerAgent: 2,
      maxRetainedSnapshots: 20,
      backgroundJobBoard: board,
      shouldManageSession: (id: string) => id === 'parent-1',
      idleReconcileDelayMs: 0,
      runtimeStatusReconcileDelayMs: 0,
    },
  );
}

function runningBackgroundChild(board: BackgroundJobBoard) {
  board.registerLaunch({
    taskID: 'ses_child1',
    parentSessionID: 'parent-1',
    agent: 'fixer',
    description: 'implement',
    background: true,
  });
}

describe('child-input-wait observability logs (logging-only)', () => {
  test('ask arm logs kind/sessionID/requestID/managesSession/waits size, never question text', async () => {
    resetUserWaitGateForTests();
    resetChildInputWaitForTests();
    logMock.mockClear();
    const board = new BackgroundJobBoard();
    runningBackgroundChild(board);
    const hook = createHook(board);

    await hook.event({
      event: {
        type: 'question.asked',
        properties: {
          id: 'que_1',
          sessionID: 'ses_child1',
          questions: [
            {
              question: 'SECRET-QUESTION-TEXT-should-never-appear-in-logs',
              header: 'H',
              options: [{ label: 'a', description: 'b' }],
            },
          ],
        },
      },
    });

    const opened = logMock.mock.calls.filter(
      ([msg]) => msg === '[task-session-manager] background child input wait opened',
    );
    expect(opened.length).toBe(1);
    const payload = opened[0]?.[1] as Record<string, unknown>;
    expect(payload.taskID).toBe('ses_child1');
    expect(payload.parentSessionID).toBe('parent-1');
    expect(payload.kind).toBe('question');
    expect(payload.requestID).toBe('que_1');
    expect(typeof payload.waitsSize).toBe('number');
    const serialized = JSON.stringify(logMock.mock.calls);
    expect(serialized).not.toContain('SECRET-QUESTION-TEXT');
  });

  test('reply resolve logs taskID/requestID only', async () => {
    resetUserWaitGateForTests();
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    runningBackgroundChild(board);
    const hook = createHook(board);
    await hook.event({
      event: {
        type: 'question.asked',
        properties: { id: 'que_1', sessionID: 'ses_child1' },
      },
    });
    logMock.mockClear();

    await hook.event({
      event: {
        type: 'question.replied',
        properties: { sessionID: 'ses_child1', requestID: 'que_1' },
      },
    });

    const resolved = logMock.mock.calls.filter(
      ([msg]) => msg === '[task-session-manager] background child input wait resolved',
    );
    expect(resolved.length).toBe(1);
    expect(resolved[0]?.[1]).toMatchObject({ taskID: 'ses_child1', requestID: 'que_1' });
  });
});
