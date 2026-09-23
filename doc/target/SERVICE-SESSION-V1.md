# SC1 v1: proposed public contract

Status: approved and implemented for 2.19.0, September 10, 2026.
The public contract is now documented in [SERVICE-RESOURCES](../SERVICE-RESOURCES.md).
The following records the agreed design; H1/H2 and consumer D remain separate.

## Public surface

Keep the proposed optional `definition.resources` registry. Each entry has
`allow: readonly string[]`, `placement: 'authority'` and
`open(context) -> {facade, close} | Promise<{facade, close}>`. `facade` is an object;
`close` returns void or Promise<void>. No client factory arguments or code loading.
Use the existing `tServiceDefinition` and exact inference from the concrete definition.

Export the shared entry/context contracts as `ServiceResourceDefinition` and
`ServiceResourceContext` from `wenay-common2/service`. The implementation remains
behind the existing service/client, service/server and service/host entrypoints.
No new mandatory dependency or public general-purpose RPC scope factory in v1.

Context fields:

- `principal`: detached verified account/current roles, read-only to the factory.
- `sessionId`: server-generated authenticated transport-session identity.
- `resourceId`: server-generated identity unique to this resource generation.
- `signal`: cooperative cancellation for this resource generation.

`resourceId` is the one addition to the proposed factory context. Two independent
opens within one transport session must not publish into the same peer owner journal.
The peer example therefore calls `room.connection(resourceId)`. `sessionId` remains
available for session correlation; neither identity is supplied by the handshake.
Reconnect, role replacement and a new open produce a new resourceId, including after
an authority restart. Renewing an unchanged principal preserves both resource and ID.

The client surface is synchronous ownership creation:

```ts
const resource = client.resources.open('boardPresence')

resource.status // stable Store<{phase, generation, error}>
resource.current() // {generation, remote} in ready; otherwise null
await resource.close() // immediate logical close, bounded physical cleanup
```

`phase` is `opening | ready | offline | denied | failed | closed`.
`generation` is a monotonically increasing number local to the controller; it is not
an authorization credential or a globally unique identity. `error` is null or a safe
`{code, message}` without server stack, token or arbitrary factory data. `remote` uses
the existing RPC client projection, inferred from the selected entry's awaited facade.
Wrong resource names, methods and arguments fail compilation. Do not flatten facade
facets or introduce a second manually maintained remote interface.

Each open creates a separate owner. `status` and the controller stay identical across
same-account reconnect; every ready generation has a fresh, generation-bound remote.
An old remote cannot address the new generation, including through a saved raw RPC path.
There is no implicit current-generation alias behind that remote.

`close()` is terminal and returns the same completion Promise on repeated calls.
It clears current() and sets closed immediately. Cleanup failure/timeout rejects that
Promise and stays observable in status.error; internally initiated close observes the
Promise too. Late cleanup diagnostics cannot restore availability.

Do not add a retry method in v1: after `failed`, the UI closes this controller and
performs a new open explicitly. `offline` and `denied` recover automatically for an
open same-account controller once transport/admission returns. Account replacement
terminally closes all controllers belonging to the previous account.

## Permissions, placement and ownership

The descriptor adds optional `resources` metadata: names, allow lists and authority
placement only. Existing descriptors without that field remain valid. The browser
imports descriptor data and server-definition types only; factories/seed state and
Node code never enter the bundle.

Extend the authenticated permissions facts with resource-name permissions while
accepting absence from an older peer as no resource support. Source compatibility of
existing `ServicePermissions` object literals must be retained (optional added field).
These facts inform UI availability; authority always authorizes the request itself.

Resources use the authority connection independently of ordinary view placement.
They share existing RPC/token machinery, without exposing the client's private hub.
Clients with no resources declared/opened acquire no additional resource infrastructure.

Compare verified account and normalized role membership. Same account/roles with a
renewed token updates the deadline and preserves the instance. Changed roles close the
old generation even if admission remains allowed. Revocation, expiry, disconnect,
account replacement and host close invalidate admission before beginning disposal.
The runtime owns only a successfully returned {facade, close}; partial allocations
before a factory throws remain the factory author's responsibility.

Opening and cleanup are bounded on both sides. Initial proposed defaults are 10 seconds
for opening and 2 seconds for cleanup, configurable through optional
`resourceOptions: {openTimeoutMs?, closeTimeoutMs?}` on service host/client dependencies.
Budgets cover those operations independently of the existing whole-host startup budget.
A client timeout invalidates its generation and requests cancellation; a server timeout
invalidates the scope and observes/disposes any late factory result. A cleanup timeout
reports unconfirmed cleanup, never that external work was forcibly stopped.

Original factory/disposer errors are observable to the server owner through the
outward `leader.resources.errors` Listen, with resource name/ID and phase. They are not
sent verbatim to clients. One scope's cleanup error must not skip another's disposer.
Keep primary startup failure distinct from any cleanup diagnostic.

## Implementation corridors and SC1-A gate

1. **RPC scope ownership, internal:** attach scope provenance during static and dynamic
   route resolution, including numeric method references and PIPE traversal. Check
   liveness at admission, after pending admission and before each later effect/delivery
   boundary. Gate callbacks and successful responses after await; no late private result.
2. **RPC subscription owner:** extend the existing adapter registry's ownership key
   beyond just source identity. Shared underlying Listen sources can belong to different
   scopes. Revocation removes only the target scope's subscriptions, including noStrict,
   and releases a handle acquired after cancellation. Do not close the shared source.
3. **Service authority/session owner:** static registry, verified principal/deadline,
   factory lifecycle, generation identity, permissions and bounded disposal.
4. **Service client owner:** controller state and fresh RPC surface per generation,
   bound to the authority and integrated with existing token/account lifecycle.

Current code has the relevant primitives, but not the required composition:
`rpc-server.ts` guards pending onRequest against principal changes, then sends CALL/PIPE
results after await without a resource-generation boundary. `rpc-server-auto.ts` owns
Listen wrappers in a source-keyed registry; principal pruning deliberately cannot find
dynamic noStrict subscriptions. Neither deleting a service name nor calling the peer
connection disposer closes this gap. No application-side recursive protective Proxy.

SC1-A must establish the scope invariant independently before implementing the service
layer. If provenance cannot be preserved for a supported RPC path, fix that corridor
or reject the operation explicitly; do not claim protection based on a client guard.

## Verification and scope

Use the user's A1-A5, B1-B8, C1-C5 and T1-T2 matrix, with Promise barriers, controlled
primitive time and deterministic event sequences. First plain methods/Listen/noStrict,
then a protected counter, then peer; finally real Socket.IO plus one serving node.
Check server ownership counts through test-only diagnostics. Retain PC1/PC2, all
service/RPC compatibility checks and a definition with no resources.

Keep A/B/C in common2. D/browser organizer adoption belongs to wenay-examples and
requires a published exact dependency; publication alone is not a collaborative-board
acceptance. H1/H2, direct WebRTC revocation and hot code loading remain outside SC1 v1.
Tests/builds run sequentially under the requested resource budget.

Decision requested: accept these public names and additions (resourceId, status.phase,
explicit new-open retry, resourceOptions, optional permissions.resources and host errors)
before implementation. The remainder follows the user's lifecycle and revocation model.
