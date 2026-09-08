# AI support host lifecycle

The isolated live-client shutdown check failed before the migration with an uncaught
`replaySubscribe: live line from seq 0 failed: logical RPC line ended`.

AI support now reuses the private HTTP resource already used by rental and document processing.
Its close path explicitly disconnects namespaces before closing replay sources, starts bounded
transport cleanup and awaits it even when service cleanup fails. Service creation and mounting
are guarded so startup failure cleans up without replacing the original error.

The regression checks occupied-port failure without affecting the existing host, shared close
promise, cancellation of active provider work exactly once, live clients during shutdown,
port reuse and empty state in a replacement host. Existing business checks cover account
isolation, progress, cancellation and reconnection to a living host.

This fixes example resource ownership, not a public library interface. A new in-memory host
needs a fresh session/client: server-issued disconnect stops automatic reconnection. Tasks
are not durable or distributed, and the provider remains a deterministic demo.

Verification: source lifecycle/business checks, full build and installed strict types,
independent HTTP resource, lifecycle, business checks and client journey all passed.
