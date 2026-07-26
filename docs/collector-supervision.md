# Collector Supervision

The **collector** is a long-lived Node process that receives hook events and keeps
them flowing to the dashboard. Supervision exists to guarantee one property:

> **Exactly one healthy collector per data root — no duplicates, no silent absence.**

This document is the contract. The shell primitives that implement it live in
`hooks/scripts/supervision/lib/`; the read-only diagnostic is
`hooks/scripts/supervision/observe-health.sh`. The collector's own half lives in
`app/server/src/supervision/`, one TypeScript module per shell file.

> **Status:** the collector claims the lock, publishes the heartbeat, and reports
> the health predicate on `/api/health`. The shell supervisor arm can attach,
> start, restart, and stop that collector. `hooks/scripts/hook.sh` now writes
> every raw event to the durable spool first, then arms the collector via the
> supervisor when the health predicate is false. The spool consumer normalizes
> raw hook entries with the same agent-specific builders
> (`hooks/scripts/lib/agents/`) the old per-hook `observe_cli.mjs` path used,
> then commits to SQLite directly — no HTTP round trip. That CLI `hook` command
> still exists as a last-resort fallback for the rare spool-write failure.

## Two implementations, one contract

The collector is a long-lived Node service, so it reads and writes this state
in-process rather than shelling out on every heartbeat tick. That means the same
rules exist twice — once in bash, once in TypeScript:

| Shell                                   | TypeScript                              |
| --------------------------------------- | --------------------------------------- |
| `lib/observe-env.sh`                    | `app/server/src/supervision/paths.ts`   |
| `lib/observe-process.sh`                | `.../process-identity.ts`               |
| `lib/observe-lock.sh`                   | `.../lock.ts`                           |
| `lib/observe-heartbeat.sh` (publishing) | `.../heartbeat.ts`                      |
| `observe_collector_healthy`             | `.../health.ts`                         |
| —                                       | `.../collector.ts` (lifecycle)          |

Two implementations of one contract drift unless something keeps them honest, so
the collector's tests run the *shipped shell code* against state the TypeScript
side produced: every health status, every data-root safety rule, and the heartbeat
field reader are asserted to agree. If a change makes them disagree, those tests
fail rather than the two halves quietly diverging in production.

## Vocabulary

| Term            | Meaning                                                                          |
| --------------- | -------------------------------------------------------------------------------- |
| **collector**   | The long-lived process being supervised. It stays alive; exiting is a fault.      |
| **data root**   | One supervised instance's namespace. `AGENTS_OBSERVE_DATA_ROOT`.                  |
| **instance id** | Identifies one collector *run*. Restarting produces a new instance id.            |
| **heartbeat**   | A record the collector republishes to prove it is still working, not just alive.  |
| **lock**        | A directory whose existence + recorded identity make the singleton claim true.    |

## Runtime layout

Everything supervision owns lives under the data root, so two data roots can never
touch each other's state:

```
$AGENTS_OBSERVE_DATA_ROOT/runtime/
  collector.lock/            singleton lock, held for the collector's whole life
    pid                      recorded owner PID; creating it is the claim
    pid-identity             PID + process start time + executable
    executable               resolved executable path
    entrypoint               stable entrypoint marker expected in the command line
    data-root                the data root this lock belongs to
    instance-id              this collector run
    started-at               epoch seconds the lock was claimed
  collector-start.lock/      held only across a start attempt
  collector.heartbeat        one key=value per line — see below
  collector-lifecycle.log    append-only diagnostic ledger
  spool/                     durable event queue
    pending/                 accepted entries awaiting a SQLite commit
    processing/              entry currently being committed; recovered on restart
    failed/                  entries that exhausted commit retries
```

`AGENTS_OBSERVE_DATA_ROOT` falls back to `AGENTS_OBSERVE_LOCAL_DATA_ROOT` (the data
dir override `hooks/scripts/lib/config.mjs` already reads) and then to
`~/.agents-observe`, so supervision state lands beside the database by default
instead of in a second location.

## Configuration

| Variable                            | Default                    | Purpose                                     |
| ----------------------------------- | -------------------------- | ------------------------------------------- |
| `AGENTS_OBSERVE_DATA_ROOT`          | see above                  | The supervised instance's namespace         |
| `AGENTS_OBSERVE_HEALTH_GRACE`       | `30`                       | Heartbeat freshness window, seconds         |
| `AGENTS_OBSERVE_START_TIMEOUT`      | `15`                       | Wait for a new collector to confirm, seconds|
| `AGENTS_OBSERVE_START_POLL`         | `0.2`                      | Poll interval while confirming, seconds     |
| `AGENTS_OBSERVE_COLLECTOR_ENTRYPOINT` | *(empty)*                 | Optional collector executable for the arm   |
| `AGENTS_OBSERVE_ENTRYPOINT_MARKER`  | `agents-observe-collector` | Stable marker expected in the command line  |
| `AGENTS_OBSERVE_HEALTH_URL`         | *(empty)*                  | HTTP health endpoint; empty = leg skipped   |
| `AGENTS_OBSERVE_LOCK_SETTLE`        | `2`                        | Grace for a lock still being written, seconds|
| `AGENTS_OBSERVE_PROC_ROOT`          | `/proc`                    | Where process identity is read from         |
| `AGENTS_OBSERVE_HEARTBEAT_INTERVAL_MS` | `5000`                  | How often the collector republishes         |
| `AGENTS_OBSERVE_INSTANCE_ID`        | *(a fresh UUID)*           | Pin the instance id for this run            |

`AGENTS_OBSERVE_HEALTH_URL` is still empty by default. Point it at
`http://127.0.0.1:<port>/api/health` to turn the shell diagnostic's HTTP leg on;
the collector's own predicate has nothing to check, because a caller reading it
over HTTP has already exercised that leg.

## Invariants

**1. A PID is never proof of ownership.**
PIDs get reused. Ownership requires the recorded identity — PID + process start
time + executable — to still match the live process, *and* the live process to
carry the recorded entrypoint marker. The marker is deliberately not the full
command line: argv changes across restarts, and matching it whole would make every
ordinary restart look like an impostor.

**2. Locks are claimed atomically, in two stages.**
`mkdir` creates the lock directory — mkdir(2) either creates or fails with EEXIST,
with no window in between, and stays atomic over NFS and most shared filesystems.
The owner is then claimed by creating `pid` under `set -C` (noclobber), which makes
bash itself open the file with `O_CREAT|O_EXCL`. Exactly one process wins that.
There is no check-then-write path anywhere in the kernel.

The second stage is not belt-and-braces. `mkdir` is whatever `/usr/bin/mkdir` the
host ships, and that is not always race-correct: Ubuntu 25.10's uutils coreutils
0.8.0 `mkdir` reports **success to several concurrent creators of the same
directory** (the identical race under perl's `mkdir(2)`, or under the noclobber
write, has exactly one winner). A singleton guarantee that rests on the host's
`mkdir` binary is not a guarantee. Stage 2 runs inside bash, so correctness does
not depend on any external binary.

**3. Age is never evidence of abandonment.**
A lock is abandoned only when its owner is *provably* gone: no usable PID, a dead
PID, or a live PID whose identity no longer matches. A healthy collector that has
been up for a week holds a week-old lock; reclaiming it for looking old would kill
the thing the lock protects.

**4. Fresh is not enough — it has to be ours.**
The heartbeat carries the same `instanceId` as the lock. A fresh heartbeat from a
*different* instance is not health; it means two collectors are alive in one data
root, and it is reported as an ownership error rather than quietly accepted.

**5. Signals are addressed by identity, never by pattern.**
`observe_signal_locked_process` re-verifies the lock's identity before it delivers
anything. There is no `pkill -f` path: a pattern match would hit every data root's
collector on the machine, not just this one's.

**6. Data roots are isolated.**
Every runtime path is derived from the selected data root. Unsafe roots (empty,
relative, `/`, containing `..`, or containing a newline or tab) are rejected before
any path is built.

**7. The diagnostic never mutates.**
`observe-health.sh` reads and reports. It does not signal, reclaim, repair, or even
create the runtime directory — a diagnostic that mutates changes the answer it was
asked to report.

**8. Shutdown only ever releases what this instance still owns.**
Before removing anything, the collector checks that the lock still names its own
`instanceId` *and* this data root. If it does not, a successor owns the data root
and shutdown touches nothing at all — not the lock, not the heartbeat. A collector
that was declared abandoned and replaced must never delete its replacement's state
on its way out, and that is one condition rather than several so it cannot be half
enforced.

## Collector lifecycle

### Supervisor arm

`observe-arm.sh <attach|start|restart>` is the calling-side supervisor. It is
separate from the collector process and starts the server detached, so returning
from the arm never tears down a confirmed collector. `observe-stop.sh` is the
matching graceful stop command. Each decision and outcome is appended (best
effort) to `collector-lifecycle.log`; the ledger is diagnostic only and never a
source of ownership truth.

- `attach` reports success only when `observe_collector_healthy` succeeds. It
  reports the lock's PID and instance id and never spawns a process.
- `start` is idempotent: a healthy owner is attached to. Otherwise it waits up
  to `AGENTS_OBSERVE_START_TIMEOUT` for `collector-start.lock`; this bounded
  wait is the explicit concurrent-start policy. Once it owns that lock it checks
  health again, reclaims only a lock that `observe_collector_lock_is_abandoned`
  proves abandoned, and starts one collector. It reports `started` only after
  the canonical predicate succeeds for that newly spawned PID (including the
  optional HTTP health leg).
- `restart` sends `TERM` through `observe_signal_locked_process`, waits for the
  collector to release both its lock and heartbeat, then follows `start`. With
  no live owner it is simply `start`.
- `observe-stop.sh` likewise signals only an identity-matched owner and waits
  for that collector to clear its own files. It never removes lock or heartbeat
  files itself. A data root with no live owner is a clean no-op.

`observe-status.sh` is deliberately a thin wrapper over `observe-health.sh`.
It does not add a "start in progress" state: a held start lock says nothing
about collector ownership or working health, and health remains exactly the
canonical predicate below.

**Startup.** Claim the lock *before* opening the database or the port, write the
identity metadata, then start the heartbeat timer once the things it reports on
exist. Refusal is immediate and deterministic: if another live, identity-matched
collector already owns the data root, the process exits **3** with a message
naming the lock. It does not wait, retry, or take the lock away — waiting would
leave two half-started collectors racing whenever the first one is slow. A lock
whose owner is *provably* gone is reclaimed first, and that judgement belongs
entirely to `observe_collector_lock_is_abandoned` (and its TypeScript mirror);
nothing in the server second-guesses it.

**Running.** A background timer republishes the heartbeat every
`AGENTS_OBSERVE_HEARTBEAT_INTERVAL_MS`, sampling the database and the HTTP
listener each tick so the heartbeat proves the collector is *working*, not merely
alive. The listener also republishes once as soon as it binds.

**Shutdown.** SIGTERM/SIGINT run, in order: stop the heartbeat, stop accepting new
work, close HTTP and WebSocket, close the database, then release the heartbeat and
the lock under invariant 8. Every other exit path — the idle auto-shutdown, a bind
failure — goes through the same ownership-checked release via `process.on('exit')`.

| Exit | Meaning                                                     |
| ---- | ----------------------------------------------------------- |
| `0`  | Graceful shutdown; lock and heartbeat released.             |
| `2`  | Unusable supervision configuration (no safe data root).     |
| `3`  | Another live collector already owns this data root.         |

## Heartbeat file

One `key=value` per line, written to a temp file and renamed so a reader never
sees a half-written record:

```
schemaVersion=1
instanceId=6f2d…
pid=48213
startedAt=1785076398
updatedAt=1785076403
databaseHealthy=true
httpHealthy=true
lastCommittedEventId=
spoolPending=
```

It is deliberately **not** JSON: the shell reader that ships with the kernel is
line-oriented, and a JSON file would be unreadable to `observe-health.sh`. The
field set is the one the supervision plan specifies, and `/api/health` renders
exactly these fields as JSON — which is where a JSON shape belongs.
`lastCommittedEventId` is the stable id of the most recently SQLite-committed
spool entry (empty until the first commit). `spoolPending` is the current count
of entries awaiting commit, including an entry in `processing`. Failed entries
are retained under `spool/failed` and do not contribute to that count.

## Health predicate

The collector is healthy when **all** of these hold:

1. the lock exists, and
2. it belongs to this data root, and
3. its recorded PID is alive, and
4. the live process identity matches the recorded identity, and
5. the live process carries the recorded entrypoint marker, and
6. the heartbeat's `instanceId` matches the lock's, and
7. the heartbeat is within the grace window, and
8. the HTTP health check succeeds — when one is configured.

The HTTP leg is unconfigured by default, so it reports `skipped` and does not fail
health. Setting `AGENTS_OBSERVE_HEALTH_URL` turns it on with no API change.

The collector computes the same predicate in-process and adds one condition the
shell cannot express: the lock must name *this* instance. `observe-health.sh` has
no caller identity, so it can only ask whether *a* collector is healthy here; the
collector can also ask whether that collector is itself, and reports
`invalid-owner reason=instance-mismatch` when it is not.

## Reading it over HTTP

`GET /api/health` carries a `collector` block — `null` when supervision is not
running:

```json
{
  "ok": true,
  "collector": {
    "schemaVersion": 1,
    "instanceId": "6f2d…",
    "pid": 48213,
    "dataRoot": "/home/you/.agents-observe",
    "startedAt": 1785076398,
    "updatedAt": 1785076403,
    "databaseHealthy": true,
    "httpHealthy": true,
    "lastCommittedEventId": null,
    "spoolPending": 0,
    "status": "healthy",
    "reason": null,
    "heartbeatAgeSeconds": 0
  }
}
```

`status` and `reason` are the predicate; the rest is the heartbeat this instance
last published. The block deliberately does **not** drive `ok` or the HTTP status
code — that endpoint is how the CLI decides the server is up, and turning it into
a 503 over a momentarily stale heartbeat would make a supervisor restart a server
that is serving traffic perfectly well.

## Diagnostic output

```
$ hooks/scripts/supervision/observe-health.sh
collector: healthy pid=48213 heartbeat=3s http=ok
collector: absent
collector: unhealthy reason=stale-heartbeat pid=48213
collector: invalid-owner reason=pid-identity-mismatch pid=48213
```

| Exit | Meaning                                                                    |
| ---- | -------------------------------------------------------------------------- |
| `0`  | Healthy.                                                                   |
| `1`  | Absent or unhealthy. A supervisor may start or restart the collector.      |
| `2`  | Invalid configuration, or an unsafe ownership state — do **not** act blindly.|

Reasons, and why each lands where it does:

| Status          | Reason                  | Exit | Meaning                                              |
| --------------- | ----------------------- | ---- | ---------------------------------------------------- |
| `unhealthy`     | `dead-pid`              | 1    | Owner went away; the lock is reclaimable.            |
| `unhealthy`     | `missing-heartbeat`     | 1    | Process is up but has never reported working.        |
| `unhealthy`     | `stale-heartbeat`       | 1    | Process is up but wedged.                            |
| `unhealthy`     | `http-unhealthy`        | 1    | Process and heartbeat fine, endpoint is not.         |
| `invalid-owner` | `data-root-mismatch`    | 2    | The lock belongs to a different namespace.           |
| `invalid-owner` | `malformed-lock`        | 2    | No usable PID or identity recorded.                  |
| `invalid-owner` | `pid-identity-mismatch` | 2    | PID reuse — that PID is now somebody else.           |
| `invalid-owner` | `entrypoint-mismatch`   | 2    | Alive, but not the collector.                        |
| `invalid-owner` | `instance-mismatch`     | 2    | Heartbeat and lock disagree — two collectors.        |

## Portability

Process identity prefers `/proc` on Linux and WSL: field 22 of `/proc/<pid>/stat`
is the start time in clock ticks since boot, which — unlike a formatted wall-clock
date — does not re-render when the host clock steps and falsely evict a live
collector. Where `/proc` is absent or unreadable (macOS), identity falls back to
bounded `ps` output under `LC_ALL=C`; the locale pin matters because an identity is
written under one locale and re-read under whatever is ambient later. `/proc` is
always probed, never assumed.
