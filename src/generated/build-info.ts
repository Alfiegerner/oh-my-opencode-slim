/**
 * Build identity — generated at build time by scripts/gen-build-info.ts
 * (first step of `bun run build`); do not edit by hand.
 *
 * Logging-only — never enters prompt payloads or transforms.
 */

export const BUILD_VERSION = '2.2.24';
export const BUILD_TIME = '2026-09-22T20:18:10.288Z';

/** Plugin build identity for diagnostics logs. */
export function getBuildInfo(): { version: string; buildTime: string } {
  return { version: BUILD_VERSION, buildTime: BUILD_TIME };
}
