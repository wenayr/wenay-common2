# Peer discovery experiment

This isolated experiment separates three concerns:

1. discovery sources observe possible peers;
2. a large passive catalog merges and expires those observations;
3. the neighbor portfolio exposes only a bounded active offer set to `PeerPacketMesh`.

Nothing in this directory is exported by the package.

## Sources

`DiscoverySource` is the common read facade: a descriptor (`id`, `kind`, `trust`), a current
observation list and a change stream. Sources can represent:

- `wifi-lan`: UDP multicast advertisements on the current LAN/Wi-Fi network;
- `wifi-direct`: an OS-specific Wi-Fi Direct scanner through `createScannerDiscovery`;
- `bluetooth`: a platform Bluetooth scanner through `createScannerDiscovery`;
- `server`: an HTTP/RPC directory through `createPollingDiscovery`;
- `peer-exchange`: signed referrals received through an existing mesh session;
- `saved`: previously successful endpoints;
- `custom`: an application-specific source.

UDP multicast discovers peers only inside a multicast-capable local network. It is not raw 802.11
scanning and it does not cross routers by itself. Browsers cannot open the UDP socket; a browser
deployment needs a native companion, WebRTC signaling service or another injected source.

`createScannerDiscovery` is the tested boundary for OS-specific Wi-Fi Direct and Bluetooth code. A
native adapter supplies `start({found, lost, error})`; the shared layer validates advertisements,
tracks observations and guarantees scanner cleanup. This repository intentionally does not pretend
that Windows, Android, Linux and browser Bluetooth/Wi-Fi Direct scanning have one native API.

## Policy

The catalog keeps observations per source and merges them by `peerId`. Removing or expiring one
source does not erase evidence from another source. Higher-trust evidence owns mutable metadata such
as degree and initial quality. Endpoints from all surviving sources remain available to the injected
connector.

The bridge converts one merged peer into one stable `PeerPacketOffer`, preventing one peer with many
endpoints from consuming several active slots. The existing neighbor portfolio then chooses:

- three low-cost quality anchors by default;
- one bounded rescue slot for a peer below its minimum degree;
- the remaining slots by marginal failure-domain, reachability and path diversity.

`createDiscoveredPeerPacketMesh` composes the catalog bridge, portfolio and packet mesh. RTT measured
by the opened session's `ping()` is fed back into the portfolio automatically; a slow active link can
therefore be replaced by an unmeasured passive candidate without application coordination.

Discovery never opens an application connection itself. An injected connector receives the merged
candidate and decides which endpoint to try, how to authenticate it and how to fall back.

## Run

Deterministic policy plus two real local UDP sockets:

```powershell
npx tsx experiments/peer-discovery-2026-07/oracle.ts
```

Multicast demo, in two terminals on a network which permits local multicast:

```powershell
npx tsx experiments/peer-discovery-2026-07/demo.ts robot-a tcp://robot-a:5001
npx tsx experiments/peer-discovery-2026-07/demo.ts robot-b tcp://robot-b:5001
```

## Security boundary

The UDP prototype is intentionally unauthenticated and therefore has low default trust. It must not
authorize a robot, command or route by itself. Production advertisements need a deployment identity,
signature, expiry, replay protection and endpoint capability. A trusted server directory may confirm
identity while LAN discovery contributes only a fresh local endpoint.

The prototype also does not yet implement leases, connection-request arbitration, anti-Sybil quotas,
radio RSSI collection or periodic exploration of unmeasured passive candidates. Those belong above
the source adapters and below application routing, without changing the catalog contract.
