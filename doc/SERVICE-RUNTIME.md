# Service runtime

Since 2.19.0, [static session resources](SERVICE-RESOURCES.md) add authority-owned factories,
stable client controllers and generation-scoped RPC access. The definition/client/server/host
entrypoints below own this extension; no additional mandatory dependency is required.

Available since 2.18.0. These factories compose the existing RPC, Store Replay, Scale authority,
directory, token codec and HTTP facade. They do not define another transport or command retry policy.
The source of a service contract is its definition, validated with `satisfies tServiceDefinition`.

| Import | Surface |
| --- | --- |
| `wenay-common2/service` | `tServiceDefinition`, `ServiceCommandCtx`, `ServicePermissions`, derived contract types, `SYSTEM_ACCOUNT`, existing `schemaCommand`/input schema helpers, `describeService`, `ServiceClientDefinition` |
| `wenay-common2/service/client` | `createServiceClient`, derived client/command/view types, descriptor helper/types |
| `wenay-common2/service/server` | definition/schema exports, `createServiceLeader`, `createServiceNode`, `createServiceAccess`, `createServiceRest`, `servicePanelPage` |
| `wenay-common2/service/host` | `createServiceLeaderHost`, `createServiceNodeHost`, `runLeaderProcess`, `runNodeProcess`, `installServiceSignals`, `createHostResource`, env helpers and host option types |
| `wenay-common2/server/process` | `createProcessResource`, `ProcessResource`, `ProcessResourceDeps` |
| `wenay-common2/server/blob` | `createLocalBlobStorage`, `createBlobHttpRouter`, `createBlobArtifactStorage`, corresponding storage/access types |

`service` and `service/client` are browser-safe. Server and host imports are Node-only.
The client requires the optional peer `socket.io-client`; the host requires `socket.io` and
`socket.io-client`. The default REST docs page requires the optional peer `swagger-ui-dist`.
These are the same dependencies already used by the scaffold; no new mandatory dependency is added.
Core server composition can be imported without Socket.IO or Swagger installed.

## Definition and descriptor

```ts
import {schemaCommand, type ServiceCommandCtx, type tServiceDefinition} from 'wenay-common2/service'

type State = {count: number}
export const definition = {
    name: 'counter', storeId: 'counter', originId: 'counter', initial: {count: 0},
    commands: {
        add: schemaCommand({amount: 'number'}, {
            apply(ctx: ServiceCommandCtx<State>, input) {
                ctx.state.count += input.amount
                return {count: ctx.state.count}
            },
        }),
    },
    views: {counter: {allow: 'public', project: (state: State) => ({count: state.count})}},
} satisfies tServiceDefinition<State>
```

`describeService(definition)` produces detached JSON data containing only `name`, command names
(values are `null`) and view names/allow lists. It never copies initial state, login credentials,
seed secrets, schema validators, apply/project functions or access resolvers. A phantom type keeps
the definition's exact command arguments/results and projection types through inference.

Run this helper on the server or during a build. Ship the resulting JSON to the browser and bind
its generated type as `ServiceClientDefinition<typeof definition>` using a **type-only** definition
import. A type assertion on externally loaded JSON is not runtime validation or authorization;
serve a trusted matching descriptor. Do not import a server definition as a browser runtime value
and expect calling `describeService` there to remove its seed data from the bundle.

```ts
import {createServiceClient} from 'wenay-common2/service/client'
// descriptor: ServiceClientDefinition<typeof definition>, generated on the server/build side
const client = createServiceClient({definition: descriptor, url, auth: {token}})
const view = client.views.counter
await view.ready
await client.commands.add('stable-request-id', {amount: 1})
client.close()
```

The full definition is also accepted for Node consumers and compatibility with older scaffold calls.

Since 2.18.1, array items use a recursive `tArrayItemSpec`: a scalar, enum, object or another array.
For example, `recipe: {array: {object: {ingredientId: 'string', quantity: 'number'}}}` infers
`{ingredientId: string, quantity: number}[]`, validates every object, and emits OpenAPI `items` with
the same properties, required fields and `additionalProperties: false`. An optional checklist is
`checklist: {array: {object: {title: 'string', done: 'boolean'}}, optional: true}`. Its field may be
absent; its elements cannot be `undefined`, holes or `null`. Optional object properties inside each
element keep the existing field syntax. `optional: true` and scalar `?` are not item specifications.
Errors retain the complete indexed path, such as `input.recipe[0].quantity`; numbers must be finite.
Primitive arrays and the existing schemaCommand argument/result inference remain compatible.

`identity.me()` returns `{account, roles, views, commands}` from current local permissions; anonymous
clients reject. `identity.permissions` is a stable Store of the same facts, with `account: null` when
there is no granted identity. Token/auth events, health, view handles and Store identity retain the
2.17.0 lifecycle. See [RPC-AUTH.md](RPC-AUTH.md) for revocation, saved reference guards, token renewal
and partition limits. A view's one-shot `ready` is not a continuing authorization signal.

## Placement and planned shutdown

The authority already exposes `leader.control.drain(nodeId)` (or its roster control). A controller
marks every node selected for removal **before** stopping any of their processes. Clients observe
directory eligibility changes: they leave withdrawn current endpoints and cancel readiness on
withdrawn pending endpoints. A new registration of the same node id becomes eligible again.

The Node host's `close()` calls the existing `node.leave`, which publishes goodbye before its grace
period closes transports. Process wrappers accept `SIGTERM`, `SIGINT`, and IPC `shutdown` or
`{type: 'shutdown'}`. Use IPC for graceful child shutdown on Windows; a forced child kill cannot run
JavaScript signal handlers or publish goodbye. The pizzeria network check exercises both paths.

Crash candidates still use a 5-second readiness bound, a per-attempt exclusion set and a 15-second
cooldown, followed by authority when eligible. A disconnected authority or control plane cannot
acknowledge drain; this is not a global failure detector. Commands are never retried by this layer.

Moving the **same continuous replay line** can carry its cursor. Different process/session role
projections have independent sequences: the service client switches with `{reset: true, since: -1}`
and installs the new keyframe into the existing Store. No low-level replay semantics changed.

## Server composition and host ownership

`createServiceLeader` maps the definition onto `Scale.createAuthority`: migrations, durable business
state/control archives, command receipts, rate budgets, server-side roles and reserved system
commands remain in their existing corridors. `createServiceNode` adapts the same access policy to
the node mirror. `createServiceRest` builds REST/OpenAPI from that definition and the running leader;
it borrows its Express app and leader. `createServiceAccess` borrows its Store and owns only its
derived projections and session resources. Close these resources through their own public facade.

`createServiceLeaderHost`/`createServiceNodeHost` return an owned host with `close()` and compatible
`shutdown()`. They install no process handlers and never call `process.exit`. The `run*Process`
wrappers additionally install the signal/IPC adapter and remove it on close. They release an owned
IPC channel after shutdown; do not use the process wrapper to compose independent hosts sharing
another owner's IPC channel—use the resource factories there.

Host options extend the existing env/definition options with `origins`, `startTimeoutMs` (10 seconds),
`closeTimeoutMs` (2 seconds), `signal`, and `mount({app, leader|node, url, signal})`. Mount may return
a disposer or a Promise of one. Cleanup is invoked once, awaited within the close budget, and also
runs after failed startup. Cancellation closes already acquired resources; a late mount result is
disposed rather than adopted. Mount must use the supplied AbortSignal for its own pending work and
clean up its partial allocations if it throws before returning a disposer. JavaScript cannot force
an arbitrary user cleanup callback to finish; timeout rejects close while owned sockets are closed.

Node graceful close includes its configured `graceMs` before the cleanup budget. Signals and roster
drain converge on the same teardown. The lower `createHostResource` owns Express, HTTP, Socket.IO,
its accepted sockets and bind/close lifecycle; existing HTTP-host examples now re-export it.
Its default origin is its own bound URL; use `origins` to override the shared HTTP/WS policy.
Raw `socket` options cannot override `cors` or `allowRequest` independently.
No caller-owned Express app or transport is accepted by the service host. Archives passed through
`durable`/`durableControl` are borrowed ports: authority close flushes pending writes and releases
its subscriptions; it does not call an extra caller-supplied storage close hook. The filesystem
adapter has no persistent open handle. Do not share one mutable archive instance between hosts.

`origins` is one explicit HTTP and WS allowlist. Without it, env parsing admits known local origins
and `SERVICE_CORS_ORIGINS`. Only explicit `SERVICE_ALLOW_ANY_ORIGIN=1` enables reflection of all origins.
Allowed HTTP responses/preflights receive matching headers; denied origins receive no allow header.
WebSocket upgrades use the same decision via `allowRequest` (Socket.IO CORS alone does not gate WS).
Credentials are not enabled by default. CORS is not bearer authorization or CSRF protection.

## Child process resource

`createProcessResource({command, args, cwd, env, ipc, ready, startTimeoutMs, stopTimeoutMs, tailChars,
shutdown, signal})` spawns one direct child with `shell: false` and `windowsHide: true`. `ready(fact)`
recognizes output or IPC facts; return `undefined` to keep waiting. The resource exposes `ready`,
`done` (stdio closed), idempotent `close`, `events.failure`, `events.message` and `view` status/tail.
`view.failure()` retains failure after event streams close. Startup failure rejects readiness;
deadline/cancellation closes the child. Graceful shutdown defaults to SIGTERM, with force-kill after
the configured budget even if a custom shutdown callback never resolves. The hosting example and
pizzeria process check demonstrate product-specific IPC protocols over this resource.

It does not own grandchildren, a process tree scheduler, retries, topology or module activation.
Windows execution is verified locally. The same tests run in the existing Ubuntu/Windows CI matrix;
this release's local workspace had no Linux runtime available, so no local Linux pass is claimed.

## Immutable binary storage

`createLocalBlobStorage({directory, maxBytes, authorize, validate?, identify?})` stores raw bytes
outside replay. `control.upload(context, bytes)` checks access before work and again after writing
a private temporary file, immediately before publication. Default ids are SHA-256; a hard link
publishes atomically without overwriting, and identical bytes share one object. Custom id collisions
with different bytes reject. Invalid ids/traversal, empty/oversized bodies, validator failures and
IO failures reject and clean up temporary files. The directory must be dedicated and trusted;
this is not protection against another OS principal rewriting files or inserting symlinks there.

`resource.read(context, id)` and `control.remove(context, id)` enforce configured access.
`createBlobHttpRouter({storage, context, contentType?, cacheControl?})` mounts POST `/` and GET `/:id`.
Mount it before JSON/body parsers so its authorization gate executes before body consumption. It
limits binary bodies, uses `nosniff`, defaults to `application/octet-stream` and `private, no-store`,
and hides read failures as 404. Select public immutable caching explicitly only for public bytes.
Signature sniffing is not full content validation; decoding, image policy and product ACL belong
in the supplied validator/authorization functions.

`createBlobArtifactStorage({storage, context, open, remove?})` satisfies `ArtifactStoragePort`:
register a blob id as the artifact storageKey, retain existing Artifact metadata/retention, and
supply an authenticated/signed HTTP URL in `open`. Its expiry must describe the URL's actual access
policy. Removal is deliberately opt-in: revoking one metadata record must not delete a shared hash
object still used by another record. `Resource.FileStoragePort` can similarly keep the blob id in
its host metadata, confirm with `storage.view.info`, and issue its own upload/download instructions;
no second file-job lifecycle is introduced.

## Migration and evidence

For proxy/NAT hosting, 2.20.0 separates `publicUrl` / `SERVICE_PUBLIC_URL` from the listening
interface/port. `host.url` remains local; `host.publicUrl` is the configured roster address.
The configuration and executable three-gateway example are in
[SERVICE-PUBLIC-ADDRESS.md](SERVICE-PUBLIC-ADDRESS.md). Origins remain explicit.

In this repository, pizzeria/rental/apartments/small-jobs no longer ship copies of client,
access, leader/node composition, REST or input schema logic: compatibility files re-export npm
entrypoints. Their process files select domain definitions and mount product resources. A consumer
can replace its copied `client.ts`, descriptor helper, `access.ts`, `leader.ts`, `node.ts`, `rest.ts`
and `input-schema.ts` with these imports, retaining only product configuration. Its extended `me()`
adapter is included. Use the shared host for CORS/mount cleanup, process resource for spawn lifecycle,
and blob router/storage for generic binary IO; keep roles, recipe/image rules, topology and retention.

No consumer repository or installed package is changed by this release. Pizzeria/organizer migration
and their application-wide checks must run against the published version in their own task.

Evidence: `type-tests/service-runtime.ts`, isolated installed-tarball/browser consumer checks,
`oracle/realsocket/service-host.spec.ts`, `scaffold-session.spec.ts`, `scaffold-client-lifecycle.spec.ts`,
`oracle/regression/scaffold-access.spec.ts`, `process-resource.spec.ts`,
`oracle/realsocket/blob-storage.spec.ts`, pizzeria `network-check.ts`, hosting process checks,
standalone generated scaffold and all eight installed example checks.
