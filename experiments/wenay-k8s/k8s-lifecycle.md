# wenay-k8s lifecycle — pod termination without client gaps

## The shape

1. `kubectl delete pod` / scale-down / rollout: K8s marks the pod Terminating — the endpoints
   controller pulls it from Endpoints, kubelet runs `preStop`, then sends SIGTERM.
2. Two independent announcements of the departure reach the directory; either alone suffices:
   - **discovery path** — the feeder sees `deletionTimestamp` and calls `drain(nodeId)`;
   - **self path** — the process's SIGTERM handler enters the node's own leave path, which
     publishes the same draining fact.
3. The **library** performs the actual move: a draining row drops out of `directoryReplicaOffers`,
   and every client's replica set leaves that node by seq (`syncStoreReplayRoute` hand-off) —
   gap-free by construction. Already proven without K8s: `observe/node-directory.test.ts`
   (balance part) and live on the demo stand (plan step 1), re-proven here in `self-check.ts`.
4. **Grace**: the node keeps serving while clients move. This is exactly the library's
   `Observe.createStoreNode` (`src/Common/Observe/store-node.ts`) leave path — `leave()`:
   draining fact → grace timer → `goodbye`
   (remove own row) → `deps.onLeave` → the host exits the process. The same node already leaves on
   its OWN directory row (`watchOwnRow`: drain is data, no control channel), so
   `kubectl delete pod` and the panel's Drain button are the same mechanism.
5. Exit 0 before the grace period ends. `terminationGracePeriodSeconds` must exceed
   leave-grace + hand-off time (the demo grace is 2 s; the chart should leave generous margin).

`preStop` may additionally hit an admin drain endpoint, but SIGTERM alone is sufficient because the
handler drains self — the hook is belt-and-braces for images where signal delivery is unreliable.

## Lease election — TODO on the library's seam (deliberately not stubbed)

`createStoreReplicaSet` keeps election injectable on purpose (no consensus hidden inside Store, per
ROADMAP): `leadership.elect(ctx)` must return an epoch above every observed epoch plus an opaque
`proof`, and `leadership.accept(descriptor)` validates a claimed leader
(`src/Common/Observe/store-replica-set.ts`).

The adapter will map a `coordination.k8s.io/Lease` onto that seam:

- `elect` — acquire/renew the Lease; derive the epoch from the Lease's monotonic transition count
  (satisfying the "above maxObservedEpoch" contract), carry `holderIdentity` + generation as `proof`;
- `accept` — verify the descriptor's proof against the currently observed Lease holder, so a node
  that lost the Lease cannot keep asserting leadership.

No stub code ships in this skeleton on purpose: a fake `elect` would silently bypass the very seam
this package must prove against a real Lease. It lands with the kind/minikube stand (plan step 6c).
