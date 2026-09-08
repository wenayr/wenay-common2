# Hosting active process failure

2026-09-07. The installed hosting journey now kills only the active child PID returned by its
own process inventory, while that child is executing a delayed gateway request. The neighboring
site runs in another owned process. Existing behavior passed; no production implementation or
public API change was needed.

Observed sequence:

1. v1 is replaced by v2 and the old process retires.
2. The owned active v2 child is terminated. Its in-flight gateway request receives 503.
3. Contract records session failed and reopens the previous healthy v1 offer during cooldown.
4. The existing retry policy opens a new v2 process and activates it. The same gateway URL serves
   HTTP 200 with x-release v2, with a different child PID.
5. The neighboring site still serves HTTP 200 through its original process. Unused recovery
   children retire; host close waits for every child to exit.

The fallback assertion uses Contract binding history, avoiding a timing-sensitive requirement
to fetch during the short v1 interval. Final recovery and neighbor responses are checked over HTTP.
The runtime default retry delay is currently 1000 ms; process startup and scheduling add latency.
This is a correctness check, not a measured recovery-time objective or capacity benchmark.

A process crash can interrupt requests and creates an availability gap. No lost request is
automatically replayed by this example. The prior release is reopened from a retained offer;
this is not recovery of its prior in-memory application state. Gateway/host failure, durable
deployment state, multi-machine failover and external side-effect recovery remain separate work.

Verification: source hosting journey, full build, installed strict types and complete hosting
acceptance checks, generated-source consistency and scoped whitespace check passed.
