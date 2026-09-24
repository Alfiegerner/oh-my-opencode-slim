import { describe, expect, test } from 'bun:test';
import { SessionLifecycle } from './session-lifecycle';

const noop = () => {};

describe('SessionLifecycle', () => {
  test('dispatchSessionDeleted runs callbacks in order', () => {
    const lc = new SessionLifecycle(noop);
    const ran: string[] = [];
    lc.onSessionDeleted((id) => ran.push(`a:${id}`));
    lc.onSessionDeleted((id) => ran.push(`b:${id}`));
    lc.dispatchSessionDeleted('s1');
    expect(ran).toEqual(['a:s1', 'b:s1']);
  });

  test('dispatchSessionDeleted continues after callback error', () => {
    const lc = new SessionLifecycle(() => {});
    const ran: string[] = [];
    lc.onSessionDeleted(() => {
      throw new Error('fail');
    });
    lc.onSessionDeleted((id) => ran.push(id));
    lc.dispatchSessionDeleted('s1');
    expect(ran).toEqual(['s1']);
  });
});
