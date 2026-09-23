# Service hosts behind a proxy or NAT (2.20.0)

Import `createServiceLeaderHost`, `createServiceNodeHost`, `runLeaderProcess` and
`runNodeProcess` from `wenay-common2/service/host`. All accept optional `host` (bind
interface) and `publicUrl` (advertised HTTP(S) origin). Processes also read `SERVICE_HOST`
and `SERVICE_PUBLIC_URL`; direct options override their corresponding parsed values.
`SERVICE_PORT` remains the listener port.

```ts
const host = await createServiceLeaderHost({
    definition,
    env: {SERVICE_HOST: '0.0.0.0', SERVICE_PORT: '8080'},
    publicUrl: 'https://orders.example.com',
    origins: ['https://orders.example.com'],
})
host.url        // local listener URL, retained for existing integrations
host.publicUrl  // trusted operator configuration published in the roster
```

Without `publicUrl` the roster continues to use the listener URL. `mount.url()` also
keeps its local meaning. The hosts use the existing leader/node `selfUrl` primitive;
the client, RPC and replay contracts are unchanged. `leaderEnv`/`nodeEnv` expose the
parsed `host` and `publicUrl`; `servicePublicUrl(value)` validates/normalizes the origin.

An advertised address must be an absolute HTTP(S) origin with no credentials, path,
query or fragment, wildcard host, or port zero. Socket.IO treats a URL path as a
namespace, so a proxy path prefix is not supported by this option. Configure each
gateway origin to forward `/socket.io/` (including WebSocket upgrades) and application
HTTP routes to that host. TLS, certificates, proxy creation and container port mappings
remain operator work.

The authority's published origin must be reachable by clients for identity, directory,
commands, views and SC1 resources. Every serving node needs its own reachable published
origin and stable nodeId; do not collapse different routes into one load-balanced
origin without preserving host identity. `SERVICE_UPSTREAM` independently selects the
authority address used by node links; it may be an internal address or the public
gateway. A public client must be able to reach every eligible advertised endpoint.

No address comes from incoming `Host`, `Forwarded` or `X-Forwarded-*` headers. Advertising
does not widen CORS. Use existing `origins` or `SERVICE_CORS_ORIGINS` for the browser UI's
actual origin. Keep `SERVICE_ALLOW_ANY_ORIGIN=1` as an explicit development choice.

`examples/hosting/public-address.ts` is a copyable three-gateway reference. Run
`npm run repro:public-address`: it now requires success, testing real HTTP/WebSocket
forwarding, two nodes, placement/drain, authority replacement behind the same address,
stable Store, archive/receipt recovery, fresh SC1 scopes, invalid URLs and spoofed
headers/CORS. It uses temporary local listeners and no Docker/VM. The consumer's real
container `stateful-live-check` remains a separate deployment check after adoption.
