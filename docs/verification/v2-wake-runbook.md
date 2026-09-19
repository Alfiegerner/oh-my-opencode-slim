# v2 Wake & Terminal-Evidence Verification Runbook

Manual acceptance gate for the `fix/v2-terminal-evidence-and-wake` line of
work (terminal evidence starvation, terminal-publication wake, attribution
guards, permission-rule derivation) against a **real OpenCode v2 host**
(target: 2.0.8 as tasked; the plugin requires v2.0.7+ — see
[docs/opencode-v2-compatibility.md](../opencode-v2-compatibility.md)).

**Status: procedure only.** Live execution (Step 2 of the task brief) is
deferred by controller ruling — this document defines what to run and what
to assert; it records no results yet. Do not build, restart, or probe any
live service as part of writing/maintaining this file.

All log excerpts below are grepped from the plugin log
(`~/.local/share/opencode/log/oh-my-opencode-slim.<timestamp>.log`, 7-day
retention; on Windows
`%USERPROFILE%\.local\share\opencode\log\`). TUI-side registration failures
write no log lines anywhere — verify TUI behavior through the host, not the
log.

## 1. Preconditions: build, restart, build info

1. Confirm the global config points the v2 host at this checkout's build
   (`~/.config/opencode/opencode.json`, shared with v1):

   ```json
   { "plugin": ["/path/to/oh-my-opencode-slim/dist/server"] }
   ```

   `dist/` is the globally-configured plugin load path — no copy step is
   needed after building.

2. From the repo root:

   ```bash
   bun install
   bun run build   # dist/index.js (v1), dist/server/index.js (v2 server),
                   # dist/tui2.js (v2 TUI), dist/cli/
   ```

3. Restart the opencode2 service (a full service restart, not `opencode
   reload` — reload reuses the module instance for npm-form plugins, so a
   stale build could survive it; see the reload caveats in
   [docs/opencode-v2-compatibility.md](../opencode-v2-compatibility.md)).

4. Open the newest `oh-my-opencode-slim.<timestamp>.log` and confirm the
   **first** server-side line identifies the fresh build:

   ```
   [v2] build info {"version":"2.2.21","buildTime":"2026-09-19T..."}
   ```

   The `version` must equal `package.json` and `buildTime` must postdate
   the build you just ran. The committed placeholder carries the epoch
   `buildTime` (`1970-01-01T...`) — seeing it (or any `buildTime` older
   than your build) means the host loaded a stale `dist/`: stop and fix
   the registration before continuing. The v1 factory logs the
   equivalent `[plugin] build info` line in its own log instance.

## 2. Core probe: background explorer task

In a **test project** (throwaway directory — the probe creates real
sessions), ask the orchestrator to spawn a short `background: true`
explorer task, e.g. *"use a background explorer to list the files in this
directory and summarize them"*. Then keep the parent **idle** (do not send
another message).

Assertions, in order:

**(a) Terminal publication with host-outcome attribution.** Within ~10s of
the child going idle, the plugin log shows:

```
[terminal-gate] terminal published {"taskID":"...","generation":1,"state":"completed","attribution":"host-outcome","parentSessionID":"..."}
```

`state=completed` with `attribution=host-outcome` is the expected pairing
on v2: the shim's transcript mapping (`session.messages` →
`session.context`) yields no `time.completed`, so it cannot confirm a
fresh `succeeded` and the window-attributed host outcome publishes alone
(see the terminal-evidence rules in the compatibility doc). The attempt
trail that produced it is visible as:

```
[terminal-gate] host-outcome read initiated {...}
[terminal-gate] host-outcome attribution {"taskID":"...","attempt":1,"outcome":"succeeded","verdict":"accepted","windowLower":...,"windowUpper":...}
```

A `verdict: "rejected"` with a `reason` (e.g. `idle-not-after-window-lower`)
must NOT persist across the observation window — a rejection followed by
no accepted attempt and no publication is the starvation signature this
branch fixes.

**(b) The job board settles terminal-then-reconciled.** On the parent's
next system-reminder (the `### Background Job Board` /
`SENTINEL: background-job-board-v2` injection), the task must appear under
`#### Reusable Sessions` (or have disappeared entirely) — **never** as:

```
- <alias> / <taskID> / explorer / running, status uncertain
```

or `running, unreconciled` under `#### Active / Unreconciled`. After the
parent consumes the report, the board snapshot reconciles the job.

**(c) First publication: native delivery, zero plugin wakes.** The job's
first completion is delivered by the host's native notifier even to an
idle parent (live-verified on a 2.0.8 host), so the plugin log must
contain exactly one skip line for it:

```
[orchestrator-wake] terminal publication wake skipped {"sessionID":"<parent>","taskID":"...","generation":1,"trigger":"terminal-publication","verdict":"skipped","reason":"first-publication-native-owned"}
```

and **zero** `verdict: "waking"` publication-wake lines plus zero queued
wake admissions for that publication — a plugin wake beside the native
delivery double-notifies and is a failure. A LATER publication of the
same lineage (the child resumes and finishes again) or of a later
generation is the plugin's to deliver: exactly one
`[orchestrator-wake] terminal publication wake` with
`verdict: "waking"` and **one** queued wake admission (a single new
admitted internal turn carrying the children-mode wake text, a
`<system-reminder>` telling the orchestrator to check on unfinished
background child sessions, delivered via `promptAsync` with
`delivery: "queue"`). Other expected suppression shapes, for contrast: a
**busy** parent logs
`[orchestrator-wake] terminal publication wake skipped` with
`reason: "parent-busy"` (the native steer already delivered the first
completion — zero wakes is correct there), a publication during an open
input wait or fallback is suppressed **without** consuming the throttle
window (the next eligible publication still wakes), and a burst of
publications inside the throttle collapses with `reason: "throttled"`.
The `verdict: "waking"` count is therefore an honest delivered-wake
count: it only appears when a wake is actually delivered.

## 3. Adopted #1066 acceptance scenarios

Concepts absorbed from upstream issue #1066 (superseded upstream; the
acceptance scenarios live on here as live-host probes):

- **B — no premature stop on idle.** Spawn a longer-running background
  child and let the parent go idle. Over several minutes of parent idle
  time, the child's board entry must stay `running` (healthy, not
  `status uncertain`), with **zero** stop actions: no spurious `stopped`
  transition, no supervisor abort, no `Retained / Recovery` entry while
  the child is demonstrably alive on the host.

- **C1 — no spurious corrective notice.** For the plain
  complete→reconcile cycle of §2, no reopen corrective reminder may
  appear: the trailing notice titled `### Background Job Board —
  Reopened Job` (*"A background job that previously reported a terminal
  result is running again; the earlier report is superseded."*) is
  reserved for a reconciled job that **actually reopens** to running
  (the CameraFTP self-continuation pattern). Its appearance without a
  real reopen is a false-positive failure.

- **D — cache-safety live probe across a revival/notification turn.**
  Resume a reconciled child (revival), let it complete again, and let
  the parent run the woken turn. The revived run's completion must
  produce **exactly one queued admission** for the parent: the
  revived-run tracker's `<task>` notification, delivered via
  `promptAsync` with `delivery: "queue"`. The plugin log must show the
  terminal-publication wake suppressed for that publication —

  ```
  [orchestrator-wake] terminal publication wake skipped {"sessionID":"<parent>","taskID":"...","generation":2,"trigger":"terminal-publication","verdict":"skipped","reason":"revived-tracker-owns-delivery"}
  ```

  — never a second `verdict: "waking"` publication wake beside the
  tracker's delivery: wake + native/tracker double-notifying is a
  failure. Across that whole window the plugin log must show **zero**
  `[cache-monitor]` warnings — none of:

  ```
  [cache-monitor] possible prompt-cache bust: ... reported 0 cache-read tokens
  [cache-monitor] session has never hit the provider cache: ...
  [cache-monitor] cache-read plateau: ...
  ```

  The wake, tracker-notification, and corrective surfaces ride the
  cache-safe trailing zone, so a revival turn that busts the prefix
  is a regression (see [docs/cache-verification.md](../cache-verification.md)).

- **A — absence never stops a job.** Throughout the probe session,
  capability absence (shim degradation lines such as
  `[v2][shim] session.list unavailable ...`, hosts without a transcript
  source) must never coincide with a job stop: an evidence source that is
  absent for the entire run leaves the job honestly `running`
  (dead-end defer), never `stopped`/`error`, and the job terminalizes
  once real evidence arrives. Zero stops attributable to absence.

## 4. Restart sweep: clearing a pre-fix stuck job

Restart-based cleanup is **lazy**: it runs when the parent session is next
active after a plugin restart, via `rehydrateHistoricalRunningTasks` +
`probeRehydratedTaskSession` (a fire-and-forget `session.get` per
rehydrated running task; see the rehydrate-probe section of the
compatibility doc).

1. Produce (or reuse from a historical board capture) a pre-fix stuck
   job: a task whose board entry reads
   `running, status uncertain` (or `running, unreconciled`) under a parent
   from a pre-fix plugin build.
2. Restart the opencode2 service (the in-memory board is gone; the
   running task tool part in the parent transcript is what re-registers
   the job).
3. Send any message in the parent session (this fires the transform that
   rehydrates persisted running lanes and the existence probe).
4. Assert the probe clears it: the board's next snapshot no longer lists
   the task under `#### Active / Unreconciled` — it settles through the
   probe's reconcile (`session.get` outcome → terminal state, same
   `updateStatus` semantics as §2) or, for a session deleted while the
   plugin was down, tombstones and drops. A task still stuck after
   parent activity is a failure.

## 5. Known limitation: late-arriving host outcome

A host outcome that becomes attributable **later than the gate's evidence
read cadence** (after the retry budget is exhausted and no further events
arrive) strands the job at `running` until the parent's next activity
rehydrate (§4) reconciles it. This is documented known behavior on this
branch, not an unnoticed defect: the parked probe test
`test.skip('probe: late-attributable outcome after exhaustion terminalizes
the stranded board')` in `src/terminal-gate.integration.test.ts` records
the dead end (the gate consults `session.get` only twice in that scenario,
and neither a later idle pair nor a busy→idle contrast cycle re-arms an
outcome read). When verifying §2, do not read a slow-publishing child as
this limitation unless the attribution log shows the retries exhausted;
conversely, if it reproduces live, record it against this section.

## 6. DB read-only cross-check

Cross-check that the host had actually committed the terminal evidence the
gate attributed (read-only; never open the live DB read-write):

```bash
sqlite3 'file:<data-dir>/opencode.db?mode=ro' \
  "select id, idle_outcome, time_idle from session_v2 where id='<child-session-id>'"
```

- `<data-dir>` is the host data directory (`~/.local/share/opencode` on
  Linux/macOS); the file may be channel-suffixed (`opencode-<channel>.db`)
  or overridden by `OPENCODE_DB` — `ls <data-dir>/*.db` to find it.
- `session_v2.idle_outcome` carries the host's terminal outcome
  (`succeeded` / `failed` / `interrupted` / `cancelled`) and
  `session_v2.time_idle` the idle transition (integer epoch ms).
- Expect `idle_outcome='succeeded'` and a `time_idle` that falls inside
  the accepted attribution window logged by
  `[terminal-gate] host-outcome attribution` (`windowLower` <
  `time_idle` ≤ `windowUpper`) for §2's child — the DB row is the ground
  truth that the evidence existed on the host side, independent of the
  plugin's own logs.
