#!/usr/bin/env bun

/**
 * Generates src/generated/build-info.ts: the plugin version (from
 * package.json) and the build timestamp as two string constants, so
 * runtime logs can identify the exact build that produced them.
 *
 * Runs as the first step of `bun run build`. The committed file is an
 * offline placeholder that this script overwrites on every build.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const outputPath = join(rootDir, 'src', 'generated', 'build-info.ts');

const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')) as {
  version?: unknown;
};

if (typeof pkg.version !== 'string' || pkg.version === '') {
  throw new Error('package.json has no usable "version" field');
}

if (/['\\]/.test(pkg.version)) {
  throw new Error('package.json "version" contains a quote or backslash');
}

const buildTime = new Date().toISOString();

const contents = `/**
 * Build identity — generated at build time by scripts/gen-build-info.ts
 * (first step of \`bun run build\`); do not edit by hand.
 *
 * Logging-only — never enters prompt payloads or transforms.
 */

export const BUILD_VERSION = '${pkg.version}';
export const BUILD_TIME = '${buildTime}';

/** Plugin build identity for diagnostics logs. */
export function getBuildInfo(): { version: string; buildTime: string } {
  return { version: BUILD_VERSION, buildTime: BUILD_TIME };
}
`;

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, contents);

console.log(
  `[gen-build-info] wrote ${outputPath} (version ${pkg.version}, built ${buildTime})`,
);
