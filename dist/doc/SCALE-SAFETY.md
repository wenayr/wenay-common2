# Scaling safety: ownership, partitions and fencing

The scale tier selects an authority and serves its state through nodes. Its local role is not
a distributed lock. This page separates the guarantees already exercised from host integration
that still depends on the application's durable resource.

## Existing seams and their meaning

| Surface | Meaning | What it does not establish |
| --- | --- | --- |
| StoreReplicaSet canWrite() | The local replica is an open leader; teardown rejects immediately | A remote authority has not acquired newer ownership |
| leadership.elect(context) | The host returns a higher epoch and optional opaque proof, or declines | A built-in quorum, lease refresh or lease expiry mechanism |
| leadership.accept(descriptor) | Host policy accepts a discovered remote descriptor | A per-command check of this process's own certificate |
| autoPromoteMs | Availability after losing a route | Proof that the old writer is dead |
| Authority control.promote() | Awaited promotion synchronizes the control/roster ownership facets | Fencing already-started external operations |
| Command receipts | Deduplication of retained, committed account/request IDs | An atomic transaction with an arbitrary external effect |

The API has no leaseUntil field. Proof is opaque and its interpretation belongs to the host.
A process born as leader does not obtain a certificate through elect first. A host requiring
certified ownership must start as standby and obtain it through the existing promotion path.
The host must refuse ownership acquisition when its coordinator cannot establish exclusivity.
A timeout by itself is insufficient evidence.

## Where a safe write ends

1. The host obtains ownership from its actual coordination resource. The epoch/token must not
   be reused after that resource or an authority restarts.
2. At command admission, capture that generation's certificate. Refuse new work if ownership
   cannot be verified. Do not replace a captured old certificate with a fresh one after awaiting.
3. At the receiving resource, atomically validate the certificate, enforce the request identity,
   apply the effect and record its result. An in-memory check followed by an unrelated write
   leaves a race. Advancing the resource's fence must precede accepting the successor's effects.
4. Publish the committed state through the existing Store/replay layer. Recovery reads the
   resource's committed result; a lost RPC response can then retry without applying it twice.

Raw Store mutation is available to application code and bypasses any command wrapper. Confine
business writes to the command corridor. Long operations must validate at their final resource
boundary, including operations admitted before a demotion or a network split. Time-limited
leases also require host renewal/expiry policy and resource enforcement; elect/accept do not
provide those automatically.

## Executable evidence

- [scale-partition.spec.ts](../oracle/realsocket/scale-partition.spec.ts): two authority socket
  servers, a severed inter-authority link and clients still reaching both. Negative control:
  both leaders accept divergent writes. With a local fixture arbiter and atomic fixture sink,
  stale admission and an old in-flight commit are rejected; retry is deduplicated; healing
  converges the old replica onto the accepted successor.
- [scale-authority-ownership.test.ts](../observe/scale-authority-ownership.test.ts): old node-link
  registry commands are refused after demotion, re-promotion and close; external cleanup cannot
  admit new commands during authority teardown.
- [store-replica-election-races.test.ts](../observe/store-replica-election-races.test.ts): a late
  declined election cannot overwrite an established role; canWrite closes before external cleanup.
- `experiments/wenay-scaffold/multiprocess-check.ts` (repository checkout): one authority,
  two serving nodes and a consumer in four processes, node death/restart and reconnect.

Run the partition oracle with node --import tsx oracle/realsocket/scale-partition.spec.ts.
All three new oracles enter the ordinary release gate by file convention. The partition arbiter
is deliberately a local test fixture, not a production coordinator or durable database. It is an
integration example; it must not be copied as a distributed lease service.

## Deployment boundary still requiring a real environment

The repository's K8s experiment discovers and drains serving nodes behind one external leader.
It currently contains no business-write Lease adapter. A real multi-authority acceptance run
requires the chosen durable/coordination service, its atomic write adapter, independently failing
processes or machines, and controlled loss of access to that service. Test paused old owners,
coordinator restart, lost commit replies and minority partitions there before declaring the
installation safe. Local socket and process checks do not replace that acceptance test.

For project construction and the distinction between read fan-out and write partitioning, see
[LIBRARY-ASSESSMENT.md](LIBRARY-ASSESSMENT.md).

## Acknowledged commands and receipt delivery

A successful response confirms local command completion, not replication of its receipt to a
standby. If the authority dies before delivery, an already acknowledged request may execute
again on the successor. The same applies after receipt expiry/eviction or a solo restart whose
control line was not durably stored. Only delivered and retained receipts deduplicate there.
This is separate from the in-flight-effect window; both require resource-side atomicity for a
stronger guarantee.
