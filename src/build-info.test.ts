import { describe, expect, test } from 'bun:test';
import pkg from '../package.json';
import { getBuildInfo } from './generated/build-info';
import { resolveBuildCommit } from '../scripts/gen-build-info';

describe('build info', () => {
  test('version equals the package.json version', () => {
    expect(getBuildInfo().version).toBe(pkg.version);
  });

  test('commit falls back to unknown when git is unavailable', () => {
    expect(resolveBuildCommit('/nonexistent-dir-8f3a2c')).toBe('unknown');
  });
});
