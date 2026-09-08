# Shared local HTTP host

2026-09-07. Rental and document-processing now share one private scaffold resource:
`experiments/wenay-scaffold/resources/http-host.ts`. The generator supplies a local copy to
each installed example. No library exports or public signatures were added.

## Result

The transport owns Express, HTTP and Socket.IO: `resource.{app,io}`, `control.listen()`,
`view.url()` and shared asynchronous `close()`. A failed bind closes its transport; close
during bind cannot leave a late listener. Active HTTP connections have a configurable shutdown
deadline (default 1000 ms); Socket.IO connections disconnect during shutdown. Reentrant close
from a disconnect callback observes the same completion Promise.

Products still own their routes, identity, RPC keys and service cleanup. Both consumers enclose
product construction, mounting and startup in cleanup handling and preserve the original startup
error. Rental no longer starts when imported or uses an unconditional 300 ms exit timer.
Rental retains all-interface binding and its existing CORS settings; documents remain loopback-only.

## Verification

- Independent facade check: two hosts, occupied port with original EADDRINUSE, concurrent listen,
  close before/during bind, repeated/reentrant close, active HTTP plus WebSocket shutdown and port reuse.
- Document consumer: failed sibling startup leaves the original serving; running work observes
  cancellation on close; repeated close shares completion; a replacement binds the freed port.
- Rental: import exits without starting a server; direct process serves its board; existing
  source self-check passes 23 checks. Installed stand checks cover owned process shutdown/restart.
- Full build passed. Both installed examples passed strict type checking and business/stand checks
  from their packed copies outside the repository. The document package also runs the independent
  shared transport check. Generator consistency and scoped whitespace checks passed.

Product mount/cleanup exception handling was reviewed in source, not tested through an injected
product factory. The shared resource check tests unbound cleanup independently.

## Next exposed boundary

Resolved in the following wave: [DOCUMENT-GRACEFUL-CLOSE-FINDINGS.md](DOCUMENT-GRACEFUL-CLOSE-FINDINGS.md).
The description below records the original reproduction; current lifecycle checks keep the client connected.

A connected FileJob client can receive a logical replay-line end while the transport is still
live when a host closes its product first. With no replay error handler this becomes an uncaught
error. The new consumer lifecycle probe reproduced this against the previous host too; it is not
a new transport regression. Its ownership check now deliberately takes the client offline before
closing the host. The independent resource test retains live HTTP and WebSocket connections.

Next wave should reproduce graceful shutdown with a live product client in a child process,
then verify consumer shutdown ordering and reconnect behavior without suppressing replay errors.
FileJobClient currently has no onError passthrough; any new public seam needs discussion.

This wave consolidates local resource ownership. It does not add durable tasks, deployment,
backup/restore, distributed workers or measured throughput. Those remain separate acceptance gates.
