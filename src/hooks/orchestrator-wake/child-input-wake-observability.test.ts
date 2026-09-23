import { describe, expect, mock, test } from 'bun:test';

const logMock = mock(() => {});
mock.module('../../utils/logger', () => ({ log: logMock }));

import { createOrchestratorWakeScheduler } from './index';
import { resetOrchestratorWakeGateForTests } from './wake-gate';

function makeScheduler(
  options?: Partial<Parameters<typeof createOrchestratorWakeScheduler>[1]>,
) {
  const promptAsync = mock(async () => ({}));
  const session = {
    get: mock(async () => ({ data: {} })),
    todo: mock(async () => ({ data: [] })),
    children: mock(async () => ({ data: [] })),
    status: mock(async () => ({ data: {} })),
    promptAsync,
  };
  const scheduler = createOrchestratorWakeScheduler(
    { directory: '/test', client: { session }, hostFlavor: 'v1' } as never,
    {
      config: { enabled: true, intervalMs: 60_000, mode: 'todo' },
      shouldManageSession: () => true,
      hasInputWait: () => false,
      isChildInputWaitCurrent: () => true,
      ...options,
    },
  );
  return { scheduler, promptAsync };
}

async function flush(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe('child-input wake observability logs (logging-only)', () => {
  test('vetoed child-input wake logs the veto reason (input-wait)', async () => {
    resetOrchestratorWakeGateForTests();
    logMock.mockClear();
    const { scheduler, promptAsync } = makeScheduler({
      hasInputWait: () => true,
    });
    scheduler.triggerChildInputWaitWake('parent-1', 'delta', 'task:que_1');
    await flush();

    expect(promptAsync).not.toHaveBeenCalled();
    const deferred = logMock.mock.calls.filter(
      ([msg]) => msg === '[orchestrator-wake] child-input wake deferred',
    );
    expect(deferred.length).toBe(1);
    expect(deferred[0]?.[1]).toMatchObject({ sessionID: 'parent-1', veto: 'input-wait' });
  });

  test('ask event logs the suppress verdict (observed session)', async () => {
    resetOrchestratorWakeGateForTests();
    logMock.mockClear();
    const { scheduler } = makeScheduler();
    await scheduler.event({
      event: { type: 'question.asked', properties: { sessionID: 'parent-1' } },
    } as never);
    await flush();

    const asks = logMock.mock.calls.filter(
      ([msg]) => msg === '[orchestrator-wake] ask observed',
    );
    expect(asks.length).toBe(1);
    expect(asks[0]?.[1]).toMatchObject({
      sessionID: 'parent-1',
      type: 'question.asked',
      suppressed: true,
    });
  });

  test('ask event on an unmanaged session logs suppressed=false and never question text', async () => {
    resetOrchestratorWakeGateForTests();
    logMock.mockClear();
    const { scheduler } = makeScheduler({ shouldManageSession: () => false });
    await scheduler.event({
      event: { type: 'question.asked', properties: { sessionID: 'other-1' } },
    } as never);
    await flush();

    const asks = logMock.mock.calls.filter(
      ([msg]) => msg === '[orchestrator-wake] ask observed',
    );
    expect(asks.length).toBe(1);
    expect(asks[0]?.[1]).toMatchObject({ sessionID: 'other-1', suppressed: false });
  });
});
