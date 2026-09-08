# Concurrent support tasks

2026-09-07. Added a controlled-runner acceptance check through the existing support host and
real RPC clients. Four provider runs overlap: three owned by Alice and one by Bob. The healthy
Alice/Bob requests deliberately reuse the same request ID and receive different run IDs.

Cancelling one Alice run and failing another does not cancel the healthy siblings. Each account
receives its own progress and live text, and only its own runs/results. Bob cannot cancel Alice's
run. After cancellation the fixture deliberately reports/emits/resolves late output; the client
keeps cancelled state with no result and receives no late text. Both healthy siblings complete.

Two more runs remain pending when the host closes with clients connected. Both contexts observe
cancellation, and the provider cancel hook is called once for each, without cancelling completed
or failed siblings again. The fixture finally settles its intentionally non-cooperative promises.
The test proves cancellation signalling and output fencing, not forced termination of provider
work or that host.close awaits a provider ignoring cancellation.

Existing library and example implementations passed. No defect fix, API change, real model,
credential, throughput measurement or durable/distributed scheduling was introduced.

Verification: source check, full build, installed strict support types and all transport/lifecycle/
concurrency/business/client checks passed. Existing core lifecycle tests already covered throwing
cancel hooks; this wave adds the missing overlapping product journey rather than duplicating them.
