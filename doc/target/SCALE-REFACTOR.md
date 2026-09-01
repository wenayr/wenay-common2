# Scale tier refactor — one control line, authority-computed liveness, input facades

Status: **decided and implemented 2026-09-02**, folded into the still unpublished 2.16.0 (the tier
never shipped with the old shape; renames in `../NAMING_RENAMES.md`, release notes in
`../changes/2.16.0.md`). Read with [`SCALE-DEPLOY-PLAN.md`](SCALE-DEPLOY-PLAN.md).

## Why

The tier landed in 2.16.0 as a composition of the shipped primitives, and the review that followed
named four structural debts that only a breaking pass removes:

1. **Three control lines.** Directory, deny list and receipts were three independent replicated
   maps: three subscriptions per follower, three keyframes, three separate follow/promote steps in
   succession — and a promoted standby inherited three snapshots taken at three different moments.
2. **Liveness computed by every reader.** Each heartbeat was a replicated write fanned to every
   subscriber, and each reader judged staleness against its OWN clock — hence the anchored
   `hostNow` machinery and a roster whose traffic was O(nodes × followers) per beat.
3. **Flat inputs.** `createAuthority` took one bag of 18 keys while its output was five facets; the
   line coordinates were re-declared in four factories.
4. **Three write verbs with three merge rules.** `upsert` replaced a row wholesale, `heartbeat`
   merged `meta`, `register` merged by hand.

## The shape after

### One control store, followed as one line

```ts
type ScaleControlState = {
    nodes:    Record<nodeId, NodeDirectoryEntry>
    revoked:  Record<account, StoreNodeRevocation>
    receipts: Record<account + '\0' + requestId, CommandReceiptRecord>
}
```

The authority owns ONE `Store<ScaleControlState>` exposed as ONE Store Replay line. A standby follows
that line with `createStoreFollower` and is promoted by that follower's own `promote()` — the same
store continues, the cascade journal lives on, and every section is re-owned in the SAME instant.
Nodes follow the same line (their own row and the deny list arrive together). Browsers never see
the deny list or receipts: `serve.browser().roster` is a **projection line** of the `nodes` section
(patches with `path[0] == 'nodes'` forwarded into a second store).

The roster verbs, the deny list and the receipts line become **section facets** over that store:

- `Observe.createNodeDirectory({store?, ...})` — standalone it owns a `Store<{nodes}>` and its own
  line (`api`); embedded (`store` given) it is a facet over the authority's control store.
- `Command.createCommandReceipts({store?})` — the same rule; `CommandReceiptLine` is unchanged, so the
  command host does not know which one it was given.

### Liveness is a fact the authority publishes

```ts
type NodeDirectoryEntry = {nodeId, url, role, weight, draining, alive, since, meta?}
```

`ts` is gone. The directory owner (the only process with the relevant clock) keeps `lastBeat` in
memory, sweeps every `staleMs / 2` (default `staleMs` 15 s; `0` disables) and flips `alive` — a
replicated write happens when a FACT changes (alive, readers, labels), never per beat. Readers derive
only `eligible = alive && !draining && weight > 0`; `stale`, `staleMs` and `now` disappear from every
reader API (`nodeDirectoryViews`, `followNodeDirectory`, `createClusterClient.placement`). A
promoted standby calls `grace()`: every row gets a fresh beat so nodes have `staleMs` to re-home.

Consequence, stated: if the authority itself dies, the roster freezes with its last facts and rows
stay `alive` — clients keep acting on last known facts (the architecture rule) and the replica set's
own route health decides per connection. Follower `status` says whether the control link is up.

### One write rule

`control.set(row)` replaces a row; `control.patch(nodeId, partial)` merges (meta one level);
`heartbeat(nodeId, patch?)` = liveness + optional patch; `drain`/`undrain` are named patches;
`remove`, `get`, `snapshot`, `grace`. `upsert` is gone.

### Inputs mirror the outputs

```ts
Scale.createAuthority<T, Cmds>({
    line:     {storeId, originId, nodeId?, lineId?, initial},          // StoreLineCoordinates + initial
    roster:   {url, weight?, heartbeatMs?, staleMs?, acceptNode?, meta?},
    identity: {issue, verify, renewBeforeMs?},
    corridor?: {commands?, limits?, receipts?},
    leadership?, log?,
}) -> {line, roster: {control, api /* projection line */}, identity, corridor,
       serve: {browser(account), reader(), nodeLink(nodeId?), connection()},
       control: {promote}, events: {role}, view, start, close}

Observe.createStoreNode<T>({
    line:   {storeId, originId, nodeId, lineId?, initial?},
    roster: {url, weight?, heartbeatMs?, graceMs?},
    upstream: () => {replica, control, commandsByToken?, register, heartbeat, goodbye, onFail},
    serve:  {onConnection, wrap?, keys?: {read?, write?}, opt?},
    auth?, commands?, onLeave, log?,
})

Scale.createClusterClient<T>({
    line: {storeId, originId, nodeId, lineId?, initial},
    roster /* the projection line or a standalone directory api */,
    connect, placement?: {label?, priorityOf?, rng?, balance?}, leadership?, log?,
})
```

`StoreLineCoordinates = {storeId, originId, nodeId, lineId?}` is declared once (`store-replica-set`).

## Not changed

The replica set's fork choice / epochs / lease seam, the RPC-AUTH rules, the command host's
receipt semantics, "the center distributes facts, the edge decides". Deferred with reopen
conditions: receipt + state change in ONE transaction (needs a consumer whose in-flight window
actually bites), the library-owned link layer (next pass: `createClusterLink`), the single
cluster-member factory (after the link layer).
