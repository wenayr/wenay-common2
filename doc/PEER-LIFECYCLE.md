# Peer connection ownership

Imports remain `wenay-common2/peer` and `wenay-common2/rpc`. The 2.18.2 patch changes
no public signatures and adds no dependencies.

`createPeerHost().connection(account)` owns one signal registration and one presence
reference. Its `close()` is terminal and idempotent: saved `fragment.publish`,
`publishBatch` and `signal.send` return `false` without effects. A signal awaiting
`authorize` checks that its originating registration and hub are still open before
delivery. Closing another registration for the same account does not invalidate this
one. Closing the host closes every registration and relay.

The account journal belongs to the host, so it survives a connection close. Existing
readers can still read that journal. Connection close is not a general read-access
revocation operation: the shared dynamic `peers` map and presence source have their
host lifetime. Room authorization and account-to-tab identity remain the host's policy.
For revocable readers, see the dynamic subtree limits in [RPC-AUTH.md](RPC-AUTH.md).

`createPeerClient().close()` owns local publication, peer mirrors, route subscriptions
and optional direct-route acceptance. It releases these synchronously and refuses new
`peer()` views. It borrows the supplied RPC remote; the application owns its hub:

```ts
peerClient.close()
hub.close()
```

No delay or global rejection handler is necessary between these calls. If the parent
RPC must keep serving other application features, close only the peer client and its
server-side room connection. The server must still close that room connection on
transport disconnect. A closed client does not promise delivery of queued publication.

RPC callback subscriptions under `noStrict` use the existing callable, awaitable
subscription handle, including `.off()` and `.unsubscribe()`. Dynamic `.on(cb)` and
`.callback(cb)` use the same callback-shaped recognition as legacy servers. They are
locally multiplexed by path and arguments when the default RPC deduplication is enabled:
each handle removes only its consumer, and the last one stops the physical subscription.
Consequently server subscription counts can decrease without reducing callback delivery.
They are not schema-declared subscriptions and are never automatically replayed after a
transport generation changes. Non-subscription calls retain their ordinary rejection
behavior. Reconnecting peer applications must recreate their owned views and resync
publication according to their existing reconnect policy.

The reported failures were reproduced on published 2.18.1: retained room methods
changed relay state and delivered signals after close (PC1); two unowned dynamic
subscription promises rejected with `RPC_ABORT` at peer/hub shutdown (PC2).
The RPC subscription owner now supplies teardown and observes the physical call.
This is not a global error suppression rule or a change to replay sequence semantics.

Proof: `oracle/regression/peer-close.spec.ts`,
`oracle/realsocket/peer-lifecycle.spec.ts`, and the existing peer SDK/repair oracles.
The network regression checks retained RPC calls, independent tabs, removal of server
subscriptions while the parent RPC remains usable, close before subscribe/during catch-up, active updates,
transport break and repeated close. It fails on any unhandled rejection.
Real WebRTC media capture and browser collaboration are outside this protocol fixture.
