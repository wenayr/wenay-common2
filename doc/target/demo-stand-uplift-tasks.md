# Demo stand uplift tasks

Goal: take the v1.0.84 stand from "feature-complete demo" to a finished, publishable showcase:
a clean release, a calls experience that feels like a real application, product-grade Store UX,
an abuse-safe public deployment, and a consumption layer shaped by the stand — in line with
`doc/INTENT.md` ("value is in being legible and demoable").

The measure everywhere is the same pair: **beauty of the integration code** (CLAUDE.md factories,
clear layering) and **functionality of the examples** (every visible feature exercises a real
library surface; no method catalogue, no framework).

Context: `doc/target/demo-store-business-stand.md` is implemented; release 1.0.84 is staged but
not verified/published (`doc/progress/release-1.0.84.md`); INTENT directs further effort to the
consumption layer (React hooks first) and the showcase.

## 0. Release hygiene — CLOSED 2026-07-18

- [x] Line endings: diagnosed as a tree-wide worktree CRLF flip over an LF repo (no real
      unstaged changes — every diff vanished under `--ignore-cr-at-eol`). Guard files
      `.gitattributes` (`* text=auto eol=lf`) and `.editorconfig` are in place; with them
      active the phantom diff collapsed. Remaining one-liner: commit the two guard files and
      run `git add --renormalize .` once to clear the residual stat-cache entries.
- [x] Full verification re-run in a clean Linux sandbox on the working-tree snapshot:
      build (tsc), rpc symbol guard, rpc harness (ALL GREEN), packaged-`dist` test,
      **59/59 oracles green in 105s**.
- [x] npm tarball inspected: 314 files, readable demo/oracle sources included; `doc/target`,
      `doc/progress`, `demo/public`, `*.tsbuildinfo` absent.
- [x] `wenay-common2@1.0.84` committed, pushed and published by the author (registry
      confirmed); `doc/progress/release-1.0.84.md` deleted per convention.

## 1. Calls app: from protocol demo to a complete application

Today the stand *proves* the call protocol (ring/accept/decline/hangup, media ACL via the host
`authorize` hook) but does not *feel* like a calls app: accept/decline live only inside the
Rooms view, there is no sound, no call timer, no busy handling, no history, no device picker,
and the ~70 lines of call UI logic sit inline in `demo/client.ts#main()`.

### 1.1 Reachability and feedback — DONE 2026-07-18 (headless smoke: 13 checks green)

- [x] Global incoming-call banner (`#callBanner`): surfaces over ANY view with the caller's
      name and accept/decline; accepting reveals the Rooms view.
- [x] Call sounds without assets: `demo/call-tones.ts` (`createCallTones`) — WebAudio ringtone,
      ringback, connect/end blips; mute toggle in the call section; degrades to silence when
      the AudioContext is gesture-locked.
- [x] Browser `Notification` for background tabs: permission requested lazily on the first
      outgoing call, degrades silently.
- [x] Outgoing ring settles — VERIFIED, no library gap: `createCallManager` already times the
      ring out on both sides (`ringTimeoutMs` 30s), fails the ring verdict as 'offline', and
      carries the end reason in the envelope. The demo simply never displayed it; outcomes
      (busy / no answer / declined / missed / offline) now render in the call section.
- [x] Bonus fix caught by the smoke: the call button used to stay disabled until a presence
      chip was clicked — presence changes now refresh the call UI directly.

### 1.2 In-call experience — DONE 2026-07-19 (smoke: 23 checks green)

- [x] Call screen: peer stage tile with own camera as picture-in-picture (`#callSelfPip`,
      re-attaches across resolution restarts), in-call control bar (`#callControls`: mute mic /
      camera / share screen) shown while active, live duration timer in the state line.
- [x] The control bar drives the SAME account-wide sources: `createMediaDemo` now returns a
      `local` facade (`toggle(kind)` / `state(kind)` / `changes`) built on one shared
      capture-change stream; room-stage buttons, the call bar, the PiP and the published AV
      flags all follow it (smoke: toggling from the bar flips the room-stage button).
- [x] Peer-visible mute/camera state: `World.av = {camOn, micOn, screenOn}` published on every
      capture change; the call screen overlays "🎙 muted / 📷 camera off" from the peer's
      flags and simply shows nothing when an older peer lacks them.
- [x] Connection loss during an active call: own socket drop shows "connection lost —
      reconnecting…" and freezes the bar, then ends as 'dropped' on reconnect or after 20s
      (the server-side call policy has already revoked the media grant, so resuming the same
      call would be a lie); the peer's death ends the call via the presence edge. Outcome
      "Connection lost" lands in both state line and history. Smoke covers the peer-drop path
      (tab reload mid-call); the own-socket path is code-reviewed only — the hub's socket is
      closure-private, which is the right library shape but untestable from page context.

### 1.3 Call policy — DONE 2026-07-18 (turned out to be library-provided; demo now surfaces it)

- [x] Single-active-call rule: already enforced by the manager's default incoming gate —
      overlapping rings (glare included) are auto-declined 'busy' before they reach the app;
      the old UI-rebind hazard is gone with the session slot.
- [x] The caller shows "Participant is busy" distinctly from "Call declined" (smoke-verified
      with a third participant ringing mid-call).
- [x] Decline-with-reason needed no extension: the envelope already carries `reason` and the
      manager maps it into the end state.

### 1.4 History and identity — DONE 2026-07-19

- [x] In-session call log panel (`#callHistory`): direction, peer, outcome (answered /
      declined / busy / no-answer / missed / canceled / offline / dropped), duration and
      time; missed calls badge the caller's presence chip until the next interaction.
- [x] Editable display name (`#myName` in the header, per-tab persistence) rides the
      existing `World` store like the cursor — no new server surface. A `displayName`
      accessor is injected as the `participantName` dep into workboard/rooms/media/call
      factories, so every label follows it; presence chips and the call banner add a
      colored-initial avatar from `World.color`. Peer `name`/`color`/`av` edges re-render
      via `peer.store.each()` (cursor stays on the RAF loop); rooms and the board expose a
      tiny `rerender()` for the same purpose.

### 1.5 Devices — DONE 2026-07-19

- [x] Camera/microphone pickers next to the resolution select, built on the LIBRARY surface
      (`source.listDevices()` + the `deviceId` option — both already existed); per-tab
      persistence; a device or resolution change swaps the source through one shared
      `restartSource` and restarts it only if it was live; labels refresh after the first
      permission grant and on `devicechange`.
- [x] Permission-state captions (requesting / denied / no-device / error) untouched — the
      picker reuses the same sources they already describe.

### 1.7 Messenger-grade call window — DONE 2026-07-19 (smoke: 34 checks green)

- [x] Full-screen dark call overlay: peer stage with own-camera PiP, top bar (avatar, name,
      state line incl. reconnecting), bottom tray of pill buttons — mute / camera / share
      screen / sound / red end-call; outgoing state is a proper "ringing…" screen with a big
      avatar and cancel. Screen sharing swaps the stage to screen-first via a data attribute
      owned by the media layer (`renderStats` sets it; CSS does the layout).
- [x] Minimize to a floating pill (name + live timer; Escape minimizes too); the pill
      restores the window. The inline section keeps call/accept/decline, the sounds toggle
      and history for the minimized state.
- [x] Auto-media like a real messenger: a call going active auto-starts mic + camera (a
      session rule over the shared capture facade) and enables peer sound inside the accept
      gesture; joining a room auto-enables listening; manual mutes stay respected.
- [x] "Camera stopped working" root cause found and surfaced: a second Chrome INSTANCE cannot
      open a webcam the first one holds (Windows-level exclusivity across processes; tabs of
      one instance share fine). Capture error captions now show the real reason
      ("camera: Device in use") instead of "see log".
- [x] Room tiles show the peer's "🎙 muted" badge from the published AV flags.
- [x] Rooms as a group call (2026-07-19, second pass): Meet-style dark 16:9 tile grid — video
      fills the cell, identity/AV state ride overlay chips ("Андрей · 🎙", "📷 camera off",
      "⏳ connecting…"), a screen share becomes its own full-width tile, the self preview is
      just another tile, and joining a room auto-enables listening.

### 1.8 Group calls + view modes — DONE 2026-07-20 (real webcam verified, cloud smoke 48/48)

- [x] The call overlay is a dynamic tile grid (`#callGrid`), reused for 1:1 and group. Each
      participant (self + peers) is a tile with name chip, camera-off/connecting badge and a
      green speaking ring.
- [x] View modes: Speaker (active speaker fills the stage, own camera as corner PiP, others
      hidden — "show whoever is talking" by default) and Grid (everyone equal), toggled from
      the header. Active speaker is auto-detected from mic activity (peer audio-frame rate +
      local mic RMS) and drives Speaker view.
- [x] "＋ Add" rings another online participant into the call — host-centric group over the
      existing `Peer.createCallManager` (one pairwise leg per invitee, media watch ACL already
      per-pair, zero server change). Overlay title becomes "Group · N participants".
- [x] Tray: mic / camera / share-screen / ＋add / sound / red end-call; minimize-pill kept;
      screen share becomes its own wide tile.
- [x] Bug fixed on the way: `#callGrid` used `data-view`, which collided with the app-shell's
      view router (`[data-view]` → hidden) and made the grid `display:none`. Renamed to
      `data-layout`. Real-camera pixel check confirmed 640×480 @12fps frames flow to the tiles
      and across the relay to peers.
- Note (verification caveat): Chrome's FAKE device emits 2×2 near-black frames in this
      environment, so synthetic screenshots look blank — visual proof needs the real camera.

### 1.6 Code shape (the point of the exercise)

- [x] Extracted, mirroring the workboard split: `demo/call-app.ts` (`createCallSession` —
      call slot, outcome classification, history, tone/media triggers, `changed` /
      `historyChanged` listen streams) + `demo/call-ui.ts` (`setupCallUi` — DOM only:
      banner, call section, history, notification) ; `media-demo` keeps the attach/detach
      media boundary.
- [x] Sounds as a separate tiny utility factory (`demo/call-tones.ts`, `createCallTones`),
      pure WebAudio, no call rules inside.
- [x] `demo/client.ts#main()` shrank back to composition: ~70 inline call-UI lines replaced
      by create-and-wire of the three factories.
- [ ] 🧊 Call-grade smoothness (true 30fps capture via `MediaStreamTrackProcessor`, native
      WebRTC tracks/SFU) stays a ROADMAP performance adapter — reopen only if the finished
      call screen makes the 12–15fps JPEG path feel inadequate.

Acceptance: an incoming call is impossible to miss from any view and audible; a full cycle
(ring → accept → talk with timer → mute/cam toggles visible on both sides → hangup → history
entry) works between two tabs with zero console errors; calling a busy participant yields
"busy" on both sides; an unanswered call becomes "missed" on both sides; the call code reads
as copyable integration layers, not UI spaghetti.

Status 2026-07-19: PHASE 1 COMPLETE (1.1–1.7). Headless three-participant smoke: 34 checks
green — banner on the Store view, accept opens the full-screen call window, mic/camera/sound
auto-start, ticking timer, display-name propagation into presence/board/banner, tray over
shared sources, PiP, peer AV badges both directions, minimize-to-pill and restore, device
pickers, busy, decline, mid-call drop -> "Connection lost", zero page errors. Also driven live
end-to-end in the author's own Chrome over CDP. Not yet released: the next publish needs
`doc/changes/1.0.85.md` per CLAUDE.md. The smoke script still lives outside the repo (needs a
`playwright` dev-dep decision before it can move into `scripts/` as the E2E seed).

## 2. Store screen: product-grade UX — DONE 2026-07-19 except the activity feed

- [x] Keyed per-item rendering: cards are closures keyed by item id, columns are built once,
      reconciliation moves a card only when its column actually changes (sort keys are
      immutable), and a focused rename input is never overwritten or re-mounted —
      smoke-verified: focus and typed text survive a remote create.
- [x] Friendly revision conflicts: `revision conflict` rejections render as "Someone changed
      this item first — the card has refreshed, try your change again."
- [x] Optimistic pending presentation (visual-only, per the plan's constraint): a move slides
      the card to the target column immediately with a busy state; the authoritative replay
      confirms it or snaps it back. No client-side truth; `predictedStore` still waits for a
      real generalization need.
- [x] Drag & drop between columns (vanilla HTML5 DnD, whole column is the drop target) using
      the same command path as the buttons.
- [x] Assignee picker fed from presence: a compact per-card select (Unassigned / Me / every
      online participant with display names); open dropdowns are never rebuilt under the
      cursor. Text search dropped as noise for a three-column demo board.
- [x] Compact board activity feed: diffs each replay tick against a COPIED last-seen snapshot
      (the mirror applies per-path deltas into the existing object — holding a reference would
      compare the new state with itself) and narrates add/move/rename/assign/remove with
      display names and time; the initial keyframe only seeds the snapshot.

Acceptance: met (headless smoke, 40 checks total) — two tabs editing the same board never lose
focus or typed text; a rejected command is visible and self-explanatory; every mutation still
round-trips through host commands.

## 3. Public-stand hardening — DONE 2026-07-19 (demo server only, no public API changes)

- [x] Uploaded file bytes bounded: 8 MB per file, 64 MB total budget, 15-minute TTL
      (`DEMO_UPLOAD_TTL_MS`), tickets and bytes dropped together by one janitor sweep;
      the raw endpoint limit went from 100mb to 9mb.
- [x] Workboard: idempotency receipts LRU-capped at 2000 inside the host; board capped at
      200 items (`maxItems` dep — create() rejects with a human message).
- [x] Offline participants retired after an hour (accounts map + rate-limit state); empty
      rooms disappear after a 30-second grace (author's rule: a reload must not kill the
      room; `DEMO_ROOM_TTL_MS` knob keeps the smoke fast), room count capped at 40.
- [x] Expired `artifactTickets` swept by the same janitor.
- [x] Per-account command rate limit (120/min) demonstrated on the two hand-written fragments
      (workboard, rooms) via a `limitCommands` wrapper; the injected-port stands are bounded
      by the storage quotas above.
- [x] Graceful shutdown on SIGINT/SIGTERM: Socket.IO + HTTP close with a 2s force-exit.

Acceptance: met by construction — every unbounded structure now has a TTL, a cap, or both;
the full smoke (43 checks) runs green against the guarded server.

## 4. Showcase: hero scenario and docs

- [ ] Hero scenario in Lab: a visible frame/seq counter proving relay -> direct promotion and
      re-interposition with zero gap; a one-click setup for two prepared tabs.
- [ ] Record the README GIF of the hand-off (was 🧊 optional; cheap once the counter exists).
- [ ] A 10-line "getting started" snippet at the top of `README.md` pointing at the Peer SDK
      and the workboard host/client pair as the copyable integration pattern.
- [ ] Refresh the public HTTPS deployment per `doc/DEMO-HTTPS.md` after phase 3 hardening.

## 5. Consumption layer: React hooks (INTENT direction)

- [ ] Shape hooks from the stand's real needs: `useStoreState(store)` (each()-driven),
      `useStoreKey`, `usePeer(account)` (store + route + status), `useConnectionStatus`,
      `useCallManager` (the finished call session from phase 1 defines its shape).
- [ ] Ship as a separate entry (`wenay-common2/react`) with a React peerDependency; no core
      changes.
- [ ] A second stand page (or parallel build) consuming only the hooks — proves the adapter
      without rewriting the vanilla stand.
- [ ] Oracle: hooks tested against the real store/replay with a minimal test renderer.

## 6. Real adapters (library-uplift "Next Action")

- [ ] One real `FileStoragePort` adapter (S3/MinIO signed URLs) behind the same demo flow.
- [ ] One real AI runner (any provider) behind `createAiRunHost` capabilities; credentials
      stay outside RPC per `doc/AI-RUN-PROTOCOL.md`.
- [ ] Durable Conversation persistence port (SQLite event+receipt) with restart rehydration.

## Code quality constraints (cross-cutting, per CLAUDE.md and the stand doc)

- Keep resource adapters, business rules, and DOM presentation in separate closure factories;
  DI at the boundary, closures inside; named functions; `listen` streams exposed outward.
- Reuse existing library surfaces before adding any public API; library changes only through
  the pain-point loop (the app proves the need, an oracle pins the fix).
- Each visible feature must serve the scenario — no method catalogue, no design system, no
  frontend framework; the demo source stays readable as copyable integration code.
- Short comments only at integration decisions a new consumer could misunderstand.

## Verification strategy

- [ ] Scripted multi-tab E2E (Playwright, headless, fake devices): three tabs -> presence,
      workboard convergence with identical revisions, reconnect catch-up without duplicates;
      call cases from phase 1 acceptance: ring visible on the Store view, accept -> timer ->
      mute visible remotely -> hangup -> history; busy auto-decline; missed after expiry.
      Replaces the current manual headless checks; runnable locally, optional in CI.
- [ ] The full oracle suite stays green at every phase; new behavior lands with an oracle or
      the E2E script, never by hand-testing alone.

## Delivery order

0 -> 1 -> 2 -> 3 -> 4 -> 5 -> 6.

Phase 0 is small and unblocks publishing. Phase 1 (calls app) is the author's priority and the
biggest visible jump; 1.1 + 1.3 (banner, sounds, busy/missed) land first, then 1.2 (call
screen), then 1.4–1.6. Phase 2 can proceed in parallel with late phase 1 (different files).
Phase 3 is required before the public endpoint is refreshed. Phase 5 starts only when the
vanilla stand is stable so the hooks are shaped by real usage, not speculation.
