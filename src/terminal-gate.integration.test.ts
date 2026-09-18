import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import * as hookFactories from './hooks';
import { isVolatileTaggedMessage } from './hooks/cache-safe-injection';
import { resetOrchestratorWakeGateForTests } from './hooks/orchestrator-wake/wake-gate';
import { BACKGROUND_JOB_BOARD_METADATA_KEY } from './hooks/task-session-manager/board-injection';
import * as runtimeFactories from './hooks/task-session-manager/runtime-status-reconciliation';
import { OhMyOpenCodeLite as plugin } from './index';
import type { BackgroundJobRecord } from './utils/background-job-board';
import type { BackgroundJobCoordinator } from './utils/background-job-coordinator';
import * as gateFactories from './utils/background-job-terminal-gate';
import { BackgroundTaskConcurrency } from './utils/background-task-concurrency';
import * as loggerModule from './utils/logger';
import { mapV2EventToV1 } from './v2/event-adapter';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const flush = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
type StatusResponse = { data: { child: { type: 'busy' | 'idle' } } };
const transcript = () => ({
  data: [
    {
      info: {
        id: 'answer',
        role: 'assistant',
        time: { completed: Date.now() },
        finish: 'stop',
      },
      parts: [{ type: 'text', text: 'confirmed result' }],
    },
  ],
});

async function assembly(
  onHookCreated?: (
    board: BackgroundJobCoordinator,
    gate: gateFactories.BackgroundJobTerminalGate,
  ) => void,
  setup: {
    statusTimeoutMs?: number;
    statusAvailable?: boolean;
    graceMs?: number;
    /** Whole-client replacement (v2 shim-shaped hosts). Suppresses the
     * default v1 client so capability probes see honest method absence. */
    client?: unknown;
    /** Host flavor stamp forwarded to the plugin input exactly as the v2
     * client shim does (`buildPluginInput` stamps `hostFlavor: 'v2'`). */
    hostFlavor?: string;
    /** Flat `backgroundJobs` config overrides merged into the written
     * config file (e.g. orchestrator-wake knobs for wake-sensitive
     * fixtures). */
    configOverrides?: Record<string, unknown>;
    /** Build the gate WITHOUT the production `hostOutcomeClock`
     * contract, pinning the #1225 dependency: no shared clock, no
     * attribution window, no host-outcome publication. */
    withoutHostOutcomeClock?: boolean;
  } = {},
) {
  const env = { ...process.env };
  const directory = await mkdtemp('/tmp/slim-terminal-assembly-');
  process.env.OPENCODE_CONFIG_DIR = directory;
  process.env.XDG_CONFIG_HOME = directory;
  process.env.XDG_DATA_HOME = directory;
  process.env.XDG_CACHE_HOME = directory;
  delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
  await Bun.write(
    `${directory}/oh-my-opencode-slim.json`,
    JSON.stringify({
      backgroundJobs: {
        concurrency: { defaultConcurrency: 1 },
        readContextMinLines: 1,
        ...(setup.configOverrides ?? {}),
      },
    }),
  );
  let board!: BackgroundJobCoordinator;
  let gate!: gateFactories.BackgroundJobTerminalGate;
  let taskHook!: ReturnType<typeof hookFactories.createTaskSessionManagerHook>;
  let runtime!: ReturnType<
    typeof runtimeFactories.createRuntimeStatusReconciler
  >;
  const originalRuntime = runtimeFactories.createRuntimeStatusReconciler;
  const runtimeSpy = spyOn(
    runtimeFactories,
    'createRuntimeStatusReconciler',
  ).mockImplementation((options) => {
    runtime = originalRuntime({
      ...options,
      statusTimeoutMs: setup.statusTimeoutMs ?? options.statusTimeoutMs,
    });
    return runtime;
  });
  const originalGate = gateFactories.createBackgroundJobTerminalGate;
  const gateSpy = spyOn(
    gateFactories,
    'createBackgroundJobTerminalGate',
  ).mockImplementation((options) => {
    board = options.backgroundJobBoard as BackgroundJobCoordinator;
    gate = originalGate({
      ...options,
      graceMs: setup.graceMs ?? options.graceMs,
      ...(setup.withoutHostOutcomeClock ? { hostOutcomeClock: undefined } : {}),
    });
    return gate;
  });
  const originalHook = hookFactories.createTaskSessionManagerHook;
  let prune!: ReturnType<typeof spyOn>;
  const hookSpy = spyOn(
    hookFactories,
    'createTaskSessionManagerHook',
  ).mockImplementation((...args) => {
    taskHook = originalHook(...args);
    prune = spyOn(taskHook, 'pruneTaskContext');
    onHookCreated?.(board, gate);
    return taskHook;
  });
  let busy = false;
  const heldStatuses: ReturnType<typeof deferred<StatusResponse>>[] = [];
  const statusMetrics = { activeReads: 0, maxActiveReads: 0 };
  const status = mock(async (): Promise<StatusResponse> => {
    statusMetrics.maxActiveReads = Math.max(
      statusMetrics.maxActiveReads,
      ++statusMetrics.activeReads,
    );
    try {
      const held = heldStatuses.shift();
      return held
        ? await held.promise
        : { data: { child: { type: busy ? 'busy' : 'idle' } } };
    } finally {
      statusMetrics.activeReads--;
    }
  });
  const messages = mock(
    async (_args: unknown): Promise<unknown> => transcript(),
  );
  const get = mock(
    async (_args: unknown): Promise<unknown> => ({
      data: {
        parentID: 'parent',
        outcome: 'succeeded',
        time: { idle: Date.now() },
      },
    }),
  );
  const noop = async () => ({ data: [] });
  const session = new Proxy(
    {
      status,
      messages,
      get,
    },
    {
      get: (target, key) =>
        key === 'status' && setup.statusAvailable === false
          ? undefined
          : (Reflect.get(target, key) ?? noop),
    },
  );
  const builtClient = new Proxy(
    { session, app: { log: noop } },
    {
      get: (target, key) =>
        Reflect.get(target, key) ?? new Proxy({}, { get: () => noop }),
    },
  );
  // v2 shim-shaped hosts replace the client wholesale; the default v1
  // client (with a live session.status) stays for every other test.
  const client = setup.client ?? builtClient;
  const instance: { hooks?: Awaited<ReturnType<typeof plugin>> } = {};
  cleanups.push(async () => {
    await instance.hooks?.dispose?.();
    prune?.mockRestore();
    hookSpy.mockRestore();
    gateSpy.mockRestore();
    runtimeSpy.mockRestore();
    process.env = env;
    await rm(directory, { recursive: true, force: true });
  });
  const hooks = await plugin({
    client,
    directory,
    worktree: directory,
    serverUrl: new URL('http://127.0.0.1:4096'),
    ...(setup.hostFlavor ? { hostFlavor: setup.hostFlavor } : {}),
  } as never);
  instance.hooks = hooks;
  expect(gate).toBeDefined();
  expect(taskHook).toBeDefined();
  const event = (type: string, properties?: Record<string, unknown>) =>
    hooks.event?.({ event: { type, properties } } as never);
  const call = { tool: 'task', sessionID: 'parent', callID: 'native' };
  const requestTask = (callID: string, description: string) =>
    hooks['tool.execute.before']?.(
      { ...call, callID },
      {
        args: {
          subagent_type: 'explorer',
          background: true,
          description,
        },
      },
    );
  const begin = async () => {
    await requestTask('native', 'ordinary task');
    await event('session.created', {
      info: { id: 'child', parentID: 'parent', agent: 'explorer' },
    });
  };
  const after = (state: string) =>
    hooks['tool.execute.after']?.(call, {
      output: `task_id: child\nstate: ${state}\n<task_result>confirmed result</task_result>`,
    });
  const idle = () => event('session.idle', { sessionID: 'child' });
  const busySignal = (activityAt?: number) =>
    event('session.status', {
      sessionID: 'child',
      status: { type: 'busy' },
      activityAt,
    });
  return {
    hooks,
    board,
    gate,
    taskHook,
    runtime,
    prune,
    status,
    statusMetrics,
    messages,
    get,
    directory,
    begin,
    requestTask,
    after,
    idle,
    event,
    busySignal,
    holdStatus: () => {
      const held = deferred<StatusResponse>();
      heldStatuses.push(held);
      return () => held.resolve({ data: { child: { type: 'busy' } } });
    },
    setBusy: (value: boolean) => {
      busy = value;
    },
  };
}

type Assembly = Awaited<ReturnType<typeof assembly>>;
function publicationOf(h: Assembly) {
  const publication = h.board.get('child');
  if (publication?.completedAt === undefined)
    throw new Error('missing publication');
  expect(publication.state).toBe('completed');
  return publication;
}
async function complete(h: Assembly) {
  await h.begin();
  await h.after('completed');
  return publicationOf(h);
}
async function completeWhileBusy(h: Assembly) {
  await h.begin();
  const oldTranscript = transcript();
  const held = deferred<unknown>();
  h.messages.mockImplementationOnce(() => held.promise);
  const completion = h.after('completed');
  await flush();
  expect(h.messages).toHaveBeenCalledTimes(1);
  expect(h.status.mock.calls.length).toBeGreaterThanOrEqual(1);
  h.setBusy(true);
  const activityAt = Date.now();
  // Keep the pre-publication case distinct from the equality boundary.
  await Bun.sleep(2);
  held.resolve(oldTranscript);
  await completion;
  const publication = publicationOf(h);
  expect(activityAt).toBeLessThan(publication.completedAt);
  return { publication, activityAt };
}
function expectReopened(h: Assembly, publication: BackgroundJobRecord) {
  expect(h.board.get('child')).toMatchObject({
    state: 'running',
    generation: publication.generation,
    terminalRevision: publication.terminalRevision + 1,
    resultSummary: undefined,
  });
}

test('regression: idle-with-busy-host must query status and publish nothing', async () => {
  const h = await assembly();
  await h.begin();
  await h.after('running');
  h.setBusy(true);
  h.status.mockClear();
  const terminal = mock(() => {});
  h.board.addTerminalOutcomeListener(terminal);
  await h.idle();
  await flush();
  expect(h.status.mock.calls.length).toBeGreaterThanOrEqual(1);
  expect(h.board.get('child')?.state).toBe('running');
  expect(terminal).not.toHaveBeenCalled();
});

test.each(['missing outcome', 'lookup failure'])(
  'final idle without status retries a transient %s and releases capacity without another signal',
  async (failure) => {
    const h = await assembly(undefined, {
      statusAvailable: false,
      graceMs: 20,
    });
    await h.begin();
    await h.after('running');
    h.get.mockClear();
    h.get.mockImplementationOnce(async () => {
      if (failure === 'lookup failure')
        throw new Error('temporarily unavailable');
      return { data: { parentID: 'parent' } };
    });
    const release = spyOn(BackgroundTaskConcurrency.prototype, 'releaseTask');
    cleanups.push(async () => {
      release.mockRestore();
    });
    let admitted = false;
    const extra = h.requestTask('extra', 'queued before final idle').then(
      () => {
        admitted = true;
      },
      () => {},
    );
    await flush();
    expect(admitted).toBe(false);
    await h.idle();
    await flush();
    expect(h.get).toHaveBeenCalledTimes(1);
    expect(h.board.get('child')).toMatchObject({
      state: 'running',
      statusUncertain: true,
    });
    expect(release).not.toHaveBeenCalled();
    // No more host events, transforms or manual gate reconciliations.
    for (let i = 0; i < 100 && h.board.get('child')?.state === 'running'; i++)
      await Bun.sleep(2);
    expect(h.board.get('child')).toMatchObject({
      state: 'completed',
      terminalRevision: 1,
      resultSummary: 'confirmed result',
    });
    expect(h.get).toHaveBeenCalledTimes(2);
    expect(h.status).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    await extra;
    expect(admitted).toBe(true);
  },
);

test('regression: native-after-releases-reopened-run releases once and retains capacity', async () => {
  const h = await assembly();
  await h.begin();
  const release = spyOn(BackgroundTaskConcurrency.prototype, 'releaseTask');
  cleanups.push(async () => {
    release.mockRestore();
  });
  h.board.addTerminalOutcomeListener((record) => {
    const token = h.gate.capture(record);
    if (!token) throw new Error('missing current publication observation');
    h.gate.observe(token, {
      kind: 'busy',
      origin: 'session.status',
      readStartedAt: token.readStartedAt,
    });
  });
  await h.after('completed');
  let extraTaskAdmitted = false;
  const pending = h.requestTask('extra', 'extra');
  void pending?.then(
    () => {
      extraTaskAdmitted = true;
    },
    () => {},
  );
  await flush();
  expect(h.board.get('child')?.state).toBe('running');
  expect(
    release.mock.calls.filter(([taskID]) => taskID === 'child'),
  ).toHaveLength(1);
  expect(extraTaskAdmitted).toBe(false);
});

test('untimestamped busy needs a runtime contrast; reception alone cannot reopen', async () => {
  const h = await assembly();
  await complete(h);
  h.status.mockClear();
  await h.busySignal();
  expect(h.status.mock.calls.length).toBeGreaterThanOrEqual(1);
  expect(h.board.get('child')?.state).toBe('completed');
  h.setBusy(true);
  await h.busySignal();
  expect(h.board.get('child')?.state).toBe('running');
});

test('busy during transcript read delivered after commit triggers a fresh runtime contrast', async () => {
  const h = await assembly();
  const { publication, activityAt } = await completeWhileBusy(h);
  h.status.mockClear();
  await h.busySignal(activityAt);
  expect(h.status.mock.calls.length).toBeGreaterThanOrEqual(1);
  expectReopened(h, publication);
});

test('busy at the exact publication timestamp triggers a runtime contrast', async () => {
  const h = await assembly();
  const publication = await complete(h);
  h.setBusy(true);
  h.status.mockClear();
  await h.busySignal(publication.completedAt);
  expect(h.status.mock.calls.length).toBeGreaterThanOrEqual(1);
  expectReopened(h, publication);
});

test.each(['open', 'timed-out'] as const)(
  'deferred contrast survives collision with held polling and repairs without another signal (%s)',
  async (readState) => {
    const h = await assembly(undefined, {
      statusTimeoutMs: readState === 'timed-out' ? 1 : undefined,
    });
    const { publication, activityAt } = await completeWhileBusy(h);
    h.status.mockClear();
    const releaseStatus = h.holdStatus();
    // Drive the real polling pass, with its pre-event observation token.
    const polling = h.runtime.reconcile();
    await flush();
    expect(h.status).toHaveBeenCalledTimes(1);
    await h.busySignal(activityAt);
    expect(h.board.get('child')).toMatchObject({
      state: 'completed',
      terminalRevision: publication.terminalRevision,
    });
    expect(h.status).toHaveBeenCalledTimes(1);

    if (readState === 'timed-out') {
      await polling;
      expect(h.board.get('child')?.state).toBe('completed');
      expect(h.status).toHaveBeenCalledTimes(1);
    }
    releaseStatus();
    await polling;
    // No further event, tool call or manual reconciliation may drive recovery.
    await flush();
    expect(h.status).toHaveBeenCalledTimes(2);
    expectReopened(h, publication);
  },
);

test('busy during the fresh gate read retains contrast through both read registries', async () => {
  const h = await assembly();
  const { publication, activityAt } = await completeWhileBusy(h);
  h.status.mockClear();
  const releasePolling = h.holdStatus();
  const releaseGateRead = h.holdStatus();
  const polling = h.runtime.reconcile();
  await flush();
  expect(h.status).toHaveBeenCalledTimes(1);
  await h.busySignal(activityAt);
  expect(h.status).toHaveBeenCalledTimes(1);
  releasePolling();
  await polling;
  await flush();
  expect(h.status).toHaveBeenCalledTimes(2);
  expect(h.statusMetrics.activeReads).toBe(1);

  // This signal invalidates the fresh gate read while it is still open.
  await h.busySignal(activityAt);
  expect(h.status).toHaveBeenCalledTimes(2);
  expect(h.board.get('child')).toMatchObject({
    state: 'completed',
    terminalRevision: publication.terminalRevision,
  });
  releaseGateRead();
  // Recovery must not require another event, tool call or manual reconcile.
  await flush();
  expect(h.status).toHaveBeenCalledTimes(3);
  expect(h.statusMetrics).toEqual({ activeReads: 0, maxActiveReads: 1 });
  expectReopened(h, publication);
});

test('historical busy with a quiescent host contrasts without withdrawing the publication', async () => {
  const h = await assembly();
  const publication = await complete(h);
  const activityAt = publication.lastLiveBusyAt ?? publication.runStartedAt;
  expect(activityAt).toBeLessThanOrEqual(publication.completedAt);
  h.setBusy(false);
  h.status.mockClear();
  const terminal = mock(() => {});
  h.board.addTerminalOutcomeListener(terminal);
  await h.busySignal(activityAt);
  expect(h.status.mock.calls.length).toBeGreaterThanOrEqual(1);
  expect(h.board.get('child')).toMatchObject({
    state: 'completed',
    generation: publication.generation,
    terminalRevision: publication.terminalRevision,
    activityRevision: publication.activityRevision,
    resultSummary: publication.resultSummary,
  });
  expect(terminal).not.toHaveBeenCalled();
});

test('initialization failure disposes the gate owned by the production assembly', async () => {
  let assertDisposed: (() => Promise<void>) | undefined;
  await expect(
    assembly((board, gate) => {
      const run = board.registerLaunch({
        taskID: 'child',
        parentSessionID: 'parent',
        agent: 'explorer',
      });
      const token = gate.capture(run);
      if (!token) throw new Error('missing initial observation');
      const dispose = spyOn(gate, 'dispose');
      cleanups.push(async () => {
        dispose.mockRestore();
      });
      assertDisposed = async () => {
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(gate.capture(run)).toBeUndefined();
        expect(
          gate.observe(token, {
            kind: 'quiescent',
            origin: 'session.status',
            readStartedAt: token.readStartedAt,
          }),
        ).toEqual({ kind: 'stale' });
        expect(await gate.reconcile(run)).toEqual({ kind: 'stale' });
        expect(board.get(run.taskID)?.state).toBe('running');
      };
      throw new Error('forced assembly initialization failure');
    }),
  ).rejects.toThrow('forced assembly initialization failure');
  if (!assertDisposed) throw new Error('failure injection was not reached');
  await assertDisposed();
});

test.each(['dispose', 'event'] as const)(
  'regression: shared-gate-after-dispose through production %s',
  async (path) => {
    const h = await assembly();
    await h.begin();
    await h.after('running');
    const held = deferred<unknown>();
    h.messages.mockImplementationOnce(() => held.promise);
    const terminal = mock(() => {});
    h.board.addTerminalOutcomeListener(terminal);
    const run = h.board.get('child');
    if (!run) throw new Error('missing child run');
    const pending = h.gate.reconcile(run);
    await flush();
    expect(held.resolve).toBeFunction();
    expect(h.messages).toHaveBeenCalledTimes(1);
    if (path === 'dispose') await h.hooks.dispose?.();
    else await h.event('server.instance.disposed');
    held.resolve(transcript());
    await pending;
    await flush();
    expect(terminal).not.toHaveBeenCalled();
    expect(h.board.get('child')?.state).not.toBe('completed');
    expect(h.gate.capture({ taskID: 'child', generation: 1 })).toBeUndefined();
  },
);

test('regression: terminal-context-not-attached consolidates and prunes ordinary tasks', async () => {
  const h = await assembly();
  await h.begin();
  await h.after('running');
  await h.hooks['tool.execute.after']?.(
    { tool: 'read', sessionID: 'child', callID: 'read' },
    { output: `<path>${h.directory}/source.ts</path>\n1: first\n2: second` },
  );
  const trackerFiles = h.taskHook.contextFilesForTask('child');
  expect(trackerFiles).toHaveLength(1);
  h.prune.mockClear();
  await h.idle();
  await flush();
  expect(h.board.get('child')?.state).toBe('completed');
  expect(h.board.get('child')?.contextFiles).toEqual(trackerFiles);
  expect(h.prune).toHaveBeenCalledTimes(1);
  h.board.drop('child');
  h.taskHook.pruneTaskContext();
  expect(h.taskHook.contextFilesForTask('child')).toEqual([]);
});

// ── Task 3.5: adapter-driven starvation reproduction (live incident) ──
//
// Live 2.0.8 incident (verified twice): a background child whose host
// had already committed `Session.Info.idle_outcome='succeeded'` at idle
// time never received a terminal publication — the board stayed
// `running, status uncertain` until `EVIDENCE_UNAVAILABLE` exhausted
// its retry budget. This drives the REAL chain, not hand-fed v1 shapes:
// raw v2 events pumped through `mapV2EventToV1`, every product (raw
// first, then the synthesized v1 shapes) dispatched to the production
// event hook in the same order as the v2 pump in `src/v2/setup.ts`,
// against a shim-shaped client — no `session.status`, no
// `session.list`, no `session.messages`; `session.get` returns the
// v2 `Session.Info` with `outcome` + `time.idle` (the envelope
// `outcomeFromRead`/`attributableHostOutcome` unwraps; the production
// assembly already wires `hostOutcomeClock: 'shared-unix-ms'` in
// src/index.ts, and the assembly's gate spy spreads it through).
//
// Attribution timing: the gate binds `Date.now` at CONSTRUCTION, so a
// frozen Date.now mock would desynchronize the attribution window from
// the timestamps the fixture controls. Instead everything shares the
// real clock, and the fixture enforces strict ordering (>=2ms sleeps)
// between the three boundaries the window compares —
// runStartedAt/lastLiveBusyAt (the execution envelope's `created`) <
// the host-committed `time.idle` <= the gate's read completion — so
// no rejection boundary can fire spuriously.

/** v2 host probe: shim-shaped client + the host-side outcome commit. */
interface V2HostProbe {
  client: unknown;
  /** Host commits idle_outcome when it publishes the terminal
   * execution event (live-verified: outcome already set at idle). */
  commitTerminalOutcome(idleAt: number): void;
  readonly get: ReturnType<typeof mock>;
  /** Present ONLY on hosts that expose a transcript source; the
   * starving shim shape (live incident) has none at all. */
  readonly messages?: ReturnType<typeof mock>;
  /** The wake surface's promptAsync mock (present only when
   * `wakeSurface` was requested — live v2 hosts expose it via the
   * client shim). */
  readonly promptAsync?: ReturnType<typeof mock>;
}

function v2ShimClient(options: {
  outcome: string;
  /** Transcript source: a host that exposes `session.messages`.
   * Omitted by default — honest method absence on the session. */
  transcript?: () => unknown;
  /** Probe: keep `session.get` reporting the running shape (no
   * outcome/idle) for the first N reads even after the host committed
   * its terminal outcome; reveal it only on read N+1 onward. */
  hideOutcomeForReads?: number;
  /** Live-v2 wake surface: `session.list` + `session.promptAsync`, the
   * exact pair the client shim exposes and `probeSessionApis` requires
   * for the v2 wake capability. Absent by default — the starving shim
   * shape (live incident) exposes neither, so the wake capability must
   * stay honestly not-ready there. `listChildren` is re-evaluated on
   * every list call so host-side state changes (running → terminal)
   * surface like a live host. */
  wakeSurface?: {
    listChildren?: () => Array<Record<string, unknown>>;
    promptAsync?: ReturnType<typeof mock>;
  };
}): V2HostProbe {
  const host = {
    outcome: options.outcome,
    idleAt: undefined as number | undefined,
  };
  let reads = 0;
  const get = mock(async (_args: unknown): Promise<unknown> => {
    reads += 1;
    // v2 Session.Info carries `outcome`/`time.idle` only after the
    // terminal transition; a running child has neither. The probe delay
    // hides the committed transition from the first N reads.
    const visible =
      host.idleAt !== undefined && reads > (options.hideOutcomeForReads ?? 0);
    return {
      data: visible
        ? {
            parentID: 'parent',
            outcome: host.outcome,
            time: { idle: host.idleAt },
          }
        : { parentID: 'parent' },
    };
  });
  const messages = options.transcript
    ? mock(async (_args: unknown): Promise<unknown> => options.transcript?.())
    : undefined;
  const promptAsync =
    options.wakeSurface?.promptAsync ?? mock(async () => ({}));
  // Shim shape: ONLY session.get (plus the optional transcript source
  // and wake surface). `session` is a plain object so absent methods
  // stay absent (capability probes must see honest absence, never an
  // auto-filled stub); other client domains still degrade through the
  // outer proxy like the v1 assembly default.
  const session = {
    get,
    ...(messages ? { messages } : {}),
    ...(options.wakeSurface
      ? {
          list: mock(async () => ({
            data: options.wakeSurface?.listChildren?.() ?? [],
          })),
          promptAsync,
        }
      : {}),
  };
  const client = new Proxy(
    { session, app: { log: async () => ({}) } },
    {
      get: (target, key) =>
        Reflect.get(target, key) ??
        new Proxy({}, { get: () => async () => ({ data: [] }) }),
    },
  );
  return {
    client,
    get,
    ...(messages ? { messages } : {}),
    ...(options.wakeSurface ? { promptAsync } : {}),
    commitTerminalOutcome(idleAt: number) {
      host.idleAt = idleAt;
    },
  };
}

type V2RawEventSpec = {
  type: string;
  data: Record<string, unknown>;
};

async function driveV2Lifecycle(
  probe: V2HostProbe,
  events: V2RawEventSpec[],
  setup: { withoutHostOutcomeClock?: boolean } = {},
): Promise<BackgroundJobCoordinator> {
  const childID = String(
    events.find((event) => event.type === 'session.created')?.data.sessionID ??
      events[0]?.data.sessionID ??
      'child',
  );
  const h = await assembly(undefined, {
    graceMs: 20,
    client: probe.client,
    withoutHostOutcomeClock: setup.withoutHostOutcomeClock,
  });
  const dispatch = async (event: Record<string, unknown>) => {
    await h.hooks.event?.({ event } as never);
  };
  // The real chain: the host's task tool call returns after the child
  // session exists (pending call → session.created → tool.execute.after
  // with a running-state output), then the durable v2 lifecycle runs.
  // Each step sleeps >=2ms so the host timestamps it stamps stay
  // strictly ordered (run start < busy activity < committed idle).
  await h.requestTask('native', 'v2 adapter lifecycle probe');
  let notifiedToolReturn = false;
  for (const spec of events) {
    await Bun.sleep(2);
    if (
      spec.type !== 'session.execution.started' &&
      spec.type.startsWith('session.execution.')
    )
      probe.commitTerminalOutcome(Date.now());
    const raw: Record<string, unknown> = {
      id: `evt-${spec.type}-${String(spec.data.sessionID ?? '')}`,
      created: Date.now(),
      type: spec.type,
      data: spec.data,
    };
    // Production pump order (src/v2/setup.ts): raw event first, then
    // every synthesized v1 shape, each through the real event hook.
    for (const event of mapV2EventToV1(raw)) await dispatch(event);
    await flush();
    // After the child is registered, the host's task tool call returns
    // a running-state output (background:true registration + the
    // native running candidate signal), before execution starts.
    if (spec.type === 'session.created' && !notifiedToolReturn) {
      notifiedToolReturn = true;
      await Bun.sleep(2);
      await h.after('running');
      await flush();
    }
  }
  // Let the gate's evidence-retry schedule (graceMs-bounded timers)
  // run to publication or exhaustion, whichever comes first; real time
  // advancing past the quiescence grace keeps the stable branches live
  // rather than accidentally skipped.
  for (let i = 0; i < 200 && h.board.get(childID)?.state === 'running'; i++) {
    await Bun.sleep(5);
  }
  return h.board;
}

// verdict A (un-skipped by the starvation-fix task): reproduces the live
// v2 starvation — attributed host success + no transcript source.
test('v2 lifecycle through the real adapter terminalizes a completed child', async () => {
  const capture = captureGateLogs();
  try {
    const probe = v2ShimClient({ outcome: 'succeeded' });
    const board = await driveV2Lifecycle(probe, [
      {
        type: 'session.created',
        data: { sessionID: 'child', parentID: 'parent', agent: 'explorer' },
      },
      { type: 'session.execution.started', data: { sessionID: 'child' } },
      { type: 'session.execution.succeeded', data: { sessionID: 'child' } },
    ]);
    expect(board.get('child')).toMatchObject({
      state: 'completed',
      resultSummary: 'Host reported outcome: succeeded.',
    });
    // The publication must flow through the instrumented commit path:
    // Task 2's INFO log with host-outcome attribution.
    const published = capture.of('[terminal-gate] terminal published', 'child');
    expect(published).toHaveLength(1);
    expect(published[0]?.data).toMatchObject({
      taskID: 'child',
      state: 'completed',
      attribution: 'host-outcome',
      parentSessionID: 'parent',
    });
  } finally {
    capture.restore();
  }
});

// ── Starvation-fix guards (fences around the early-publish path) ──
//
// The fix commits `completed` from a window-attributed host success ONLY
// when the transcript SOURCE is absent (capability: no session.messages).
// Source-unavailable ≠ pending: a host that HAS a source whose transcript
// is still unfinalized must keep waiting exactly as before, and an
// outcome the #1225 window cannot attribute to this run authorizes
// nothing even with no transcript source at all.

function captureGateLogs() {
  const entries: Array<{ message: string; data: unknown }> = [];
  const spy = spyOn(loggerModule, 'log').mockImplementation(
    (message: string, data?: unknown) => {
      entries.push({ message, data });
    },
  );
  return {
    of: (message: string, taskID: string) =>
      entries.filter(
        (entry) =>
          entry.message === message &&
          (entry.data as { taskID?: string } | undefined)?.taskID === taskID,
      ),
    restore: () => spy.mockRestore(),
  };
}

test('guard: attributed success with a real pending transcript never early-publishes', async () => {
  const capture = captureGateLogs();
  try {
    // The ONLY capability delta from the starving shim: this host
    // exposes a transcript source. Its transcript is genuinely
    // unfinalized (trailing assistant still on tool-calls), so no
    // amount of waiting could ever justify inventing a result.
    const probe = v2ShimClient({
      outcome: 'succeeded',
      transcript: () => ({
        data: [
          {
            info: { id: 'turn', role: 'assistant', finish: 'tool-calls' },
            parts: [{ type: 'text', text: 'streaming' }],
          },
        ],
      }),
    });
    const board = await driveV2Lifecycle(probe, [
      {
        type: 'session.created',
        data: { sessionID: 'child', parentID: 'parent', agent: 'explorer' },
      },
      { type: 'session.execution.started', data: { sessionID: 'child' } },
      { type: 'session.execution.succeeded', data: { sessionID: 'child' } },
    ]);
    // The source was consulted and the host outcome WAS attributed
    // (accepted, succeeded) — the guard is not accidentally passing
    // because the outcome read never happened.
    expect(probe.messages).toHaveBeenCalled();
    const attributions = capture.of(
      '[terminal-gate] host-outcome attribution',
      'child',
    );
    expect(attributions.length).toBeGreaterThan(0);
    expect(attributions[attributions.length - 1]?.data).toMatchObject({
      outcome: 'succeeded',
      verdict: 'accepted',
    });
    // ...and still nothing may publish off a pending transcript.
    expect(board.get('child')?.state).toBe('running');
    expect(capture.of('[terminal-gate] terminal published', 'child')).toEqual(
      [],
    );
  } finally {
    capture.restore();
  }
});

test('guard: unattributable succeeded outcome with no transcript source publishes nothing', async () => {
  const capture = captureGateLogs();
  try {
    const probe = v2ShimClient({ outcome: 'succeeded' });
    const hostCommit = probe.commitTerminalOutcome;
    // The host committed its success well before this run started (a
    // historical idle): the #1225 window must reject it, and capability
    // absence may not substitute for attribution.
    const historical = {
      ...probe,
      commitTerminalOutcome: (idleAt: number) => hostCommit(idleAt - 60_000),
    };
    const board = await driveV2Lifecycle(historical, [
      {
        type: 'session.created',
        data: { sessionID: 'child', parentID: 'parent', agent: 'explorer' },
      },
      { type: 'session.execution.started', data: { sessionID: 'child' } },
      { type: 'session.execution.succeeded', data: { sessionID: 'child' } },
    ]);
    const attributions = capture.of(
      '[terminal-gate] host-outcome attribution',
      'child',
    );
    expect(attributions.length).toBeGreaterThan(0);
    expect(attributions[attributions.length - 1]?.data).toMatchObject({
      verdict: 'rejected',
      reason: 'idle-not-after-window-lower',
    });
    expect(board.get('child')?.state).toBe('running');
    expect(capture.of('[terminal-gate] terminal published', 'child')).toEqual(
      [],
    );
  } finally {
    capture.restore();
  }
});

// ── Task 5: attribution guard-rails and interruption mapping ──
//
// Task 4's fix publishes from a window-attributed host outcome when the
// transcript source is absent. These pins lock the surrounding rails:
// the stop/interrupt family must not surface as a false error, a failed
// outcome must surface as an error with the host payload, the #1225
// attribution window must depend on the explicit hostOutcomeClock
// contract, and the post-exhaustion dead end stays recorded honestly.

test('guard: attributed interrupted outcome publishes from the stop/cancel family, never error', async () => {
  const capture = captureGateLogs();
  try {
    const probe = v2ShimClient({ outcome: 'interrupted' });
    const board = await driveV2Lifecycle(probe, [
      {
        type: 'session.created',
        data: { sessionID: 'child', parentID: 'parent', agent: 'explorer' },
      },
      { type: 'session.execution.started', data: { sessionID: 'child' } },
      { type: 'session.execution.interrupted', data: { sessionID: 'child' } },
    ]);
    const record = board.get('child');
    if (record?.completedAt === undefined)
      throw new Error('interrupted outcome never published');
    // The host distinguished an interruption from a failure; the board
    // vocabulary for a stop without a plugin-verified cancel lease is
    // the stop/cancel family — never a false 'error'.
    expect(['stopped', 'cancelled']).toContain(record.state);
    expect(record.state).not.toBe('error');
    const published = capture.of('[terminal-gate] terminal published', 'child');
    expect(published).toHaveLength(1);
    expect(published[0]?.data).toMatchObject({
      taskID: 'child',
      attribution: 'host-outcome',
      parentSessionID: 'parent',
    });
    expect(published[0]?.data).toMatchObject({ state: record.state });
  } finally {
    capture.restore();
  }
});

test('guard: attributed failed outcome publishes error and carries the host error payload', async () => {
  const capture = captureGateLogs();
  try {
    const probe = v2ShimClient({ outcome: 'failed' });
    const board = await driveV2Lifecycle(probe, [
      {
        type: 'session.created',
        data: { sessionID: 'child', parentID: 'parent', agent: 'explorer' },
      },
      { type: 'session.execution.started', data: { sessionID: 'child' } },
      {
        type: 'session.execution.failed',
        data: {
          sessionID: 'child',
          error: { message: 'host-side detonation payload' },
        },
      },
    ]);
    const record = board.get('child');
    if (record?.completedAt === undefined)
      throw new Error('failed outcome never published');
    expect(record.state).toBe('error');
    // The host's failure payload must reach the record's diagnostic
    // surface (the summary the parent reconciles against), never be
    // dropped in favor of a bare state label.
    expect(record.resultSummary).toContain('host-side detonation payload');
    const published = capture.of('[terminal-gate] terminal published', 'child');
    expect(published).toHaveLength(1);
    expect(published[0]?.data).toMatchObject({
      taskID: 'child',
      state: 'error',
      parentSessionID: 'parent',
    });
  } finally {
    capture.restore();
  }
});

test('guard: without the hostOutcomeClock contract the attribution window never opens and nothing publishes', async () => {
  const capture = captureGateLogs();
  try {
    const probe = v2ShimClient({ outcome: 'succeeded' });
    // The gate is built WITHOUT `hostOutcomeClock: 'shared-unix-ms'`
    // (the production wiring in src/index.ts is stripped by the
    // fixture): the host and plugin clocks are then not declared
    // comparable, so #1225's window must refuse to attribute even a
    // fresh outcome — capability absence may not publish anything.
    const board = await driveV2Lifecycle(
      probe,
      [
        {
          type: 'session.created',
          data: {
            sessionID: 'child',
            parentID: 'parent',
            agent: 'explorer',
          },
        },
        {
          type: 'session.execution.started',
          data: { sessionID: 'child' },
        },
        {
          type: 'session.execution.succeeded',
          data: { sessionID: 'child' },
        },
      ],
      { withoutHostOutcomeClock: true },
    );
    const attributions = capture.of(
      '[terminal-gate] host-outcome attribution',
      'child',
    );
    expect(attributions.length).toBeGreaterThan(0);
    expect(attributions[attributions.length - 1]?.data).toMatchObject({
      outcome: 'succeeded',
      verdict: 'rejected',
      reason: 'clock-not-comparable',
    });
    // Honest end state: the busy runtime observation is never
    // contradicted (no polling capability on the shim host), so the
    // board simply keeps deferring — running, never terminalized.
    expect(board.get('child')?.state).toBe('running');
    expect(board.get('child')?.completedAt).toBeUndefined();
    expect(capture.of('[terminal-gate] terminal published', 'child')).toEqual(
      [],
    );
  } finally {
    capture.restore();
  }
});

// probe: late-attributable outcome after exhaustion — dead end recorded; adjudication pending
//
// HONEST RESULT (fail — board stranded): the gate consults session.get
// only twice in this scenario (initial inspect + one follow-up), then
// never again — the busy runtime observation from the synthesized
// status event is never contradicted (no polling capability on the
// shim), and a rejected attribution leaves the busy defer path without
// a retry timer. Neither a later idle pair (deduped by the continuous
// idle guard, per the double-idle invariant) nor a later busy→idle
// contrast cycle re-arms an outcome read. The board stays `running`
// forever even with the outcome long since attributable.
test.skip('probe: late-attributable outcome after exhaustion terminalizes the stranded board', async () => {
  const capture = captureGateLogs();
  try {
    // The host commits its outcome on schedule, but session.get hides it
    // for the first 12 reads — far beyond the gate's evidence retry
    // budget (maxEvidenceRetries defaults to 3). The desired behavior:
    // once the outcome becomes attributable, SOMETHING (a timer, a
    // poll, a later reconcile trigger) picks it up and the board
    // terminalizes instead of staying stranded post-exhaustion.
    const probe = v2ShimClient({
      outcome: 'succeeded',
      hideOutcomeForReads: 12,
    });
    const board = await driveV2Lifecycle(probe, [
      {
        type: 'session.created',
        data: { sessionID: 'child', parentID: 'parent', agent: 'explorer' },
      },
      { type: 'session.execution.started', data: { sessionID: 'child' } },
      { type: 'session.execution.succeeded', data: { sessionID: 'child' } },
    ]);
    expect(board.get('child')?.state).toBe('completed');
  } finally {
    capture.restore();
  }
});

// ── Task 7: reopen-after-reconcile full chain (CameraFTP pattern) ──
//
// The live pattern: a background child completes → the gate publishes →
// the parent consumes and reconciles the report → the child is later
// resumed by its own background-shell notification → runs again →
// completes again. This locks the WHOLE loop through the real chain:
// raw v2 envelopes pumped through `mapV2EventToV1` (the resume busy
// carries the host envelope `created` timestamp, so the gate's
// ambiguous-event demotion cannot pass vacuously), the parent's real
// request cycle (`experimental.chat.messages.transform`) performing the
// injection-time reconcile and the Task 6 reopen corrective notice, and
// the second publication firing the Task 6 terminal-publication wake
// for the idle parent through the production listener wiring.

/** Interactive v2 driver: the SAME production pump order as
 * `driveV2Lifecycle` (host outcome committed before terminal execution
 * events; raw event first, then every synthesized v1 shape, each through
 * the real event hook; the host task tool returns a running-state output
 * right after session.created), but controllable event-by-event so a
 * test can interleave parent request cycles and later runs. */
async function openV2Lifecycle(
  probe: V2HostProbe,
  setup: {
    hostFlavor?: string;
    configOverrides?: Record<string, unknown>;
  } = {},
) {
  const h = await assembly(undefined, {
    graceMs: 20,
    client: probe.client,
    ...(setup.hostFlavor ? { hostFlavor: setup.hostFlavor } : {}),
    ...(setup.configOverrides
      ? { configOverrides: setup.configOverrides }
      : {}),
  });
  let pumped = 0;
  let notifiedToolReturn = false;
  const dispatch = async (event: Record<string, unknown>) => {
    await h.hooks.event?.({ event } as never);
  };
  const pump = async (spec: V2RawEventSpec) => {
    pumped += 1;
    await Bun.sleep(2);
    if (
      spec.type !== 'session.execution.started' &&
      spec.type.startsWith('session.execution.')
    )
      probe.commitTerminalOutcome(Date.now());
    const raw: Record<string, unknown> = {
      id: `evt-${pumped}-${spec.type}-${String(spec.data.sessionID ?? '')}`,
      created: Date.now(),
      type: spec.type,
      data: spec.data,
    };
    // Production pump order (src/v2/setup.ts): raw event first, then
    // every synthesized v1 shape, each through the real event hook.
    for (const event of mapV2EventToV1(raw)) await dispatch(event);
    await flush();
    // After the child is registered, the host's task tool call returns
    // a running-state output, before execution starts.
    if (spec.type === 'session.created' && !notifiedToolReturn) {
      notifiedToolReturn = true;
      await Bun.sleep(2);
      await h.after('running');
      await flush();
    }
  };
  const awaitPublication = async (
    taskID: string,
    sinceRevision: number,
  ): Promise<BackgroundJobRecord> => {
    for (let i = 0; i < 400; i++) {
      const record = h.board.get(taskID);
      if (
        record &&
        record.state !== 'running' &&
        record.terminalRevision > sinceRevision
      )
        return record;
      await Bun.sleep(5);
    }
    throw new Error(
      `publication beyond revision ${sinceRevision} never landed`,
    );
  };
  return { h, pump, awaitPublication };
}

/** Terminal-part metadata of a message, when it has exactly one part
 * (same shape contract as the reopen-correction suite). */
function solePartMetadata(
  message: unknown,
): Record<string, unknown> | undefined {
  const parts = (message as { parts?: Array<Record<string, unknown>> })?.parts;
  if (parts?.length !== 1) return undefined;
  return parts[0]?.metadata as Record<string, unknown> | undefined;
}

test('reopen-after-reconcile: child self-continuation republishes, wakes the idle parent, and corrects the parent', async () => {
  resetOrchestratorWakeGateForTests();
  const capture = captureGateLogs();
  try {
    const promptAsync = mock(async () => ({}));
    // Live v2 host: get (host outcome) + the wake surface pair the v2
    // client shim exposes (list + promptAsync); transcript source absent
    // (the starving shim shape), so publication rides the attributed
    // host outcome on both runs.
    let hostChildren: Array<Record<string, unknown>> = [
      { id: 'child', parentID: 'parent' },
    ];
    const probe = v2ShimClient({
      outcome: 'succeeded',
      wakeSurface: {
        listChildren: () => hostChildren,
        promptAsync,
      },
    });
    const { h, pump, awaitPublication } = await openV2Lifecycle(probe, {
      hostFlavor: 'v2',
      // Schema floor (1s) instead of the 30s default so the SECOND
      // publication wake is observable without a half-minute sleep.
      configOverrides: {
        orchestratorWake: { publicationWakeMinIntervalMs: 1_000 },
      },
    });

    // Run 1: launch → execution → terminal → publication #1.
    await h.requestTask('native', 'v2 reopen chain probe');
    await pump({
      type: 'session.created',
      data: { sessionID: 'child', parentID: 'parent', agent: 'explorer' },
    });
    await pump({
      type: 'session.execution.started',
      data: { sessionID: 'child' },
    });
    hostChildren = [
      {
        id: 'child',
        parentID: 'parent',
        outcome: 'succeeded',
        time: { updated: Date.now() },
      },
    ];
    await pump({
      type: 'session.execution.succeeded',
      data: { sessionID: 'child' },
    });
    const first = await awaitPublication('child', 0);
    expect(first).toMatchObject({ state: 'completed' });

    const wakingPublicationWakes = () =>
      capture
        .of('[orchestrator-wake] terminal publication wake', 'child')
        .filter(
          (entry) =>
            (entry.data as { verdict?: string } | undefined)?.verdict ===
            'waking',
        );

    // Wake #1: the first publication reached an idle parent.
    await flush();
    await Bun.sleep(30);
    expect(wakingPublicationWakes()).toHaveLength(1);
    expect(promptAsync).toHaveBeenCalledTimes(1);

    // The parent consumes the report: two real request cycles (deliver,
    // then reconcile once the prompt shape advanced past the delivery).
    const userMsg = (id: string, text: string) => ({
      info: {
        id,
        sessionID: 'parent',
        role: 'user',
        agent: 'orchestrator',
        time: { created: Date.now() },
      },
      parts: [{ type: 'text', text }],
    });
    const assistantMsg = (id: string, text: string) => ({
      info: {
        id,
        sessionID: 'parent',
        role: 'assistant',
        time: { completed: Date.now() },
      },
      parts: [{ type: 'text', text }],
    });
    const requestCycle = async (messages: Array<Record<string, unknown>>) => {
      await h.hooks['experimental.chat.messages.transform']?.(
        {} as never,
        { messages } as never,
      );
      await flush();
    };
    await requestCycle([userMsg('u1', 'check the background result')]);
    await requestCycle([
      userMsg('u1', 'check the background result'),
      assistantMsg('a1', 'consumed the report'),
      userMsg('u2', 'next step'),
    ]);
    expect(h.board.getState('child')).toBe('reconciled');

    // Past the publication-wake throttle window (and strictly past every
    // host timestamp so far — the resume busy must be unambiguous).
    await Bun.sleep(1_100);

    // Run 2: the child's own background-shell notification resumes it.
    // The busy event rides the RAW v2 envelope (created = host time),
    // which mapV2EventToV1 preserves as activityAt — without it the
    // gate's ambiguous-event demotion would make this pass vacuously.
    hostChildren = [
      { id: 'child', parentID: 'parent', time: { updated: Date.now() } },
    ];
    await pump({
      type: 'session.execution.started',
      data: { sessionID: 'child' },
    });
    expectReopened(h, first);

    // The parent's next request cycle delivers EXACTLY ONE reopen
    // corrective notice (Task 6's injection-time detection), as a
    // trailing volatile message in the cache-safe tail zone.
    const correctedCycle = [userMsg('u3', 'meanwhile the child resumed')];
    await requestCycle(correctedCycle);
    const corrections = correctedCycle.filter(
      (message) => solePartMetadata(message)?.reopenCorrection === true,
    );
    expect(corrections).toHaveLength(1);
    const correction = corrections[0];
    expect(
      isVolatileTaggedMessage(correction, BACKGROUND_JOB_BOARD_METADATA_KEY),
    ).toBe(true);
    expect(correctedCycle.at(-1)).toBe(correction);
    const correctionText = (correction as { parts: Array<{ text: string }> })
      .parts[0].text;
    expect(correctionText).toContain('child');
    expect(correctionText).toContain('running again');
    expect(correctionText).toContain('superseded');
    // ...and never repeats on a later cycle.
    const laterCycle = [
      userMsg('u3', 'meanwhile the child resumed'),
      assistantMsg('a3', 'noted the correction'),
      userMsg('u4', 'carry on'),
    ];
    await requestCycle(laterCycle);
    expect(
      laterCycle.filter(
        (message) => solePartMetadata(message)?.reopenCorrection === true,
      ),
    ).toHaveLength(0);

    // Run 2 completes again: a second terminal publication for the SAME
    // generation (new attempt, advanced terminalRevision).
    hostChildren = [
      {
        id: 'child',
        parentID: 'parent',
        outcome: 'succeeded',
        time: { updated: Date.now() },
      },
    ];
    await pump({
      type: 'session.execution.succeeded',
      data: { sessionID: 'child' },
    });
    const second = await awaitPublication('child', first.terminalRevision + 1);
    expect(second).toMatchObject({
      state: 'completed',
      generation: first.generation,
    });
    expect(
      capture.of('[terminal-gate] terminal published', 'child'),
    ).toHaveLength(2);

    // Wake #2: the second publication re-fires the Task 6 wake for the
    // idle parent — the queue delivery the CameraFTP loop depends on.
    await flush();
    await Bun.sleep(30);
    expect(wakingPublicationWakes()).toHaveLength(2);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    const lastWakeCall = promptAsync.mock.calls.at(-1)?.[0] as {
      path?: { id?: string };
      delivery?: string;
      modelSelection?: string;
      body?: { agent?: string };
    };
    expect(lastWakeCall).toMatchObject({
      path: { id: 'parent' },
      delivery: 'queue',
      modelSelection: 'inherit',
    });
    expect(lastWakeCall?.body?.agent).toBe('orchestrator');
  } finally {
    capture.restore();
  }
});
