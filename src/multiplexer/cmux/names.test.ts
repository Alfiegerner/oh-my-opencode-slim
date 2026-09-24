import { describe, expect, test } from 'bun:test';
import {
  CHILD_TOKEN_LENGTH,
  childName,
  displayName,
  parentName,
  shortToken,
} from './names';

describe('parentName', () => {
  test('uses the parent tab name when present', () => {
    expect(parentName('my-tab', 770446)).toBe('my-tab');
  });

  test('falls back to Agent<selfPid> for a missing or empty name', () => {
    expect(parentName(null, 770446)).toBe('Agent770446');
    expect(parentName(undefined, 770446)).toBe('Agent770446');
    expect(parentName('', 770446)).toBe('Agent770446');
  });

  test('strips control characters so the name stays one readable line', () => {
    const name = parentName('a\nb\x1b[31mc\x07', 1);
    expect(name).toBe('ab[31mc');
    for (const char of name) {
      const code = char.codePointAt(0) ?? 0;
      expect(code < 0x20 || (code >= 0x7f && code <= 0x9f)).toBe(false);
    }
  });

  test('does not bound the parent name length (user-provided)', () => {
    const long = 'p'.repeat(300);
    expect(parentName(long, 1)).toBe(long);
  });
});

describe('childName', () => {
  test('is <subagentType>:<last five session id characters>', () => {
    expect(childName('oracle', 'ses_f41e46f05ffeoEESP7f24NJ9GdEx6')).toBe(
      'oracle:GdEx6',
    );
    expect(childName('explorer', 'ses_abcdek77lJ')).toBe('explorer:k77lJ');
  });

  test('falls back to the fixed subagent type when missing or empty', () => {
    expect(childName(undefined, 'ses_abc12GdEx6')).toBe('subagent:GdEx6');
    expect(childName(null, 'ses_abc12GdEx6')).toBe('subagent:GdEx6');
    expect(childName('', 'ses_abc12GdEx6')).toBe('subagent:GdEx6');
  });

  test('takes the available part of a session id shorter than five chars', () => {
    expect(childName('oracle', 'ab')).toBe('oracle:ab');
    expect(childName('oracle', '')).toBe('oracle:');
    expect(shortToken('abc')).toBe('abc');
  });

  test('bounds only the token: suffix is at most five characters', () => {
    const id = 'ses_0123456789abcdefghijklmnopqrstuvwxyz';
    const token = shortToken(id);
    expect(token).toHaveLength(CHILD_TOKEN_LENGTH);
    expect(childName('oracle', id).endsWith(`:${token}`)).toBe(true);
  });

  test('strips control characters from the type', () => {
    expect(childName('ora\ncle\x1b', 'ses_x')).toBe('oracle:ses_x');
  });
});

describe('displayName', () => {
  test('joins parent and child with /', () => {
    expect(displayName('Agent770446', 'oracle:GdEx6')).toBe(
      'Agent770446/oracle:GdEx6',
    );
    expect(displayName('my-tab', 'explorer:k77lJ')).toBe(
      'my-tab/explorer:k77lJ',
    );
  });

  test('never carries FR-8 sweep metadata', () => {
    const name = displayName(
      parentName('my-tab', 1),
      childName('oracle', 'ses_abc12GdEx6'),
    );
    expect(name).not.toContain('omosc:');
  });
});
