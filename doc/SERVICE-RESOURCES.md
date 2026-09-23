# Static session resources (SC1 v1, 2.19.0)

`tServiceDefinition.resources` is a static registry of authority-owned factories. Register code
at startup; each `client.resources.open(name)` creates a separate owner. Ordinary views can move
between serving nodes while resources stay on authority. No dynamic code loading is involved.

## Definition and inferred client

```ts
import {listen} from 'wenay-common2/listen'
import {describeService, type tServiceDefinition} from 'wenay-common2/service'

const definition = {
    name: 'board', storeId: 'board', originId: 'authority', initial: {}, commands: {},
    access: {rolesOf: () => ['member']}, // Replace with the host's actual account policy.
    resources: {
        counter: {
            allow: ['member'], placement: 'authority',
            open() {
                let count = 0
                const [emit, events] = listen<[number]>()
                return {
                    facade: {
                        control: {add(amount: number) { count += amount; emit(count); return count }},
                        view: {read: () => count}, events,
                    },
                    close: events.close,
                }
            },
        },
    },
} satisfies tServiceDefinition<any, any>
const descriptor = describeService(definition)
```

Keep the concrete definition inferred through `satisfies`. A broad type annotation loses literal
names and exact factory result types. `describeService` copies only resource names, allow lists
and placement. Export its JSON from a server/build module; browsers import that data and a
**type-only** reference to the definition. Seed state and executable factories are not serialized.
Older descriptors remain valid. Optional `ServicePermissions.resources` lists allowed names when
the registry exists; absence means no advertised support.

```ts
const owned = client.resources.open('counter')
const offStatus = owned.status.on(function changed(status) {
    console.log(status.phase, status.generation, status.error)
}, {current: true})

const current = owned.current() // null until ready
if (current) {
    const off = current.remote.events.on(function changed(count) { console.log(count) })
    await current.remote.control.add(1) // number in, Promise<number> out
    off()
}
offStatus()
await owned.close()
```

The controller and its status Store retain identity. `current()` returns `{generation, remote}`
only while ready. Every ready generation has a unique RPC address: a retained remote cannot
target a later instance. Calls interrupted by transport loss are not replayed. Each open owns an
authority connection, so closing one leaves other controllers/tabs and the main client's
commands, views and Stores alive.

## Factory and peer ownership

`ServiceResourceContext` contains a detached frozen verified `principal` (`account`, current
roles), server-generated `sessionId`, unique server-generated `resourceId`, and cooperative
`signal`. Handshake metadata supplies neither identity. V1 has no client factory parameters.
Roles come from authority state; tokens use the existing identity/revocation machinery.

Factories may return a Promise of `{facade: object, close(): void | Promise<void>}`. The runtime
owns returned handles. Partial allocations before a factory throws remain its author's duty.
A result arriving after cancellation is disposed once and never exposed. Independent raw opens
within one authenticated transport share sessionId but receive different resourceIds.

Bind a peer connection to **resourceId**, so independent opens do not share an owner journal:

```ts
presence: {
    allow: ['member'], placement: 'authority',
    open(ctx: ServiceResourceContext) {
        const peer = room.connection(ctx.resourceId)
        return {facade: {session: () => ctx.resourceId, peer: peer.fragment}, close: peer.close}
    },
}
```

The host owns `room.close()`. See the shipped [counter/peer example](../examples/hosting/session-resources.ts),
generated from `experiments/wenay-scaffold/examples/hosting/session-resources.ts`;
its package provides `npm run example:resources`. Existing scaffold facades relay this runtime.

## State and access cut

| Trigger | Outcome |
| --- | --- |
| Allowed open | `opening` → `ready`; generation increments |
| Permission unavailable / regained | `denied` → `opening` → `ready` |
| Roles change, even if still allowed | Close old scope and open a new generation |
| Same account/normalized roles, renewed token | Preserve instance; update deadline |
| Transport loss / same-account reconnect | `offline` → `opening` → fresh `ready` generation |
| Account changes | Old controller becomes terminal `closed`; explicitly open another |
| Factory error / opening timeout | `failed`; retry by closing and opening another controller |
| Controller close / parent client close | Immediate terminal `closed`, current becomes null |

An external token provider is consulted again on reconnect. Tokens accepted by the service
client propagate to connected resources. Close is idempotent and returns the same Promise;
the parent client's synchronous close observes the resource cleanup tasks it starts.
Token regrant reattaches the permission stream as well as opening a fresh resource, so later
role changes remain observable. Long deadlines use RPC's existing chunked absolute-timer logic.

The linearization point is **authority scope invalidation**, before awaiting disposal. RPC
rejects calls/reads through saved raw paths, rechecks after asynchronous request admission and
before returning awaited results, and ends this scope's ordinary and `noStrict` Listen streams.
Shared sources and RPC subscription multiplexing retain separate scope ownership. Late
subscription handles, flow waits and replay-gate timers are released. Unscoped RPC is unchanged.

Already transmitted data cannot be recalled; effects started before invalidation cannot be
rolled back by RPC. Resource work must cooperate with its signal. Closing a bare peer connection
still follows the ordinary peer contract: the enclosing service scope supplies the stronger
read/subscription revocation here.

## Budgets and diagnostics

`resourceOptions: {openTimeoutMs?, closeTimeoutMs?}` on leader/host and client dependencies
defaults to 10,000 / 2,000 ms; values must be finite and nonnegative. Opening timeout cuts
admission and observes/disposes late factory results. Cleanup timeout means cleanup could not
be confirmed, not that external work was forcibly stopped. A failed disposer cannot skip its
siblings. Late work can still emit cleanup diagnostics after transport shutdown.

Client `status.error` contains only `{code, message}`. Close rejects with `E_RESOURCE_CLEANUP`
for unconfirmed cleanup and retains that safe error in closed status. Factory errors use
`E_RESOURCE_OPEN` or `E_RESOURCE_TIMEOUT`, without private exception text. Server owners observe
original errors and timeout diagnostics through
`leader.resources.errors.on(({name, resourceId, phase, error}) => ...)` (`phase`: open/close).
A cleanup diagnostic does not replace the original startup failure.

`leader.control.close()` also returns resource cleanup completion; await it when confirmation
matters. Standard service hosts already own this step. Custom hosts mount
`leader.serve.resourceConnection()` on RPC key `resources`: pass its **object, auth and hooks**
to `createRpcServerAuto`, attach the returned server control, and close the connection on
disconnect. The hooks carry internal scope ownership; omitting them loses this contract.

## Verification and adapter migration

- A1–A5: `rpc-resource-scope.spec.ts` covers shared source independence, retained methods,
  ordinary/dynamic streams, admission/read barriers, late subscription cleanup and blocked flow.
- B1–B8: `service-resource-session.spec.ts` checks session ownership and controlled deadlines;
  `service-resource-cancellation.spec.ts` covers real socket factory/token cancellation and errors.
- C1–C5: `service-resources.spec.ts` covers counter/peer, roles, tabs, real transport loss and node
  placement; `service-resource-restart.spec.ts` covers saved raw paths, renew, archive/receipt
  restart and account replacement. Network waits are bounded; race tests use explicit barriers.
- T1/T2: `type-tests/service-resources.ts` and the isolated tarball type/browser build preserve
  exact names, methods, arguments and async results without bundling server factories.

Consumers adopting this API can remove their resource connection owner, generation retargeting,
manual role/reconnect recreation and raw-facade revocation wrappers. Keep factories, domain
permissions, peer-room ownership and UI subscriptions in their owners. React H1/H2 and organizer
UI migration D remain separate work; this release does not claim browser product acceptance.
