# Artifact runtime — storage-backed, capability-zero client surfaces

## Purpose

An artifact is not a Store value and it is not an RPC code payload. It is a small, durable
descriptor for a file, generated report, or interactive app whose bytes live in storage. The
Artifact layer gives an AI/resource backend a single lifecycle for those descriptors and gives a
browser an explicit, revocable way to open one.

The first vertical slice is deliberately narrow:

```text
AI/resource runner --private storage key--> Artifact host --descriptor/replay--> client Store
                                      \--short-lived open instruction--> sandboxed iframe
```

Store/replay carries lifecycle facts only. The storage key, signed URL/token, HTML/JS, file bytes,
and browser credentials never enter Store, Replay history, or an AI event.

## Authority and data ownership

| Concern | Owner | May be replicated? |
| --- | --- | --- |
| Artifact descriptor, owner, lifecycle state, expiry | Artifact host / filtered Store | Yes, to authorized accounts |
| Storage key/provider object id | Server-side Artifact host registry | No |
| Artifact bytes and CSP headers | Injected storage adapter | Never through Store/RPC |
| Short-lived URL/token | Storage adapter `open()` result | Only direct RPC response to one authorized caller |
| DOM iframe and its sandbox | Browser application/runtime | Local only |

`ArtifactHost` is runtime authority, not a database. A persistent deployment must persist the
artifact metadata plus its private storage-key mapping in its own application/storage adapter and
rehydrate it at boot. A JavaScript `Map` and a replay journal are intentionally not advertised as
long-term retention.

## Public descriptor contract

The descriptor is intentionally declarative. The initial runtime supports `sandboxed-iframe` and
`download`; it has no host callbacks, RPC proxy, cookies, or implicit parent `postMessage` bridge.

```ts
type ArtifactDescriptor = {
  kind: string
  label: string
  runtime: 'sandboxed-iframe' | 'download'
  mime?: string
  version?: string
}

type ArtifactRecord = {
  id: string
  owner: string
  descriptor: ArtifactDescriptor
  state: 'ready' | 'revoked' | 'expired'
  retention:
    | {class: 'ephemeral'; expiresAt: number}
    | {class: 'persistent'; expiresAt?: number}
  createdAt: number
  updatedAt: number
}
```

The descriptor never gains `url`, `storageKey`, inline HTML, script text, bearer token, or a
promise that a capability was granted. A future app-to-host message bridge is a separate protocol:
versioned messages, an origin check, an explicit capability prompt, and tests must arrive together.

## Storage lifecycle

An application first writes bytes directly to its storage provider and receives an opaque private
key. A trusted server-side runner calls `artifacts.register({owner, descriptor, storageKey,
retention})`. The host stores the key privately and publishes a read-filtered descriptor.

The client then calls `artifacts.open(id)`. The host checks the current state, expiry and ACL, then
delegates to `storage.open({artifact, storageKey, account})`. The adapter returns a short-lived
`{url, expiresAt}` instruction. It must refuse reads of revoked/expired content independently as
well; the host check is policy enforcement, not a replacement for storage security.

`ephemeral` always has an explicit expiry. `persistent` is an explicit storage-policy choice and
may still have an expiry. `revoke(id)` and `reap()` move lifecycle state out of `ready` and call
optional `storage.remove(...)`. The private provider key is kept if removal fails, so a later
`revoke` or `reap` can reconcile storage without making the artifact openable again. Deleting
physical bytes is an adapter policy: compliance retention may keep a tombstone or archive even
when the artifact is no longer openable. `retention.class: 'persistent'` means the application
chose durable backing; it does not make the in-memory host durable.

## Browser execution policy

The reusable browser helper accepts only a `sandboxed-iframe` record and requires the caller to
provide allowed artifact origins. It sets:

```text
sandbox="allow-scripts"
referrerpolicy="no-referrer"
allow=""
```

It deliberately omits `allow-same-origin`, forms, popups, top navigation, downloads, camera,
microphone, clipboard and parent access. The storage adapter must serve executable artifacts from a
dedicated cookie-free origin and send a restrictive CSP (for the stand: `default-src 'none'`,
`connect-src 'none'`, `base-uri 'none'`, `form-action 'none'`). The demo uses
`artifact.localhost`, separate from the application origin, so this boundary is visible rather than
hidden behind a same-origin convenience.

The iframe sandbox is defence in depth, not an authorization system. Every open URL is short-lived
and every request is authorized by the storage adapter.

## Retention decisions deliberately left to the application

- Tenant quotas, billing, legal hold, encryption keys, malware scanning and audit retention belong
  to the storage/application adapter.
- A provider may garbage-collect ephemeral objects at `expiresAt`, keep a tombstone, or retain
  persistent objects under its own policy. The host records the visible state but does not assume
  deletion succeeded until the adapter reports it.
- Persisted artifacts must use immutable/versioned storage objects. Replacing bytes behind the same
  key silently changes a replayed descriptor and is forbidden for the stand.
- A signed open URL must expire sooner than the artifact retention window and must be safe to issue
  repeatedly. It is not stored in replay or cached as artifact state.

## Stand acceptance path

1. The demo AI runner writes a tiny interactive HTML counter to the injected artifact storage.
2. It registers an owner-scoped `sandboxed-iframe` descriptor and returns only `{artifactId}` in
   the existing AI-run artifact descriptor.
3. The authorized browser mirror sees the record, requests an open instruction, and mounts it in
   the sandboxed, cross-origin iframe.
4. Another account cannot see the descriptor or obtain an open URL.
5. Revocation/expiry prevents another open and asks storage to remove the object; no history-size
   change is used as a cleanup mechanism.

The oracle covers the authority and storage boundary over the real Socket.IO/RPC path. The manual
demo makes the iframe boundary visible; it is not the sole security proof.
