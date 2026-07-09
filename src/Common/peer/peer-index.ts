// =====================================================================
// Peer — one-call SDK over the transport stack (namespace barrel)
// =====================================================================
// Host: spread connection(account).fragment into an EXISTING rpc object —
// legacy keys keep working. Client: createPeerClient over the fragment's
// deep proxy — own store published, peer(account) mirrors others, direct
// promotion via an injected WebRTC runtime. Oracle: replay/peer-sdk.test.ts.

export * from './peer-relay'
export * from './peer-host'
export * from './peer-client'
