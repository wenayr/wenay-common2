# Store demo and business stand

Goal: turn the demo into a compact product-like stand that teaches the intended integration style without hiding the library behind framework code.

## Implementation status

- [x] Shared `Rooms` / `Store` / `Lab` application shell and responsive visual language.
- [x] Server-authoritative Workboard resource with idempotent commands and item revisions.
- [x] Read-only client replay mirror, connection status, per-item rendering, filters, and command feedback.
- [x] Real Socket.IO oracle for keyframe, live updates, rejection, delete, and reconnect catch-up.
- [x] External HTTPS/WSS multi-client verification for Workboard sync and room membership.
- [x] Release packaging and publication prepared as `1.0.84`.

## Product shape

- One application shell with clear sections: `Rooms`, `Store`, and the existing protocol examples.
- `Rooms` remains the media scenario: visible participants, room video/audio/screen streams, and a separate private call.
- `Store` is a separate shared-work scenario, not another panel inside the media implementation.
- Every browser tab is an automatically registered client. No `me=A&peer=B` setup is required.

## 1. Store scenario

Use a small operations board with work items (`new` -> `active` -> `done`). It is familiar enough to read immediately and rich enough to expose the important Store behavior.

- A server-owned authoritative Store holds work items and their revisions.
- Commands validate intent and mutate the authoritative Store; clients do not write arbitrary server paths.
- A client mirror renders the initial keyframe and subsequent per-key changes through the replay Store API.
- Creating, renaming, assigning, moving, and deleting an item in one tab updates every connected tab without reload.
- The UI exposes `connecting`, `live`, `reconnecting`, and `stale` states instead of hiding transport lifecycle.
- Reconnect resumes from the last sequence when possible and falls back to a keyframe when history is unavailable.
- Optimistic UI is limited to pending command presentation; authoritative confirmation or rejection remains visible and deterministic.
- A small integration note beside the factory explains the boundary: commands carry intent, Store/replay carries shared state.

Suggested example boundaries:

- `createWorkboardHost(deps)` owns validation, revisions, commands, and the exposed replay resource.
- `createWorkboardClient(deps)` owns the mirror, connection status, command receipts, and its public UI-facing API.
- `setupWorkboardDemo(deps)` only binds DOM events and rendering to the client facade.

## 2. Business-like presentation pass

- Add a restrained application shell, section navigation, a connection/account header, and consistent spacing and typography.
- Give Rooms a room list, participant sidebar, primary media stage, compact local preview, and explicit camera/microphone/screen/call controls.
- Give Store a toolbar, status filters, item counts, board/list content, and a compact activity/status area.
- Cover empty, loading, reconnecting, permission-denied, unavailable-device, and command-error states.
- Keep the layout useful on a laptop and a narrow mobile viewport.
- Use plain HTML/CSS and small factories already used by the stand; do not introduce a design system or frontend framework.

## 3. Code quality constraints

- Keep resource adapters, Store/media business rules, and DOM presentation in separate factories.
- Reuse existing library surfaces before adding any new public API.
- Add short comments only at integration decisions that an AI or a new consumer could otherwise misunderstand.
- Do not turn the example into a method catalogue. Each API call must serve the visible scenario.
- Keep the browser entry point as composition code; move non-trivial behavior into named factories.

## Acceptance

- Three tabs appear as three participants without URL identity parameters.
- Joining a room shows all publishers in that room; video, microphone, screen sharing, and private calls have visible state and cleanup.
- A Store mutation in one tab appears in the other tabs without reload and with the same authoritative revision.
- Closing and reopening a tab demonstrates reconnect/catch-up without duplicated work items.
- External HTTPS/WSS testing passes through the documented public endpoint with no browser console errors.
- Unit/publish tests and the complete oracle suite stay green.
- The demo source remains readable as copyable integration code.

## Delivery order

1. Extract the common application shell and status components without changing behavior.
2. Implement the authoritative workboard host and its real-socket oracle.
3. Implement the client mirror and Store screen, including reconnect and rejection states.
4. Apply the shared visual language to Rooms and finish responsive/error states.
5. Verify locally and through public HTTPS/WSS with multiple tabs, then prepare the next patch release.
