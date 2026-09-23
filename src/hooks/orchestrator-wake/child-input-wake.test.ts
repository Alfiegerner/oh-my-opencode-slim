import { describe, expect, mock, test } from 'bun:test';
import {
  CHILD_INPUT_QUEUE_CAP,
  CHILD_INPUT_WAKE_CHUNK,
  createOrchestratorWakeScheduler,
  formatChildInputWaitDelta,
} from './index';
import { resetOrchestratorWakeGateForTests } from './wake-gate';

type SessionClient = {
  get?: ReturnType<typeof mock>;
  todo?: ReturnType<typeof mock>;
  children?: ReturnType<typeof mock>;
  status?: ReturnType<typeof mock>;
  list?: ReturnType<typeof mock>;
  promptAsync?: ReturnType<typeof mock>;
};

function makeCtx(session: SessionClient, directory = '/test') {
  return {
    directory,
    client: { session },
    hostFlavor: 'v1',
  } as never;
}

function v1Session(promptAsync?: ReturnType<typeof mock>): SessionClient {
  return {
    get: mock(async () => ({ data: {} })),
    todo: mock(async () => ({ data: [] })),
    children: mock(async () => ({ data: [] })),
    status: mock(async () => ({ data: {} })),
    promptAsync:
      promptAsync ?? mock(async () => ({ data: { info: { id: 'm' } } })),
  };
}

function makeScheduler(
  session: SessionClient,
  options?: {
    shouldManageSession?: (id: string) => boolean;
    isChildInputWaitCurrent?: (taskID: string, requestID: string) => boolean;
  },
) {
  return createOrchestratorWakeScheduler(makeCtx(session), {
    config: { enabled: true, intervalMs: 60_000, mode: 'todo' },
    shouldManageSession: options?.shouldManageSession ?? (() => true),
    hasInputWait: () => false,
    hasPendingDelegatedWork: () => true,
    isChildInputWaitCurrent: options?.isChildInputWaitCurrent ?? (() => true),
  });
}

async function flush(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

const delta = (taskID = 'ses_child1', requestID = 'que_1') =>
  formatChildInputWaitDelta({
    alias: 'fix-1',
    taskID,
    kind: 'question',
    requestID,
    detail: 'request: que_1\nkind: question\nquestion: Which env?',
  });

describe('child input-wait wake', () => {
  test('triggerChildInputWaitWake delivers a queued promptAsync wake with the ask inline', async () => {
    resetOrchestratorWakeGateForTests();
    const promptAsync = mock(async () => ({}));
    const session = v1Session(promptAsync);
    const scheduler = makeScheduler(session);

    scheduler.triggerChildInputWaitWake(
      'parent-1',
      delta(),
      'ses_child1:que_1',
    );
    await flush();

    expect(promptAsync).toHaveBeenCalledTimes(1);
    const call = promptAsync.mock.calls[0]?.[0] as {
      body: { parts: Array<{ text: string }> };
    };
    const text = call.body.parts[0]?.text ?? '';
    expect(text).toContain('ses_child1');
    expect(text).toContain('que_1');
    expect(text).toContain('Which env?');
    expect(text).toContain('task_reply');
  });

  test('duplicate asks do not double-wake', async () => {
    resetOrchestratorWakeGateForTests();
    const promptAsync = mock(async () => ({}));
    const session = v1Session(promptAsync);
    const scheduler = makeScheduler(session);

    scheduler.triggerChildInputWaitWake(
      'parent-1',
      delta(),
      'ses_child1:que_1',
    );
    scheduler.triggerChildInputWaitWake(
      'parent-1',
      delta(),
      'ses_child1:que_1',
    );
    await flush();

    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('a resolved ask is pruned and does not wake', async () => {
    resetOrchestratorWakeGateForTests();
    const promptAsync = mock(async () => ({}));
    const session = v1Session(promptAsync);
    let current = true;
    const scheduler = makeScheduler(session, {
      isChildInputWaitCurrent: () => current,
    });

    current = false;
    scheduler.triggerChildInputWaitWake(
      'parent-1',
      delta(),
      'ses_child1:que_1',
    );
    await flush();

    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('queue is bounded and each wake sends a chunk', async () => {
    expect(CHILD_INPUT_QUEUE_CAP).toBe(32);
    expect(CHILD_INPUT_WAKE_CHUNK).toBe(4);
  });
});
