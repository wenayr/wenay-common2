# Document client graceful shutdown

2026-09-07. Consumer lifecycle correction; no library exports, public types or replay error
handling changed. The shared HTTP resource is unchanged.

## Reproduction and correction

The child-process regression connects alice and bob, starts a pending FileJob, and closes the host
while both clients remain alive. Before the fix it exits with an uncaught error:
`replaySubscribe: live line from seq 2 failed: logical RPC line ended`.

Simply calling transport.close before service.close also failed the same regression. Socket.IO's
installed Server.close invokes namespace socket cleanup before the engine connection closes;
RPC cleanup can therefore send a logical line termination while the client transport is live.

The document consumer now calls `io.disconnectSockets(true)` first. This sends the namespace
disconnect packet before RPC cleanup, so clients enter the disconnected state before replay
sources end. It then starts transport shutdown, immediately closes the service to cancel work,
and awaits transport cleanup in finally. The shared completion Promise remains unchanged.
No replay errors are swallowed, and no new error callback API is introduced.

## Guarantees and limits

- Live account clients survive graceful shutdown; active runner sees cancellation.
- Cleanup remains idempotent and bounded by the existing HTTP resource deadline.
- Freed port accepts a replacement; a fresh authenticated client uploads and confirms a file.
- Server-issued disconnect stops automatic Socket.IO reconnect. A new demo host has a new secret
  and empty data, so clients acquire a fresh session. Durable recovery is not provided.
- Existing offline/online test still checks same-Store reconnect to the same living host.

The regression is isolated in a child process so an uncaught replay failure fails the check instead
of being intercepted or leaking handles into the parent. It waits for deferred error delivery with
both clients alive. The earlier consumer lifecycle test no longer takes its client offline first.

## Verification

Failing-first child regression reproduced both the original and order-only failures; corrected
regression and source business/lifecycle checks pass. Full build and installed document-processing
strict type check, transport/storage checks, graceful child regression, business checks and finite
example pass outside the repository. Generated copies match; scoped whitespace check passes.
