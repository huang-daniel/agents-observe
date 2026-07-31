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
> start, restart, and stop that collector — in either collector runtime, see
> below. Every agent (Claude Code and Codex alike) reaches it the same way:
> `hooks/scripts/hook.sh` on every lifecycle event. There is no second start
> path. `hooks/scripts/hook.sh` now writes
> every event to the durable spool first, then arms the collector via the
> supervisor when the health predicate is false. It negotiates the spool
> schema against the live collector's heartbeat (see
> [Heartbeat file](#heartbeat-file)) rather than always writing the raw
> representation. The spool consumer normalizes raw hook entries with the same
> agent-specific builders (`hooks/scripts/lib/agents/`) the old per-hook
> `observe_cli.mjs` path used, then commits to SQLite directly — no HTTP round
> trip. That CLI `hook` command still exists as a last-resort fallback for the
> rare spool-write failure.
> Known limitation: the `getSessionInfo` request/response that backfills a
> session's slug (see [README.md](../README.md#architecture)) only fires on
> that legacy fallback path — the spool consumer's `commit()` has no HTTP
> round trip to carry a request back to the hook, so a session that spools
> successfully keeps whatever slug (if any) it already had.

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
| **runtime**     | *What kind of thing* the collector is: a host process, or the managed container.  |

## Two collector runtimes

The same collector runs in one of two places, and the difference is entirely
about how the supervisor can *prove* it is alive:

| Runtime  | The collector is…                        | Proved alive by…                              |
| -------- | ---------------------------------------- | --------------------------------------------- |
| `local`  | a Node process on this host              | PID + start time + executable + entrypoint marker |
| `docker` | the managed container                    | the container name + the instance id it is labelled with |

Neither proof is a matter of taste. A container's PID belongs to its own
namespace: from the host that number is either nobody or somebody else
entirely, so every process leg would report a mismatch on a perfectly healthy
collector. The container equivalent is the container itself — docker allows at
most one live container per name, and the instance id is stamped on it as a
label at `docker run` time, which makes "this container, this run" as specific
as "this PID, this start time".

`observe_resolved_runtime` picks one. `AGENTS_OBSERVE_COLLECTOR_RUNTIME` forces
it; the default, `auto`, uses `local` when `app/server/node_modules` exists —
a checkout that can actually run the server — and `docker` otherwise. That
default is what makes a Claude plugin install work: a marketplace install is a
source-only clone with no dependencies, so there is nothing local to fork and
the container is the collector.

**The data root is shared across the container boundary.** The container is
started with `AGENTS_OBSERVE_DATA_ROOT` and the data root bind-mounted at the
*same absolute path* inside it (`buildSupervisionMounts` in
`hooks/scripts/lib/docker.mjs`). Without that, the hooks would spool events into
a directory the collector cannot see, and every path recorded in the lock would
mean something different on each side.

Two things follow, and both are load-bearing:

- The host creates `runtime/` and the spool directories *before* starting the
  container (`ensureSupervisionDirs`). The container runs as root; anything it
  creates first would be root-owned inside a tree the hooks write to as the
  user, and the next hook could not spool its event.
- The collector chowns the lock and heartbeat to the data root's owner when it
  is root and they disagree (`alignOwnerWithDataRoot`). Otherwise a container
  that died without releasing its lock would strand the data root: removing a
  lock directory needs write access to that directory, which root's `0755` does
  not grant the user.

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
    runtime                  local | docker — which proof of liveness applies
    container                the container name, when runtime is docker
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
| `AGENTS_OBSERVE_COLLECTOR_RUNTIME`  | `auto`                     | `local`, `docker`, or resolve from the checkout|
| `AGENTS_OBSERVE_DOCKER_CONTAINER_NAME` | `agents-observe`        | The managed container's name                |
| `AGENTS_OBSERVE_DOCKER_INSTANCE_LABEL` | `simple10-agents-observe.instance` | Label carrying the collector run |
| `AGENTS_OBSERVE_DOCKER_START_TIMEOUT` | `180`                    | Wait for a container start, seconds         |
| `AGENTS_OBSERVE_DOCKER_STOP_TIMEOUT` | `10`                      | `docker stop` grace before kill, seconds    |
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

In the docker runtime the same rule is enforced with the container's identity: a
running container *named this* and *labelled with this instance id*. A container
name alone would be the exact analogue of a bare PID — reused by the next run.

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

Nor is *not being able to see* evidence. When the docker daemon does not answer,
`observe_container_state` reports `unverifiable` rather than `stopped`, and an
unverifiable owner is never abandoned — `docker inspect` fails identically for
"no such container" and "the daemon is down", and those mean opposite things.

**3a. Abandonment is only ever judged within one runtime.**
Each side can apply only the proof its own runtime gives it: a host process
reads `/proc`, and a collector inside a container can see neither the host's
processes nor the docker daemon. Calling an owner dead because we cannot see it
is precisely how a data root ends up with two collectors, so a cross-runtime
lock is never abandoned by the collector (`lockIsAbandoned`). The host
supervisor, which *can* ask docker, is the one that resolves it — and inside the
docker runtime the container name is itself the proof: running *as* that
container means any earlier run recorded under it has ended.

**4. Fresh is not enough — it has to be ours.**
The heartbeat carries the same `instanceId` as the lock. A fresh heartbeat from a
*different* instance is not health; it means two collectors are alive in one data
root, and it is reported as an ownership error rather than quietly accepted.

**5. Signals are addressed by identity, never by pattern.**
`observe_signal_locked_collector` re-verifies the lock's identity before it
delivers anything, in either runtime: `kill` to an identity-matched PID, or
`docker stop` to an identity-matched container (which is that container's
SIGTERM, and so the same graceful path). There is no `pkill -f` path: a pattern
match would hit every data root's collector on the machine, not just this one's.

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
  reports the lock's owner and instance id and never spawns anything.
- `start` is idempotent: a healthy owner is attached to. Otherwise it waits up
  to `AGENTS_OBSERVE_START_TIMEOUT` for `collector-start.lock`; this bounded
  wait is the explicit concurrent-start policy. While waiting it also watches
  the health predicate, and attaches (ledger outcome `attached-peer-start`) the
  moment a peer's collector becomes healthy — the winner holds the start lock
  until it has *confirmed*, which for docker can be far longer than a peer's
  whole wait, and failing a start that already succeeded turns one slow start
  into a herd of failures. This can never produce a second collector: that path
  starts nothing. Once it owns the lock it checks health again, reclaims only a
  lock that `observe_collector_lock_is_abandoned` proves abandoned, and starts
  one collector — forking the Node entrypoint in the `local` runtime, or handing
  the container start to `observe_cli.mjs start` in the `docker` one, so image
  pulls, version checks, port fallback and bind mounts keep their single
  implementation in `hooks/scripts/lib/docker.mjs`. The docker spawn runs that
  CLI in the foreground and takes its exit status as the verdict, so `spawned`
  means docker accepted and started the requested run rather than "a start
  request was detached"; a failure is recorded as `docker-start-failed`. It
  reports `started` only after the canonical predicate succeeds for the run it
  launched (including the optional HTTP health leg): the spawned PID, or the
  instance id it generated and labelled the container with before starting it.
- `restart` sends `TERM` through `observe_signal_locked_collector` — `kill` in
  the `local` runtime, `docker stop` in the `docker` one — waits for the
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

### Who keeps it alive

The collector shuts itself down when nothing is using it
(`AGENTS_OBSERVE_SHUTDOWN_DELAY_MS`, 30s; `0` disables it). "Using it" means
either a dashboard WebSocket client **or an active agent session**: every event
stored refreshes a consumer entry for its session, and `SessionEnd` drops it
(`app/server/src/consumer-tracker.ts`).

The session half exists because agents work with no browser tab open. Keying the
idle shutdown off dashboard clients alone would let the collector exit
mid-session and be re-armed by the very next hook, over and over. No events
would be lost — that is what the durable spool is for — but the churn is real,
so an agent that is producing events counts as a consumer. Entries expire after
`AGENTS_OBSERVE_SESSION_ACTIVITY_TTL_MS` (5 minutes), which is long enough to
cover an agent thinking or waiting on the user, and short enough that a session
that dies without a `SessionEnd` cannot pin the collector alive forever.

## Heartbeat file

One `key=value` per line, written to a temp file and renamed so a reader never
sees a half-written record:

```
schemaVersion=2
instanceId=6f2d…
pid=48213
startedAt=1785076398
updatedAt=1785076403
databaseHealthy=true
httpHealthy=true
lastCommittedEventId=
spoolPending=
collectorSupportedSpoolSchemas=1,2
collectorBuildId=0.9.13
```

It is deliberately **not** JSON: the shell reader that ships with the kernel is
line-oriented, and a JSON file would be unreadable to `observe-health.sh`. The
field set is the one the supervision plan specifies; `/api/health` renders
these fields as JSON plus two spool-failure fields the heartbeat does not
carry (below) — which is where a JSON shape belongs.
`lastCommittedEventId` is the stable id of the most recently SQLite-committed
spool entry (empty until the first commit). `spoolPending` is the current count
of entries awaiting commit, including an entry in `processing`. Failed entries
are retained under `spool/failed` and do not contribute to that count.
`collectorSupportedSpoolSchemas` is the explicit set of spool record versions
the collector can consume, and `collectorBuildId` identifies the immutable
collector build that published the capability set. Hooks only write a newer
representation after the live collector advertises support for it; otherwise
they retain the schema-1 envelope fallback during a rolling upgrade.

## Health predicate

A `local` collector is healthy when **all** of these hold:

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

For a `docker` collector, legs 3–5 are replaced rather than skipped, and the
substitution is **the heartbeat itself**: the collector republishes it every few
seconds from inside the container, which is strictly stronger evidence than
`docker inspect` — it proves the collector is *working*, not merely that a
container exists. So a fresh heartbeat carrying the lock's instance id is
liveness, and docker is consulted only once the heartbeat stops being
convincing, to say whether the container is wedged (`stale-heartbeat`), gone
(`dead-container`), or unknowable (`container-unverifiable`).

That ordering is also why the hook path stays cheap: `hook.sh` evaluates this
predicate on *every* event, and a healthy containerized collector costs zero
subprocesses to confirm.

The collector computes the same predicate in-process and adds one condition the
shell cannot express: the lock must name *this* instance. `observe-health.sh` has
no caller identity, so it can only ask whether *a* collector is healthy here; the
collector can also ask whether that collector is itself, and reports
`invalid-owner reason=instance-mismatch` when it is not.

There is one asymmetry the other way, for the same reason: a collector inside a
container cannot run `docker inspect`, so it can only vouch for a docker lock
that names its own instance. Any other container's lock is reported
`container-unverifiable`, and the host resolves it.

## Reading it over HTTP

`GET /api/health` carries a `collector` block — `null` when supervision is not
running:

```json
{
  "ok": true,
  "collector": {
    "schemaVersion": 2,
    "instanceId": "6f2d…",
    "pid": 48213,
    "dataRoot": "/home/you/.agents-observe",
    "startedAt": 1785076398,
    "updatedAt": 1785076403,
    "databaseHealthy": true,
    "httpHealthy": true,
    "lastCommittedEventId": null,
    "spoolPending": 0,
    "spoolFailed": 0,
    "spoolLastFailure": null,
    "collectorSupportedSpoolSchemas": [1, 2],
    "collectorBuildId": "0.9.13",
    "status": "healthy",
    "reason": null,
    "heartbeatAgeSeconds": 0
  }
}
```

`status` and `reason` are the predicate; most of the rest is the heartbeat this
instance last published. `spoolFailed` (the count of entries under
`spool/failed`) and `spoolLastFailure` (`{ eventId, type, reason }` for the most
recent one, or `null`) are the exception: they are sampled from this instance's
in-process spool consumer directly and are not written to the heartbeat file,
since `observe-health.sh` has no need for them. The block deliberately does
**not** drive `ok` or the HTTP status code — that endpoint is how the CLI
decides the server is up, and turning it into
a 503 over a momentarily stale heartbeat would make a supervisor restart a server
that is serving traffic perfectly well.

The block is also the **capability evidence** the docker start path requires.
`evaluateHealthResponse` in `hooks/scripts/lib/docker.mjs` is the single
acceptance rule behind all three of that file's health checks (the `startServer`
fast path, the running-container recheck, and `waitForHealth`). Whenever a
specific run was requested — `AGENTS_OBSERVE_INSTANCE_ID`, which only the
supervisor sets — accepting the server additionally requires `collector` to be
present, to name that instance and this data root, and to be `healthy`.

`ok:true` at the expected version is *not* evidence of a collector: an image
published before supervision serves `/api/health` exactly as well while never
claiming the lock or publishing a heartbeat, so the shell supervisor can never
confirm it while this side reports "already running" — one version string, two
protocols. That case is rejected as `incompatible-collector`, and unlike the
other rejections it is never retried or restarted: the same image would produce
the same server again. It means the published image and this source tree
disagree, and the fix is a new image built from this source.

## Diagnostic output

```
$ hooks/scripts/supervision/observe-health.sh
collector: healthy pid=48213 heartbeat=3s http=ok
collector: healthy container=agents-observe heartbeat=3s http=ok
collector: absent
collector: unhealthy reason=stale-heartbeat pid=48213
collector: invalid-owner reason=pid-identity-mismatch pid=48213
```

A containerized collector is named by its container, never by the PID in the
lock: that number belongs to the container's namespace and would name an
unrelated process, or none at all, on this host.

| Exit | Meaning                                                                    |
| ---- | -------------------------------------------------------------------------- |
| `0`  | Healthy.                                                                   |
| `1`  | Absent or unhealthy. A supervisor may start or restart the collector.      |
| `2`  | Invalid configuration, or an unsafe ownership state — do **not** act blindly.|

Reasons, and why each lands where it does:

| Status          | Reason                    | Exit | Meaning                                            |
| --------------- | ------------------------- | ---- | -------------------------------------------------- |
| `unhealthy`     | `dead-pid`                | 1    | Owner went away; the lock is reclaimable.          |
| `unhealthy`     | `dead-container`          | 1    | The container that owned this lock is gone.        |
| `unhealthy`     | `missing-heartbeat`       | 1    | Collector is up but has never reported working.    |
| `unhealthy`     | `stale-heartbeat`         | 1    | Collector is up but wedged.                        |
| `unhealthy`     | `http-unhealthy`          | 1    | Process and heartbeat fine, endpoint is not.       |
| `invalid-owner` | `data-root-mismatch`      | 2    | The lock belongs to a different namespace.         |
| `invalid-owner` | `malformed-lock`          | 2    | No usable PID/identity, or no container recorded.  |
| `invalid-owner` | `pid-identity-mismatch`   | 2    | PID reuse — that PID is now somebody else.         |
| `invalid-owner` | `entrypoint-mismatch`     | 2    | Alive, but not the collector.                      |
| `invalid-owner` | `instance-mismatch`       | 2    | Heartbeat and lock disagree — two collectors.      |
| `invalid-owner` | `container-unverifiable`  | 2    | Docker cannot be asked; acting could duplicate it. |

## Portability

Process identity prefers `/proc` on Linux and WSL: field 22 of `/proc/<pid>/stat`
is the start time in clock ticks since boot, which — unlike a formatted wall-clock
date — does not re-render when the host clock steps and falsely evict a live
collector. Where `/proc` is absent or unreadable (macOS), identity falls back to
bounded `ps` output under `LC_ALL=C`; the locale pin matters because an identity is
written under one locale and re-read under whatever is ambient later. `/proc` is
always probed, never assumed.
