/**
 * Build identity — generated at build time by scripts/gen-build-info.ts
 * (first step of `bun run build`); do not edit by hand.
 *
 * Logging-only — never enters prompt payloads or transforms.
 */

export const BUILD_VERSION = '2.2.22';
export const BUILD_COMMIT = 'acc124e1';

/** Plugin build identity for diagnostics logs. */
export function getBuildInfo(): { version: string; commit: string } {
  return { version: BUILD_VERSION, commit: BUILD_COMMIT };
}
