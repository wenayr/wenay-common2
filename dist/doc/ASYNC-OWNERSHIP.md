# Local reconciliation and resource ownership

Since 2.21.0, `createResourceScope` and `createReconciler` are exported from
`wenay-common2` and `wenay-common2/client`. They contain no Node-only IO.
The existing queue, throttle/debounce and service host lifecycle retain their contracts.

## Ownership

```ts
import {createResourceScope} from 'wenay-common2'

const scope = createResourceScope({signal: hostSignal, closeTimeoutMs: 2000})
const agent = await scope.start(async function start(signal) {
    const client = await scope.resource.acquire({
        open: () => connect(signal),
        close: client => client.close(),
    })
    await client.ready()
    scope.resource.own(client.changes.on(onChange))
    return {close: scope.close, client}
})
```

`start(work)` returns the inferred result of `work(signal)`. Failure or cancellation
closes the scope before rejecting with the original startup cause. Cleanup errors
remain observable through `events.errors(error => ...)` and `close()`/`settled()`;
they do not replace the startup error. It does not interrupt arbitrary JavaScript:
use the signal in cancellable IO and register acquisitions before awaiting readiness.

| Surface | Contract |
| --- | --- |
| `resource.own(dispose)` | Register an already acquired resource; returns an idempotent early-release function sharing one promise. |
| `resource.acquire({open, close})` | Reserve ownership before calling `open(signal)`; infer the value and disposer argument. Failed open has no disposer call. A result arriving after abort is disposed before the acquisition rejects. |
| `resource.parallel([dispose, ...])` | Register one explicitly independent group. All its disposers start together and are awaited, including failures. |
| `close()` | Abort synchronously, remove the external abort subscription, then dispose in reverse admission order. Concurrent/reentrant callers receive the same promise. |
| `settled()` | Shared completion of cleanup, without a deadline; can be obtained before close. |
| `events.errors` | Branded Listen subscription to each disposal failure. `close`/`settled` reject with `AggregateError`; observer failures are also retained in that aggregate. |

Dependent entries close sequentially in reverse **admission** order, including
in-flight acquisitions. A parallel group finishes before the next older entry starts.
One failure does not skip other entries. Early release deliberately overrides normal
ordering; its result remains observed by the scope. Do not await a scope's own close
from one of its disposers.

By default there is no close deadline: uncooperative IO can keep cleanup pending.
With `closeTimeoutMs`, `close()` rejects with `ResourceCloseTimeoutError` on timeout;
it does not detach, kill or certify termination of the underlying IO. Cleanup continues
and `settled()` reports its actual result. Repeated `close()` calls keep the original
result even after a timeout. When composing scopes, a disposer must await the actual
child settlement if the parent should guarantee it, rather than only a child's deadline.
Timeouts are finite, nonnegative and at most 2,147,483,647 ms.

`acquire` rejects new admission after abort. `own` after abort immediately schedules
disposal, useful when adapting an already completed external acquisition. If registered
after `settled()` has completed, that new disposal cannot change the earlier promise:
await the returned release function. Use `acquire` for pending IO so the original
close includes its late result. Both open and disposal promises are observed internally;
errors remain available through the public promises and event surface.

## Coalescing reconciliation

```ts
import {createReconciler} from 'wenay-common2'

const worker = createReconciler({
    signal,
    read: () => assignments.snapshot(),
    subscribe: assignments.listen().on,
    async run(snapshot, {signal, retry}) {
        for (const operation of snapshot.operations) {
            if (signal.aborted) return
            try { await provider.reconcile(operation, signal) }
            catch (error) {
                reportPending(operation.id, error)
                retry(operation.id, 5000)
            }
        }
    },
})
worker.events.errors(reportUnexpectedError)
worker.control.request()
```

`read()` runs immediately before each pass, never when the notification arrives.
It must return suitable input; the worker does not clone a live `store.state` reference.
Use `snapshot()` when the pass awaits IO. Store notifications have their own drain;
`control.idle()` waits only for work already admitted to this worker, not future Store
flushes or scheduled retries.

`control.request()` coalesces a synchronous burst and retains at most one pending pass
while IO is active. Passes are serialized through the existing `createAsyncQueue(1)`;
there is no per-notification task queue and no parallelism by retry key. There is no
implicit initial pass; subscribe and call `request` after application readiness.
Notifications delivered from the end of a pass are preserved.

`control.retry(key, delayMs)` and the `run` context's `retry` are the same scheduler.
The caller decides whether an operation can be retried and supplies a positive finite
delay up to 2,147,483,647 ms. There is at most one timer per key; registering the same
pending key again does not postpone it. `control.cancelRetry(key)` removes it.

Any fresh pass clears existing timers. The pass re-registers keys that still need
work, so a successful new snapshot does not leave obsolete retries behind. A pass
that schedules a retry defers its accumulated notifications until a timer fires;
a new notification after the pass may request an earlier fresh reconciliation.
Different keys represent reasons to wake the **same** serial reconciler. They are not
independent operation queues. Providers still reconcile their current assigned work.

An uncaught `read`/`run` error is delivered to `events.errors` and retained by
`view.error()`. It clears notifications accumulated by the failed pass and does not
implicitly retry. An error listener may explicitly schedule a global retry. Listener
exceptions are retained by `view.error()` rather than becoming unhandled rejections.
No default hot retry loop is installed. Expected abort errors during close are not
reported as operational failures.

`close()` aborts the pass, removes the owned subscription, clears timers, prevents
new work and awaits the running pass. The same deadline/`settled()` contract as
the resource scope applies. It cannot terminate a provider that ignores cancellation.
Keep the client's cancellation/transport shutdown compatible with the pass's IO.

## Hosting compositions

The copyable [`agent-orchestration.ts`](../examples/hosting/agent-orchestration.ts)
shows scope ownership, an owned Store subscription and fresh snapshots across IO;
run its `npm run example:agent`.

The consumer-specific [Docker/LXD migration](migrations/hosting-2.21.0.patch) removes
busy/dirty/running state, manual subscription disposal, timer maps and close-promise
bookkeeping from both actual agents. It retains Docker's operation/route retry keys,
LXD's global assignment retry, provider identities and current-state checks before
destructive operations. The migration also puts lock-file initialization inside the
startup cleanup boundary and links descriptor fetch cancellation to the scope.
Network shutdown and the reconciler close form an explicit parallel group so a
pending RPC/gateway request cannot prevent its own connection from being closed.
The lock is released only after that group finishes; early-release handles prevent
duplicate disposal of the previously registered connections.

`scripts/verify-hosting-agents.mjs <hosting-app>` applies the migration to an isolated
source copy, checks both agent types and runs the consumer's existing `agent-check.ts`
and `lxd-check.ts` against the packed library. `--published` repeats those checks using
the exact registry version. The original consumer checkout and its installed npm
packages are not modified. The patch is for the audited September 10 source; review
it before applying to a later app revision. Full application migration remains with
the consuming application. These checks use Docker/LXD protocol fixtures, not a live VM.

These are local orchestration primitives. Provider policy, operation IDs, ownership
checks, distributed leases/fencing and exactly-once external effects are not supplied
by a local queue, receipt or AbortSignal.
