# WebRTC / Route Coordinator Tasks

Goal: add WebRTC/direct routing without moving route decisions into media sources or low-level connectors.

Total steps: 10.

## Tasks

- [x] 1. Fix the architecture boundary: `Media` keeps producing binary `Listen` / replay frames; connectors expose transports and metrics; a coordinator owns route decisions. *(v1.0.67: `src/Common/events/route-coordinator.ts`)*
- [x] 2. Define the connector contract: open/close, state, capabilities, route label, binary support, ordered/reliable mode, RTT/pending metrics, and failure events. *(v1.0.67: `RouteConnector`)*
- [x] 3. Build fake/in-process relay and direct connectors for tests before adding WebRTC/NAT plumbing. *(v1.0.67: `makeFakeNet` in the oracle)*
- [x] 4. Implement `createRouteCoordinator` with policy hooks: `canDirect`, `mustRelay`, `mustShadowRelay`, `canExposeEndpoint`, `canReinterpose`. *(v1.0.67)*
- [x] 5. Implement the route state machine: `relay`, `direct:connecting`, `direct`, `relay:reinterposing`, `direct+shadowRelay`, `fallback`, `blocked`. *(v1.0.67)*
- [x] 6. Wire route switches through existing replay helpers: `Replay.replayRouteSubscribe(...)` and `Observe.syncStoreReplayRoute(...)`, including catch-up timeout and old-route fallback. *(v1.0.67: `link.subscribe` = `replayRouteSubscribe` under the hood; `promoteDirect({timeoutMs})`)*
- [ ] 7. Add account/resource lifecycle integration for dynamic peer maps, preferably through `noStrict(accountMap)` and `createStoreManager`.
- [x] 8. Cover coordinator acceptance tests: policy denial, direct promotion, failed direct, re-interposition, shadow relay, revocation, and no facade API change. *(v1.0.67: `replay/route-coordinator.test.ts`)*
- [x] 9. Add the real WebRTC signaling adapter over the existing socket/RPC control channel: offer, answer, ICE, auth/session material, revoke/close. *(v1.0.68: `createSignalHub` + `createWebRtcConnector` + `acceptWebRtcDirect` + replay-over-channel wire; RTCPeerConnection injected as a runtime factory — the browser/Node glue is step 10)*
- [ ] 10. Add audio/WebRTC integration only after the coordinator is stable: WebRTC media/SFU or datachannel adapter must re-emit into the same `Media` `Listen` / replay surface.

## Decisions

- WebRTC is a transport adapter, not a media-source mode that silently changes semantics.
- Connectors may propose/directly expose route capabilities, but the coordinator decides promotion and fallback.
- Route optimization must not change authority, ACL, validation, replay, or store conflict semantics.

## Next Action

Steps 1-6, 8 shipped in v1.0.67; step 9 shipped in v1.0.68 (signaling hub + WebRTC connector +
replay-over-channel wire, proven over a real Socket.IO/RPC signaling channel with a fake RTC runtime).
Remaining: step 7 — app-level account/resource shell (`noStrict(accountMap)` + `createStoreManager`
starting/stopping per-pair links); step 10 — real browser/Node WebRTC glue, which is now just passing
`rtc: () => new RTCPeerConnection(cfg)` (or a werift adapter) into `createWebRtcConnector` /
`acceptWebRtcDirect` plus the media re-emit into the `Media` `Listen`/replay surface.
Both are scheduled through the vertical demo app — `doc/target/library-uplift-tasks.md` task 3
(app-first: promote into the library only what generalizes).
