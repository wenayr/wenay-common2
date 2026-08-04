
Here is a comprehensive guide in a concise style. I've taken into account the architecture, backend, frontend (with the new `Hub` pattern), serialization nuances, limits, and hooks.

# wenay-common2 RPC: Complete Guide

Bidirectional, strongly-typed RPC protocol over sockets (Socket.IO or similar).
**Essence:** Server exposes a nested JS object $\to$ Client receives a typed proxy.
**Auth:** in-band tokens (`Pkt.HELLO`), see §5. Before writing any auth code read the canonical page
**[`doc/RPC-AUTH.md`](doc/RPC-AUTH.md)** — §5 is its compressed mirror, not a substitute.

---

## 1. Architecture and Limitations

*   **Multiplexing:** A single physical socket hosts independent channels (`socketKey`), each with its own API object.
*   **Data Types:** Works with JSON-compatible data plus `Date`, `Map`, `Set`, `RegExp`, and `BigInt`. Class instances are sent as plain enumerable object data; methods/prototypes are not preserved.
*   **Reserved keys:** those types travel as single-key marker objects, so `$_d` `$_m` `$_s` `$_r` `$_b` `$_f` `$_t` are the codec's — a plain object of yours whose **only** key is one of them is decoded as a library value on the far side. Add a second key to any such object, or avoid the keys. Full contract (accepted payload per key, which direction each applies to, and how to make a collision report itself with `debug`) is in **[`doc/wenay-common2-rare.md`](doc/wenay-common2-rare.md)** under "RPC application wire".
*   **Security (RpcLimits):** Server is protected from DDoS attacks. Strict limits on: `maxDepth`, `maxKeys`, `maxArrayLen`, `maxStringLen`, `maxCallbacks`. Exceeding throws `PayloadLimitError`.

---

## 2. Server (Backend)

### 2.1 Socket Connection
```typescript
import { createRpcServerAuto, listen } from "wenay-common2";

io.sockets.on('connection', (socket) => {
  // 1. Create unsubscribe trigger for memory cleanup
  const [stop, listenStop] = listen<[]>();
  socket.on('disconnect', stop);

  // 2. Initialize RPC channel on this socket
  createRpcServerAuto({
    socket,
    socketKey: "mainAPI",         // Channel identifier
    object: buildFacade(client),  // Target API object
    disconnectListen: listenStop, // Auto-unsubscribe from Listen on disconnect
    debug: process.env.DEV,       // Packet logging
  });
});
```

### 2.2 Building API Object (Facade)
The object is traversed by the server to build a "Schema" that is sent to the client.
```typescript
import { noStrict, listen } from "wenay-common2";

// Create pub/sub event system
const [sendEvent, listenEvent] = listen<[string]>();

export function buildFacade(client) {
  const role = (...roles) => hasRole(client, roles) ? true : null;

  return {
    // 1. Regular method
    ping: () => "pong",

    // 2. Nested namespaces + Role model
    // If role() returns null, the method won't be sent to the client (returns null in schema)
    admin: {
      deleteUser: role("admin") && ((id) => db.delete(id)),
    },

    // 3. Dynamic objects (Proxy, ORM)
    // Wrap in noStrict so the server doesn't try to read keys.
    // Client will work with it in "blind" mode (without schema).
    dbRef: noStrict(getProxyDb()),

    // 4. Events
    // Client will receive a Listen surface: .on(cb), .once(cb), .close()
    events: { listenEvent },

    // 5. Method with callback in arguments
    // Callback lives ONLY while await is executing! After return, client deletes it.
    stream: async (cb: (chunk: number) => void) => {
      for(let i=0; i<10; i++) { cb(i); await sleep(50); }
      return "done";
    }
  };
}
```

### 2.3 Server Hooks (Interceptors)
Use hooks to validate incoming packets.
```typescript
createRpcServerAuto({
  /*...*/
  hooks: {
    onRequest: async ({ key, request, fnName, fn }) => {
      // Return false to block the call
      return true;
    },
    onInvalid: ({ reason, key, request }) => {
      console.warn(`RPC Attack/Error [${reason}]:`, key);
    }
  }
})
```

---

## 3. Client (Frontend)

**Hub Pattern:** The frontend library doesn't depend on `socket.io-client`. Developer injects the socket factory into `createRpcClientHub`.

### 3.1 Hub Initialization
```typescript
import { io } from "socket.io-client";
import { createRpcClientHub, rpc } from "wenay-common2";
import type { MainFacade } from "../server/facade";

export const Api = createRpcClientHub(
  // 1. Socket factory (DI).
  // The token does NOT belong here: RPC presents it in-band via Pkt.HELLO.
  // A `query: { token }` handshake copies credentials into access logs, proxies and Referer.
  () => io("http://localhost:4021", {
    transports: ["websocket"]
  }),

  // 2. Channel registration
  // rpc() accepts Facade type. Property name ("mainAPI") becomes socketKey.
  (rpc) => ({
    mainAPI: rpc<MainFacade>(),
  }),

  // 3. Token lifecycle (optional): ONE function, consulted on connect, on a server
  // auth-state push, and on the unauthorized retry. Providing it also starts the hub,
  // so the application never calls connect().
  { token: async () => (await fetch("/session/token", { credentials: "include" })).text() }
);
```

Without `hubOpts.token`, present the token explicitly: `await Api.connect(token)` (hard rotation) or
`await Api.reauth(token)` (soft, on the live socket). Either way the token reaches the server in
`Pkt.HELLO`, never in the socket handshake. Details → §5 and [`doc/RPC-AUTH.md`](doc/RPC-AUTH.md).

### 3.2 Connection Lifecycle

`onConnect` and `onDisconnect` are legacy single-slot setters: each call replaces the previous callback, and passing `null` clears that slot. Use the additive listeners when several independent consumers need lifecycle events.

```typescript
// Legacy single-slot callbacks.
Api.onConnect((count) => console.log(`Socket connected (attempt ${count})`));
Api.onDisconnect((reason) => console.log(`Socket disconnected: ${reason}`));

// Additive listeners. Each off handle removes only its own callback.
const offConnect = Api.connectListen((count) => console.log(`Observer connected: ${count}`));
const offDisconnect = Api.disconnectListen((reason) => console.log(`Observer disconnected: ${reason}`));

// Hard connect/token generation. The promise resolves after the RPC handshake.
await Api.connect("USER_SECRET_TOKEN");

// Calls inside onConnect/connectListen are safe: those callbacks also run after the handshake.
offConnect();
offDisconnect();
```

A transient Socket.IO disconnect on the same socket suspends transport without ending logical Listen consumers. After automatic reconnect, the hub recreates one physical subscription for every still-active deduplicated Listen; consumers removed while offline are not restored.

Only logical Listen subscriptions are recovered. Pending or failed ordinary RPC calls and pipelines are not retried, because repeating them could duplicate side effects.

`client.dispose()` is terminal for that RPC client. `Api.setToken(token)` and its `Api.connect(token)` alias are hard rotations: the old socket/client generation and its subscriptions are permanently closed, and the new facade starts without inherited subscriptions. `connect(null)` starts a new anonymous generation; it is not a transient reconnect.

### 3.3 Call Modes
Access API channel: `Api.facade.mainAPI`. Hub initializes all channels, so schema loads automatically.

```typescript
const api = Api.facade.mainAPI;

// Wait for schema (REQUIRED before UI render)
await api.ready();

// --- 1. STRICT (Recommended) ---
// Safe call. Use `?.` since method may be `null` (closed by roles).
// If method is closed, returns `undefined` without sending network request.
const res = await api.strict.admin?.deleteUser?.(5);

// **TIP:** You can save .strict reference to avoid repetitive code:
// Works in ALL modes (strict, func, pipe, space, all)
const orchestrator = Api.facade.orchestrator?.strict;
await orchestrator?.repositories?.getAll?.();

// **IMPORTANT: Optional chaining for methods**
// - Use `?.` ONLY if method can be filtered by roles on backend
// - If backend has NO role filtering, method is ALWAYS available - skip `?.`
// Example: if backend has no roles, use .all mode instead:
const orchestrator = Api.facade.orchestrator?.all;
await orchestrator.repositories.getAll();  // No `?.` needed!
await orchestrator.deployments.getAll();   // Cleaner code!

// --- 2. FUNC (Standard) ---
const res2 = await api.func.ping();

// --- 3. PIPE (Pipeline) ---
// Entire chain goes to server in ONE network packet.
const data = await api.pipe.dbRef.users.find(1).getName();

// --- 4. SPACE (Fire-and-Forget) ---
// Doesn't wait for response, Promise resolves immediately.
api.space.admin.logAction("clicked");
```

### 3.4 Client Subscriptions (Listen)
`createRpcServerAuto` exposes server `listen` / `createListen` values as RPC Listen nodes. New code uses `on`/`once` and keeps the returned `off` handle. For TypeScript, project `client.func` to `DeepSocketListen<ServerFacade>`; this mirrors the runtime shape and keeps event argument types.
```typescript
import type { DeepSocketListen } from "wenay-common2";

function webListen<T extends object>(client: { func: unknown }) {
  return client.func as DeepSocketListen<T>;
}

const events = webListen<MainFacade>(api).events;

// Subscribe
const off = events.listenEvent.on((msg) => {
  console.log("Push from server:", msg);
});

// Unsubscribe. The handle is callable and also thenable.
off();
// await off; // waits until the stream ends

// One event, then automatic unsubscribe
const done = events.listenEvent.once((msg) => {
  console.log("First push:", msg);
});
await done;
```

Compatibility names `.callback(cb)`, `.removeCallback()`, and `.unsubscribe()` still exist for old clients, but they are not the recommended API.


### 3.5 Request Management and Debug
Each facade has a system object `api` for low-level control, as well as a couple of methods in the root:

```typescript
const { api, abortAll, schema } = Api.facade.mainAPI;

// --- 1. Monitoring and Debug ---
api.pending();          // Current number of pending responses (Promises)
api.callbacks();        // Current number of live callback ids in memory
api.log(true);          // Enable logging of all incoming/outgoing packets to console

// --- 2. Targeted cleanup (inside .api) ---
api.clearPromises(true); // Reject (cancel) all current requests
api.clearCallbacks();    // Force clear all callbacks
api.remove(myFunc);      // Force-release a specific callback id (alias: .end)

// --- 3. Global facade methods ---
abortAll("User logout"); // Hard reset: reject all promises with RPC_ABORT error + clear all callback ids
const map = schema();    // Get raw schema tree (MAP) sent by server
```


---

## 4. Advanced Features

### 4.1 Listen Argument Interception Modes
When using events, the client auto-handler (`mode: "smart"`) by default flexibly adapts arguments. If server sends one argument — it comes as a value, if multiple — as an array.
If you create a client manually without Hub, you can set a strict mode:
```typescript
// "first" — listener always receives only the first argument
// "all" — listener always receives all arguments
// "smart" — (default) auto-detection
const autoApi = createRpcClientAuto(api.func, { mode: "first" });
```


### 4.2 Manual Callback Termination from Server
This is a low-level escape hatch for callbacks passed as ordinary function arguments. For Listen subscriptions prefer `off()`/`.once()`.
```typescript
import { endCallback } from "wenay-common2";

async function myMethod(cb: (data: any) => void) {
  cb("chunk 1");
  endCallback(cb); // Alias: rpcEndCallback. Sends "___STOP" to client.
  // Client callback id is deleted, subsequent cb() calls won't go anywhere.
}
```

### 4.2.1 Flow-Paced Streaming Callbacks (Backpressure)
The sibling of `endCallback`: one marks the END of a stream, this one PACES it. A server method
that pushes many chunks through a client-supplied callback wraps it once — `push()` sends the
frame exactly like `cb()` would and resolves when it is OK to produce more:
```typescript
import { flowCallback } from "wenay-common2";

async function readBackStream(a: tArgs, cb: (page: tPage) => void) {
  const flow = flowCallback(cb, { window: 100 }); // window: max unacked frames in flight
  while (hasMore) {
    await flow.push(await readNext()); // stalls ONLY when the client genuinely lags
  }
  return { total }; // promise open => callback alive (§2.2.5) — unchanged
}
```
Two independent signals gate `push`, negotiated like every wire feature (`Caps.CB_FLOW`,
`opt.flowCallback`, on by default):
- **Credit window** (new peers): the client runtime acks cumulatively (`Pkt.CB_ACK`, coalesced —
  one per `ackEvery` frames, never one per frame) after delivering each frame to the app
  callback — and if that callback returns a promise, after it settles. An async consumer
  (`async (page) => { await db.put(page) }`) therefore paces the server by its real speed.
  Frames of a flow stream are delivered sequentially: the next after the previous settles.
- **Local watermark** (fallback, old peers): `pending() > highWater` suspends until
  `<= lowWater` (`{pending, highWater, lowWater, pollMs}` — the replay lag-gate vocabulary;
  default `pending` probes the socket.io write buffer when available).

On a fast link acks refill the window before it drains — the producer streams at full speed and
never stalls. Disconnect, `endCallback`, or the method promise settling reject pending `push`es
with `MyError('E_FLOW_CLOSED')`, so producer loops exit instead of hanging. On a callback that
did not come over the wire (local call, tests) the wrapper is a transparent pass-through.
Methods that never wrap their callback are byte-identical on the wire.

**Recipe — resumable flow stream.** A flow stream is call-scoped: the callback dies with the
connection, so "continue after reconnect" is NOT a server buffer — the resume point is a method
argument, because only the client knows what it durably consumed. The server keeps nothing:
```typescript
// server: the source (disk pages, a scan) is already durable — serve from the cursor
async function readBackStream(a: { from?: number }, cb: (page: tPage) => void) {
  const flow = flowCallback(cb, { window: 100 });
  let seq = a.from ?? 0;
  try {
    for (let page = await readAfter(seq); page; page = await readAfter(seq)) {
      await flow.push(page);
      seq = page.seq;
    }
  } catch (e: any) {
    if (e?.code !== 'E_FLOW_CLOSED') throw e; // disconnect: exit quietly, client will resume
  }
  return { last: seq };
}

// client: remember the last page it SAVED, resume from it after any reconnect
let last = await db.lastSavedSeq();
await api.func.readBackStream({ from: last }, async (page: tPage) => {
  await db.put(page);      // the ack (and so the server's pace) follows this settle
  last = page.seq;
});
```
For LIVE events that must survive the client's absence this recipe is wrong by construction —
that is a replay line's job (`exposeStoreReplay` + `since`, optionally `openFsSpillJournal` /
`openFsReplayStorage` behind it, see 🎞️/💾 in the library docs).

### 4.3 Call / Apply Support on Client
The client proxy can transparently handle standard JS `call` and `apply` calls. Server correctly normalizes them ("collapses" the path):
```typescript
// Both variants correctly call `api.users.create("Ivan")` on server
await api.func.users.create.call(null, "Ivan");
await api.func.users.create.apply(null, ["Ivan"]);
```


### 4.4 Transparent PIPE Request Transit
For microservice architecture. If your Node server itself is a client of another RPC node (via `pipe`), it can "pass through" the remainder of the pipe chain further using `__executeRemainingPipe`, without waiting for an intermediate response.
This covers the important RPC mechanics (Listen `on/once/off`, `endCallback`, `call/apply`, `pipe-transit`) while maintaining readability.
```typescript

/**
 * Extract orchestrator type from Api facade
 */
export type OrchestratorFacade = NonNullable<typeof Api.facade.orchestrator>['strict'];

/**
 * Hook for RPC initialization and facade access
 */
export function useOrchestrator() {
    const [rpcInitialized, setRpcInitialized] = useState(false);

    useEffect(() => {
        Api.connect(null); // Connect without token
        Api.facade.orchestrator?.ready().then(() => {
            setRpcInitialized(true);
        });
    }, []);

    // Use .all mode for simpler code without optional chaining when no role filtering
    const orchestrator = Api.facade.orchestrator?.all;

    return { orchestrator, rpcInitialized };
}

```

---

### 4.5 Negotiated wire options (`opt`)

Every wire optimization is one capability bit, advertised by both peers and used only when both
advertise it — a peer that does not is unaffected, byte for byte. Pass `opt` to
`createRpcServer`/`createRpcServerAuto` and to the client or hub.

```typescript
createRpcServerAuto({ socket, object, socketKey: "mainAPI", opt: { compactRows: false } });
```

| `opt` | Default | What it does |
|---|---|---|
| `compact` | on | a repeated subscription-tick shape travels as values only (`Pkt.SHAPE`/`Pkt.CBV`) |
| `callbackBatch` | on | same-microtask callback packets share one frame (`Pkt.CB_BATCH`) |
| `compactRows` | on | an array of uniform records travels as its keys once plus rows of values |
| `requestBatch` | **off** | `CALL`/`PIPE` and `RESP` share one frame too (`Pkt.BATCH`) — opt in when calls are concurrent |

`compactRows` is the one that touches ordinary results. An array of 4+ plain objects with the same
keys in the same order becomes `{"$_t": [shapeId, rows, keys]}` instead of repeating every key name
per record: measured at **127 912 → 70 983 bytes (−44.5 %)** for a 1000-record result, with p50 down
24 % and CPU per call unchanged (`experiments/rpc-perf-2026-07`). Key order is preserved, `Date` and
the other marker types keep working inside records, and an array whose values would change meaning by
moving into a row (`undefined`, functions, symbols) is simply not compacted. Turn it off with
`{compactRows: false}` if you need the previous byte layout.

`requestBatch` is the only bit off by default: it re-frames the request path and buys nothing when
calls are issued one at a time. Decode-side limits and the registry's lifetime →
[`doc/wenay-common2-rare.md`](doc/wenay-common2-rare.md).

---

## 5. Authorization (in-band tokens)

> Compressed mirror of **[`doc/RPC-AUTH.md`](doc/RPC-AUTH.md)** — the canonical page, with a
> ✅/❌ pair per rule, the exact signatures and the documented limits. Read it before writing
> auth code.

The client presents a token in `Pkt.HELLO`; the server verifies it and replaces the served object
with a facade built for that principal, then answers `Pkt.MAP` whose 5th element is `authAck`.
Token lifetime, expiry and revocation are pushed back as `Pkt.AUTH` (negotiated by `Caps.AUTH_STATE`).
When the grant declared a deadline, the server attaches it to the ack under one reserved key:
`ack.$rpc = { expiresAt }` — attached on a copy, so your own ack is never clobbered, and optional by
contract (absent for an old server, a non-object ack, an ack that already owns `$rpc`, or no deadline).

### 5.1 Server: empty initial facade + `gate: true`

```typescript
const { api, control } = createRpcServerAuto({   // control = revoke/grant for THIS connection, §5.5
  socket, socketKey: "mainAPI",
  object: {},                 // schema answers a pre-HELLO STRICT, and is the downgrade target
  auth: {
    gate: true,               // CALL/PIPE before a successful HELLO -> MyError code "E_UNAUTHORIZED"
    resolveAuth(token) {
      const verdict = codec.verify(token);
      if (!verdict.ok) throw new Error(verdict.reason);                          // TRANSIENT: session survives
      if (banned.has(verdict.claims.jti))
        throw Object.assign(new Error("banned"), { revoke: true });              // HARD: full downgrade
      return {
        object: buildFacade(verdict.claims),   // the protected surface — one facade per principal
        ack: { ok: true, sub: verdict.claims.sub },
        expiresAt: verdict.claims.exp,         // absolute ms; Infinity = no deadline
        renewBeforeMs: 30_000,                 // "expiring" lead time (default 30s)
      };
    },
  },
});
```

Both parts are required. `gate` guards `CALL`/`PIPE` only — it does **not** gate `Pkt.STRICT`, so
anything left in `object` is public schema. Prune per principal with the `role()` idiom of §2.2: a
method absent from the schema is stronger than a method that checks.

### 5.2 Client: one token provider

```typescript
// Hub: hubOpts.token owns the whole lifecycle (see §3.1). Observers are additive.
const off = Api.authListen(({ key, state, reason }) => console.log(key, state, reason));
// state: "expiring" | "expired" | "revoked"   — server, on the wire
//      | "renewed"  | "renewFailed"           — local outcome of an AUTOMATIC renewal, never on the wire

// Bare client (no hub): the same seam, one facade.
const c = Api.facade.mainAPI;
c.setTokenRenew(async ({ reason, notice }) => await mintToken(reason));  // "connect"|"notice"|"unauthorized"
c.onAuthState((e) => console.log(e.state, e.reason, e.expiresAt));
await c.auth();            // current authAck. null = server without auth; a client that presented
                           //   NO token answers locally {ok:false, reason:"RPC client presented no token"}
                           //   instead of hanging. ack.$rpc?.expiresAt = this grant's deadline, if any.
await c.reauth(newToken);  // soft re-auth on the live socket: subscriptions preserved
```

Each `reauth()` settles on the answer to its own HELLO (negotiated `Caps.HELLO_ID`), so an
unsolicited MAP — a downgrade landing mid-flight — never resolves it with a stale ack. Still do not
run concurrent `reauth()`s: the server keeps one principal per `socketKey`, so racing tokens end in
whichever HELLO it resolved last.

`renewBeforeMs` before the deadline the server pushes `"expiring"`; at the deadline it pushes
`"expired"` and rolls the principal back to the constructor object. Every push reaches the observers
**and** triggers the renewer, whose token is presented with a soft `reauth()`. A renewer that yields
nothing — or the token already in force — reports `"renewFailed"` and stops; a renewal the server
acknowledged reports `"renewed"`, carrying `expiresAt` when the new grant declared one.

`"renewed"`/`"renewFailed"` are the two outcomes of an **automatic** renewal and are added by the
client. Deliberately silent: a manual `reauth()` resolves with that very ack (deadline included), and
an application `control.grant` (§5.5) arrives as an unsolicited MAP, not through the renewal seam —
neither emits an event. The stream reports what happens without being asked.

Single-flight is two-level: one renewal per client, and one provider call per wave across all facade
clients.

**Precedence — an explicit token owns ONE connection wave.** `connect(token)`/`setToken(token)` win
for the wave they raise, for every facade client of that wave. Every *later* wave (a transport
reconnect, a server generation change) asks the provider again — a token pinned for the life of the
hub would be re-presented forever, including one the server already revoked. `reauth(token)` claims
no wave at all: its handshake is the HELLO it issues itself. Every renewal trigger
(`"expiring"`/`"expired"`/`"revoked"`/`"unauthorized"`) always goes to the provider. A provider that
yields nothing is not a downgrade — the client keeps the token already in force.

### 5.3 The one retry, and what it excludes

An `E_UNAUTHORIZED` rejection triggers **exactly one** extra attempt after the renewed principal is
presented. Retried: a waiting `func`/`strict` call with no callbacks in its arguments, and only when
a renewer is installed. Never retried: `space` (fire-and-forget — no reply channel), any call whose
arguments carried a callback, `pipe`, and Listen subscription attempts.

### 5.4 A privilege decrease cuts streams

Re-auth to a narrower principal tears down the Listen nodes the new facade no longer declares: each
subscriber gets a clean stream end (`RPC_STOP` → `CB_END`), so `await off` resolves instead of
hanging. **Limit:** Listen nodes inside a `noStrict(...)` subtree are never walked, so they are never
torn down — if a node must be revocable, keep it out of `noStrict`.

### 5.5 Server-driven revocation: the `control` facet

`resolveAuth` runs only on a HELLO, so `revoke: true` needs the client to ask. An admin action, a
logout from another device or a fraud signal has none. `createRpcServer`/`createRpcServerAuto`
therefore **return** `control` — commands inward over this one connection's principal:

```typescript
import { createRpcServerAuto, type RpcServerControl } from "wenay-common2";

const sessions = new Map<string, RpcServerControl>();          // filled in io.on("connection")
const { api, control } = createRpcServerAuto({ socket, object: {}, socketKey: "mainAPI", auth });

control.revoke("password changed");        // -> boolean; false ONLY means "connection detached"
control.grant({ object: facadeFor(claims), ack: { ok: true }, expiresAt });   // -> boolean
```

`revoke` **is** the expiry corridor — there is no second downgrade path. The client sees exactly what
an expired token produces: `Pkt.AUTH` first, then the Listen nodes the base facade no longer declares
end with `RPC_STOP`/`CB_END`, then a `Pkt.MAP` with `authAck {ok:false, state, reason}`; gated calls
reject with `E_UNAUTHORIZED` again. Only the state name differs (`"revoked"` vs `"expired"`).

`grant` is the HELLO success path without the question — same facade/ack/deadline/timers, but
uncorrelated, so it can never settle a pending `reauth()` (and emits no `"renewed"`, §5.2). Both are
safe before any HELLO, twice in a row and after detach; `revoke` clears the grant's timers, and an
application revocation is not undone by a `resolveAuth` that started before it.

### 5.6 `createTokenCodec` is a default, not a security product

`import { createTokenCodec } from "wenay-common2/server"` gives one honest default: one secret, one
pinned algorithm, one expiry (`issue` / `verify`, default TTL 15 min). No JWT, no key rotation, no
revocation list, no refresh flow, no identity provider — those are the application's.
