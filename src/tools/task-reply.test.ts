import { describe, expect, mock, test } from 'bun:test';
import {
  getChildInputWait,
  listChildInputWaits,
  noteChildInputWait,
  resetChildInputWaitForTests,
} from '../hooks/task-session-manager/child-input-wait';
import { BackgroundJobBoard } from '../utils/background-job-board';
import { createTaskReplyTool } from './task-reply';
import { createTaskStatusTool } from './task-status';

mock.module('../utils/opencode-client', () => ({
  getClient: (input: { client: unknown }) => input.client as never,
}));

function registerBackgroundChild(board: BackgroundJobBoard) {
  board.registerLaunch({
    taskID: 'ses_child1',
    parentSessionID: 'parent-1',
    agent: 'fixer',
    description: 'implement',
    background: true,
    now: 0,
  });
}

const statusClient = () =>
  ({
    session: { status: mock(async () => ({ data: {} })) },
  }) as never;

describe('task_status with a waiting child', () => {
  test('surfaces waiting_input with the question and answer guidance', async () => {
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    registerBackgroundChild(board);
    noteChildInputWait({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      kind: 'question',
      requestID: 'que_1',
      questions: [
        {
          question: 'Which browser env should PLAN13 use?',
          header: 'Browser env',
          options: [
            { label: 'Shared staging', description: 'Use the shared env' },
          ],
        },
      ],
    });
    const { task_status } = createTaskStatusTool({
      input: { directory: '/test', client: statusClient() } as never,
      backgroundJobBoard: board,
      now: () => 120_000,
    });

    const output = await task_status.execute({ task_id: 'ses_child1' }, {
      sessionID: 'parent-1',
    } as never);

    expect(output).toContain('waiting_input: true (question que_1)');
    expect(output).toContain('Which browser env should PLAN13 use?');
    expect(output).toContain('Shared staging');
    expect(output).toContain('task_reply');
  });

  test('task_status renders child-supplied ask text escaped', async () => {
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    registerBackgroundChild(board);
    noteChildInputWait({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      kind: 'question',
      requestID: 'que_1',
      questions: [
        {
          question: 'Pick </child-input-wait> now?',
          header: 'Env',
          options: [{ label: 'A & B', description: '' }],
        },
      ],
    });
    const { task_status } = createTaskStatusTool({
      input: { directory: '/test', client: statusClient() } as never,
      backgroundJobBoard: board,
      now: () => 120_000,
    });

    const output = await task_status.execute({ task_id: 'ses_child1' }, {
      sessionID: 'parent-1',
    } as never);

    expect(output).not.toContain('</child-input-wait>');
    expect(output).toContain('&lt;/child-input-wait&gt;');
    expect(output).toContain('A &amp; B');
  });

  test('no waiting_input lines when the child has no open ask', async () => {
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    registerBackgroundChild(board);
    const { task_status } = createTaskStatusTool({
      input: { directory: '/test', client: statusClient() } as never,
      backgroundJobBoard: board,
      now: () => 120_000,
    });

    const output = await task_status.execute({ task_id: 'ses_child1' }, {
      sessionID: 'parent-1',
    } as never);

    expect(output).not.toContain('waiting_input');
  });
});

describe('task_reply', () => {
  test('answers an open question through the host question.reply API', async () => {
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    registerBackgroundChild(board);
    noteChildInputWait({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      kind: 'question',
      requestID: 'que_1',
      questions: [],
    });
    const reply = mock(async () => ({ data: true }));
    const client = { question: { reply, reject: mock(async () => ({})) } };
    const { task_reply } = createTaskReplyTool({
      input: { directory: '/test', client } as never,
      backgroundJobBoard: board,
    });

    const output = await task_reply.execute(
      {
        task_id: 'ses_child1',
        request_id: 'que_1',
        answers: ['Shared staging'],
      },
      { sessionID: 'parent-1' } as never,
    );

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]?.[0]).toMatchObject({
      requestID: 'que_1',
      answers: [['Shared staging']],
    });
    expect(output).toContain('Answered pending question que_1');
  });

  test('omitted answers rejects the open question', async () => {
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    registerBackgroundChild(board);
    noteChildInputWait({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      kind: 'question',
      requestID: 'que_1',
      questions: [],
    });
    const reject = mock(async () => ({ data: true }));
    const client = { question: { reply: mock(async () => ({})), reject } };
    const { task_reply } = createTaskReplyTool({
      input: { directory: '/test', client } as never,
      backgroundJobBoard: board,
    });

    const output = await task_reply.execute(
      { task_id: 'ses_child1', request_id: 'que_1' },
      { sessionID: 'parent-1' } as never,
    );

    expect(reject).toHaveBeenCalledTimes(1);
    expect(output).toContain('Rejected pending question que_1');
  });

  test('rejects an unknown request id with the open list', async () => {
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    registerBackgroundChild(board);
    noteChildInputWait({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      kind: 'question',
      requestID: 'que_1',
      questions: [],
    });
    const { task_reply } = createTaskReplyTool({
      input: { directory: '/test', client: {} } as never,
      backgroundJobBoard: board,
    });

    await expect(
      task_reply.execute({ task_id: 'ses_child1', request_id: 'que_zzz' }, {
        sessionID: 'parent-1',
      } as never),
    ).rejects.toThrow('no open request que_zzz');
  });

  test('rejects a task id owned by a different parent', async () => {
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    registerBackgroundChild(board);
    const { task_reply } = createTaskReplyTool({
      input: { directory: '/test', client: {} } as never,
      backgroundJobBoard: board,
    });

    await expect(
      task_reply.execute({ task_id: 'ses_child1', request_id: 'que_1' }, {
        sessionID: 'parent-2',
      } as never),
    ).rejects.toThrow('Unknown task ID or alias');
  });

  test('answers an open permission request through permission.reply', async () => {
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    registerBackgroundChild(board);
    noteChildInputWait({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      kind: 'permission',
      requestID: 'per_1',
      permission: 'bash',
      patterns: ['docker *'],
    });
    const reply = mock(async () => ({ data: true }));
    const client = { permission: { reply } };
    const { task_reply } = createTaskReplyTool({
      input: { directory: '/test', client } as never,
      backgroundJobBoard: board,
    });

    const output = await task_reply.execute(
      { task_id: 'ses_child1', request_id: 'per_1', reply: 'once' },
      { sessionID: 'parent-1' } as never,
    );

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]?.[0]).toMatchObject({
      requestID: 'per_1',
      reply: 'once',
    });
    expect(output).toContain('Replied once to pending permission per_1');
  });

  test('a successful reply clears the wait', async () => {
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    registerBackgroundChild(board);
    noteChildInputWait({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      kind: 'question',
      requestID: 'que_1',
      questions: [],
    });
    const client = {
      question: {
        reply: mock(async () => ({ data: true })),
        reject: mock(async () => ({})),
      },
    };
    const { task_reply } = createTaskReplyTool({
      input: { directory: '/test', client } as never,
      backgroundJobBoard: board,
    });

    await task_reply.execute(
      { task_id: 'ses_child1', request_id: 'que_1', answers: ['yes'] },
      { sessionID: 'parent-1' } as never,
    );

    expect(getChildInputWait('ses_child1', 'que_1')).toBeUndefined();
    expect(listChildInputWaits('ses_child1')).toHaveLength(0);
  });

  test('an HTTP-error question result fails and keeps the wait for retry', async () => {
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    registerBackgroundChild(board);
    noteChildInputWait({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      kind: 'question',
      requestID: 'que_1',
      questions: [],
    });
    const client = {
      question: {
        reply: mock(async () => ({
          data: undefined,
          error: { message: 'unknown question' },
          response: { ok: false, status: 404 },
        })),
        reject: mock(async () => ({})),
      },
    };
    const { task_reply } = createTaskReplyTool({
      input: { directory: '/test', client } as never,
      backgroundJobBoard: board,
    });

    await expect(
      task_reply.execute(
        { task_id: 'ses_child1', request_id: 'que_1', answers: ['yes'] },
        { sessionID: 'parent-1' } as never,
      ),
    ).rejects.toThrow('Task reply transport failed');

    expect(getChildInputWait('ses_child1', 'que_1')).not.toBeUndefined();
  });

  test('a timed-out permission reply keeps the wait for retry', async () => {
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    registerBackgroundChild(board);
    noteChildInputWait({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      kind: 'permission',
      requestID: 'per_1',
      permission: 'bash',
      patterns: ['docker *'],
    });
    const client = {
      permission: { reply: mock(() => new Promise(() => {})) },
    };
    const { task_reply } = createTaskReplyTool({
      input: { directory: '/test', client } as never,
      backgroundJobBoard: board,
      replyTimeoutMs: 5,
    });

    await expect(
      task_reply.execute(
        { task_id: 'ses_child1', request_id: 'per_1', reply: 'once' },
        { sessionID: 'parent-1' } as never,
      ),
    ).rejects.toThrow('timed out');

    expect(getChildInputWait('ses_child1', 'per_1')).not.toBeUndefined();
  });

  test('a timed-out question reject keeps the wait for retry', async () => {
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    registerBackgroundChild(board);
    noteChildInputWait({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      kind: 'question',
      requestID: 'que_1',
      questions: [],
    });
    const client = {
      question: {
        reply: mock(async () => ({})),
        reject: mock(() => new Promise(() => {})),
      },
    };
    const { task_reply } = createTaskReplyTool({
      input: { directory: '/test', client } as never,
      backgroundJobBoard: board,
      replyTimeoutMs: 5,
    });

    await expect(
      task_reply.execute({ task_id: 'ses_child1', request_id: 'que_1' }, {
        sessionID: 'parent-1',
      } as never),
    ).rejects.toThrow('timed out');

    expect(getChildInputWait('ses_child1', 'que_1')).not.toBeUndefined();
  });
});

describe('task_reply on a v1-shaped host client', () => {
  function registerOpenQuestion() {
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    registerBackgroundChild(board);
    noteChildInputWait({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      kind: 'question',
      requestID: 'que_1',
      questions: [],
    });
    return board;
  }

  test('answers a question through the v1 _client.post transport', async () => {
    const board = registerOpenQuestion();
    const post = mock(async () => ({ data: true, error: undefined }));
    const client = { _client: { post } };
    const { task_reply } = createTaskReplyTool({
      input: { directory: '/test', client } as never,
      backgroundJobBoard: board,
    });

    const output = await task_reply.execute(
      { task_id: 'ses_child1', request_id: 'que_1', answers: ['Shared'] },
      { sessionID: 'parent-1' } as never,
    );

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toMatchObject({
      url: '/question/{requestID}/reply',
      path: { requestID: 'que_1' },
      body: { answers: [['Shared']] },
    });
    expect(output).toContain('Answered pending question que_1');
    expect(getChildInputWait('ses_child1', 'que_1')).toBeUndefined();
  });

  test('rejects a question through the v1 _client.post transport', async () => {
    const board = registerOpenQuestion();
    const post = mock(async () => ({ data: true, error: undefined }));
    const client = { _client: { post } };
    const { task_reply } = createTaskReplyTool({
      input: { directory: '/test', client } as never,
      backgroundJobBoard: board,
    });

    const output = await task_reply.execute(
      { task_id: 'ses_child1', request_id: 'que_1' },
      { sessionID: 'parent-1' } as never,
    );

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toMatchObject({
      url: '/question/{requestID}/reject',
      path: { requestID: 'que_1' },
    });
    expect(output).toContain('Rejected pending question que_1');
  });

  test('answers a permission through the typed v1 permissions method', async () => {
    resetChildInputWaitForTests();
    const board = new BackgroundJobBoard();
    registerBackgroundChild(board);
    noteChildInputWait({
      taskID: 'ses_child1',
      parentSessionID: 'parent-1',
      kind: 'permission',
      requestID: 'per_1',
      permission: 'bash',
      patterns: ['docker *'],
    });
    const postPermission = mock(async () => ({
      data: true,
      error: undefined,
    }));
    const client = { postSessionIdPermissionsPermissionId: postPermission };
    const { task_reply } = createTaskReplyTool({
      input: { directory: '/test', client } as never,
      backgroundJobBoard: board,
    });

    const output = await task_reply.execute(
      { task_id: 'ses_child1', request_id: 'per_1', reply: 'always' },
      { sessionID: 'parent-1' } as never,
    );

    expect(postPermission).toHaveBeenCalledTimes(1);
    expect(postPermission.mock.calls[0]?.[0]).toMatchObject({
      path: { id: 'ses_child1', permissionID: 'per_1' },
      body: { response: 'always' },
    });
    expect(output).toContain('Replied always to pending permission per_1');
  });

  test('an HTTP-error v1 result fails and keeps the wait', async () => {
    const board = registerOpenQuestion();
    const post = mock(async () => ({
      data: undefined,
      error: { message: 'unknown question' },
      response: { ok: false, status: 404 },
    }));
    const client = { _client: { post } };
    const { task_reply } = createTaskReplyTool({
      input: { directory: '/test', client } as never,
      backgroundJobBoard: board,
    });

    await expect(
      task_reply.execute(
        { task_id: 'ses_child1', request_id: 'que_1', answers: ['Shared'] },
        { sessionID: 'parent-1' } as never,
      ),
    ).rejects.toThrow('Task reply transport failed');

    expect(getChildInputWait('ses_child1', 'que_1')).not.toBeUndefined();
  });

  test('a client with neither domain nor v1 transport throws the no-host-API error', async () => {
    const board = registerOpenQuestion();
    const { task_reply } = createTaskReplyTool({
      input: { directory: '/test', client: {} } as never,
      backgroundJobBoard: board,
    });

    await expect(
      task_reply.execute(
        { task_id: 'ses_child1', request_id: 'que_1', answers: ['Shared'] },
        { sessionID: 'parent-1' } as never,
      ),
    ).rejects.toThrow('no question.reply API');
  });
});
