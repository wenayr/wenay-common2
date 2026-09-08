# Overlapping hosting updates

2026-09-07. Two concurrent healthy deployments (v1 then v2) produced a rejected first request
before the fix. The product operation spans addOffer, require and binding verification; Contract
orders its individual commands, but that alone does not order a whole product intent. The first
operation could inspect a later binding and misreport a health rejection.

The hosting example now uses the existing public createAsyncQueue with one queue per configured
site. Deploy and rollback share that queue and execute in arrival order for that site. Runtime
selection, health checks, binding generations and lease retirement remain owned by Contract.
No library public interface or Contract implementation changed.

Tests cover two successful overlapping updates with the final gateway on v2; a failed candidate
followed by a successful deploy and rollback; eventual retirement of unused children; and closure
with both preparing and queued work. Queued work rejects before spawning, and shutdown awaits
queue completion and process exits. Existing stable-URL, leased request, rollback and separate-site
checks remain green.

The queues are in memory and unbounded. Separate site queues do not promise parallel runtime
preparation: Contract still owns its own scheduling. Request receipts, durable ordering, admission
limits and distributed coordination remain deployment/product concerns. No throughput or capacity
claim follows from these correctness checks.

Verification: source checks, full build, installed hosting strict types and all acceptance checks,
generated-source consistency and scoped whitespace review passed.
