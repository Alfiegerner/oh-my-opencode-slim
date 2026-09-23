/**
 * Multiplexer abstraction layer
 *
 * Provides a unified interface for terminal multiplexers (tmux, zellij,
 * herdr, etc.) to spawn and manage panes for child agent sessions.
 */

import type { MultiplexerLayout } from '../config/schema';

export interface PaneResult {
  success: boolean;
  paneId?: string;
  orphanPaneId?: string;
  error?: 'unavailable' | 'not_found' | 'invalid_state' | 'hard';
}

export interface PaneSpawnOptions {
  /** Root/parent OpenCode session that requested this child pane. */
  parentSessionId?: string;
  /**
   * Subagent type of the child session (the host session's `agent` field,
   * e.g. `oracle` / `explorer`). Adapters that build human-readable display
   * names (cmux) consume it; every other adapter ignores it.
   */
  subagentType?: string;
}

/**
 * Core multiplexer interface
 * Implementations: TmuxMultiplexer, ZellijMultiplexer, HerdrMultiplexer,
 * CmuxMultiplexer, KittyMultiplexer
 */
export interface Multiplexer {
  readonly type: 'tmux' | 'zellij' | 'herdr' | 'cmux-tui' | 'kitty';

  /**
   * Check if the multiplexer binary is available on the system
   */
  isAvailable(): Promise<boolean>;

  /**
   * Check if currently running inside a multiplexer session
   */
  isInsideSession(): boolean;

  /**
   * Spawn a new pane running the given command
   * @param sessionId - The OpenCode session ID to attach to
   * @param description - Human-readable description for the pane
   * @param serverUrl - The OpenCode server URL to attach to
   * @param directory - The project directory to attach from
   */
  spawnPane(
    sessionId: string,
    description: string,
    serverUrl: string,
    directory: string,
    options?: PaneSpawnOptions,
  ): Promise<PaneResult>;

  /**
   * Close a pane by its adapter-local opaque handle.
   *
   * The handle is only meaningful to the adapter that produced it: cmux
   * returns a terminal id, tmux/zellij/herdr/kitty return their native pane
   * id. Callers must pass it back unmodified and never interpret it.
   * @param paneId - The adapter-local opaque handle returned by spawnPane
   * @returns true if successfully closed
   */
  closePane(paneId: string): Promise<boolean>;

  /**
   * Apply layout to rebalance panes
   * @param layout - The layout type to apply
   * @param mainPaneSize - Percentage for main pane (for main-* layouts)
   */
  applyLayout(layout: MultiplexerLayout, mainPaneSize: number): Promise<void>;
}
