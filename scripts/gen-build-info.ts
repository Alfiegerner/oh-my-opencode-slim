#!/usr/bin/env bun

/**
 * Generates src/generated/build-info.ts: the plugin version (from
 * package.json) and the short commit hash (`git rev-parse --short HEAD`),
 * so the startup log identifies the exact build that produced it.
 *
 * Runs as the first step of `bun run build`. The committed copy is a
 * fallback for checkouts that never run a build; a real build overwrites
 * it whenever the version or commit differs (read-compare-write, so
 * repeated builds without a new commit never touch the file). When git is
 * unavailable the commit is recorded as `unknown` instead of failing the
 * build.
 *
 * ALL console output goes to STDERR. CI packs the artifact with
 * `npm pack --json --ignore-scripts`; the runner npm still executes the
 * `prepare` script (the build) there, and a `[gen-build-info] …` line on
 * STDOUT would shift the first `[` that
 * scripts/verify-release-artifact.ts `parsePackJson` slices from,
 * breaking its JSON parse with `Unexpected identifier "gen"`.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function renderBuildInfoSource(
  version: string,
  commit: string,
): string {
  return `/**
 * Build identity — generated at build time by scripts/gen-build-info.ts
 * (first step of \`bun run build\`); do not edit by hand.
 *
 * Logging-only — never enters prompt payloads or transforms.
 */

export const BUILD_VERSION = '${version}';
export const BUILD_COMMIT = '${commit}';

/** Plugin build identity for diagnostics logs. */
export function getBuildInfo(): { version: string; commit: string } {
  return { version: BUILD_VERSION, commit: BUILD_COMMIT };
}
`;
}

/** Best-effort short HEAD hash; `unknown` when git is unavailable. */
export function resolveBuildCommit(rootDir: string): string {
  try {
    const raw = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    return /^[0-9a-f]{4,40}$/.test(raw) ? raw : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function generateBuildInfo(options: {
  rootDir: string;
}): { wrote: boolean; version: string; commit: string } {
  const pkg = JSON.parse(
    readFileSync(join(options.rootDir, 'package.json'), 'utf8'),
  ) as {
    version?: unknown;
  };

  if (typeof pkg.version !== 'string' || pkg.version === '') {
    throw new Error('package.json has no usable "version" field');
  }

  if (/['\\]/.test(pkg.version)) {
    throw new Error('package.json "version" contains a quote or backslash');
  }

  const commit = resolveBuildCommit(options.rootDir);
  const contents = renderBuildInfoSource(pkg.version, commit);
  const outputPath = join(options.rootDir, 'src', 'generated', 'build-info.ts');

  let previous: string | undefined;
  try {
    previous = readFileSync(outputPath, 'utf8');
  } catch {
    previous = undefined; // Absent (fresh checkout): write it.
  }

  if (previous === contents) {
    console.error(
      `[gen-build-info] ${outputPath} already current (version ${pkg.version}, commit ${commit}); not rewritten`,
    );
    return { wrote: false, version: pkg.version, commit };
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, contents);
  console.error(
    `[gen-build-info] wrote ${outputPath} (version ${pkg.version}, commit ${commit})`,
  );
  return { wrote: true, version: pkg.version, commit };
}

if (import.meta.main) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  generateBuildInfo({ rootDir: join(__dirname, '..') });
}
