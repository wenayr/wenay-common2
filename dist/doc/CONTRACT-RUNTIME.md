# Contract runtime

`Contract.createContractRuntime` is the versioned binding layer above transport, RPC, replay and
Store. It keeps a logical slot stable while implementations appear, fail, reconnect or are replaced.
It does not download, compile, unpack or execute package bytes.

## Responsibility boundary

An application-specific loader owns delivery: it may use static imports, dynamic `import()`, a
native bundle, WebGL assets, RPC facades, workers or a package cache. Once that loader can expose a
typed API and close it, it publishes a `ContractOffer`. A backend or another trusted coordinator may
project desired components as `ContractDemand` values.

The runtime owns:

- deterministic demand authority and generation ordering;
- contract, version and capability compatibility;
- policy hooks for demands, offers and opened sessions;
- prepare-before-switch, atomic binding replacement and bounded draining;
- fallback, retry, revocation, rollback, status, history and explanations.

Transport health remains in the offer adapter. Durable application state remains in Store/replay;
replaceable implementations receive that state through their injected dependencies. Store replicas
assemble and fail over through `Observe.createStoreReplicaSet`, independently of implementation
bindings.

For verified artifact loading, isolation, candidate scopes, HTTP/MCP control adapters, activation,
and rollback boundaries, read [`DYNAMIC-RUNTIME.md`](DYNAMIC-RUNTIME.md). This runtime remains the
binding/data-plane primitive; it does not become the executable-code loader.

## Model

```text
trusted projection -> ContractDemand(slot, contract, version, authority, generation)
discovery / loader -> ContractOffer(descriptor, priority, open)
                                  |
                            ContractRuntime
                     resolve -> prepare -> bind -> drain
                                  |
                         stable typed slot API
                                  |
                    Store / replay / connections
```

A descriptor has three separate version coordinates:

- `contractVersion` describes compatibility of the public API;
- `implementationVersion` identifies the concrete build;
- optional `runtimeVersion` records an engine or host requirement.

`integrity`, `proof` and policy callbacks are metadata and verification seams. The runtime does not
pretend to verify a signature or hash without an injected policy that understands it.

## Minimal integration

```ts
import * as Contract from 'wenay-common2/contract'

type EditorApi = {save(): Promise<void>}

const offers = Contract.createContractOffers()
const runtime = Contract.createContractRuntime({
    offers: offers.api,
    policy: {
        compatible(demand, descriptor) {
            return satisfies(descriptor.contractVersion, demand.versionRange)
        },
        async acceptSession(demand, offer, api) {
            return {accepted: await healthCheck(api), reason: 'health check failed'}
        },
    },
})

offers.control.upsert({
    id: 'editor.remote.eu',
    priority: 20,
    descriptor: {
        protocol: 1,
        contractId: 'workspace.editor',
        contractVersion: '1.2.0',
        implementationId: 'editor',
        implementationVersion: '2026.07.20+7f3a',
        integrity: 'sha256:...',
        capabilities: ['save'],
    },
    async open(ctx) {
        const connection = await loader.openEditor(ctx.descriptor)
        return {
            api: connection.api,
            onFail: connection.onFail,
            drain: connection.drain,
            close: connection.close,
        }
    },
})

await runtime.control.require({
    slotId: 'main.editor',
    contractId: 'workspace.editor',
    versionRange: '^1.2',
    generation: 14,
    authorityId: 'backend-a',
    authorityEpoch: 3,
    required: true,
    capabilities: ['save'],
})

const lease = runtime.api.acquire<EditorApi>('main.editor')
try {
    await lease.api.save()
} finally {
    lease.release()
}
```

`createContractOffers` itself has no generic parameter; the `ContractOffer<T>` type carries the API
type where an offer is created. The intentionally explicit lease prevents an in-flight operation
from losing its implementation during an update.

## Resolution and authority

Exact `contractVersion == versionRange` is the safe default. Semver ranges or another compatibility
system require `policy.compatible`; the library does not guess that two versions are compatible.
Required capabilities must be present before an offer reaches `open`.

Offers are ordered by higher `priority`, then stable id, unless `policy.compareOffers` is supplied.
Demands are ordered by higher `authorityEpoch`, then lexical `authorityId`, then higher `generation`,
unless `policy.compareDemands` is supplied. Replaying the same coordinate is idempotent. Different
content at the same coordinate is rejected as a conflict, and an older coordinate is stale.

## Replacement and failure

The current binding stays live while a candidate opens and `acceptSession` runs. Only then does the
runtime publish a new binding generation. Existing leases keep the retired session alive until they
release, or until `drainTimeoutMs`; new acquisitions immediately use the new binding.

An open failure temporarily suppresses that offer and tries the next compatible candidate. An active
session may signal `onFail`, which retires it and triggers the same fallback path. `revokeOffer`
immediately removes an offer from selection without deleting its discovery record; `restoreOffer`
allows it again. `rollback(slotId)` reopens the previous offer only when it still satisfies the
current demand and policy.

If no candidate exists, a required slot is `failed`; an optional slot is `degraded`. Neither state
manufactures an API. `api.status`, `api.changed`, `api.explain(slotId)` and `api.history()` expose the
full decision trail, including rejected candidates and reasons.

## Integration rules

- Keep Store, replay journals and durable connections outside replaceable modules.
- Make every offer reusable: `open` creates a fresh session, `close` is idempotent in practice.
- Verify signatures, hashes, ACLs and runtime capabilities in loader/policy code before acceptance.
- Never run TypeScript source in production. Build platform artifacts ahead of time; the upper
  loader selects and supplies them.
- A backend may request a version, but client policy still decides whether its offer/session is safe.
- Use `apply(demands)` for a projected component set; use increasing generations for intentional
  changes and increasing authority epochs after coordinator failover.

Oracles: `observe/contract-runtime.test.ts` and `oracle/realsocket/contract-runtime.spec.ts`. The
real-wire oracle replaces two RPC implementations while a separate Store/replay mirror continues
advancing. The interactive path is `npm run demo` → **Lab** → **Versioned contract runtime**.
