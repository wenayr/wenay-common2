# wenay-common2

A set of common utilities and components for TypeScript/Node.js projects.

## 📦 Library Structure

### 🔧 **core/** — Base Utilities
- **`common.ts`** — deep/shallow cloning and comparison, binary search (`BSearch*`), number conversion, timers, mutex, helper structures (`MyMap`, `StructMap`), clipboard handling
- **`BaseTypes.ts`** — `Immutable`/`Mutable` types, `const_Date`, type utilities (`PickTypes`, `OmitTypes`, `KeysByType`)
- **`Decorator.ts`** — function decorators/transformers (before/after call, result processing)
- **`MemoFunc.ts`** — memoization with TTL and limits, LRU eviction

### 📊 **data/** — Data Structures and Serialization
- **`List.ts`** — doubly linked list `CList` with immutable interfaces
- **`ListNodeAnd.ts`** — alternative doubly linked list nodes with a sentinel element
- **`ByteStream.ts`** — binary serialization: `ByteStreamW` (write) and `ByteStreamR` (read), support for numeric types and arrays
- **`objectPath.ts`** — working with object paths (`objectGetValueByPath`, `objectSetValueByPath`, iteration via `iterateDeepObjectEntries`)

### ⏱️ **async/** — Async Utilities
- **`waitRun.ts`** — throttle/debounce (`enhancedWaitRun`), async queues (`createAsyncQueue`, `queueRun`), task queue with readiness control (`createTaskQueue`)
- **`PromiseArrayListen.ts`** — processing an array of promises with success/error subscriptions
- **`createIterableObject.ts`** — proxy for iterable objects (readonly/read-write)

### 🔔 **events/** — Events and Subscriptions
- **`Listen.ts`** — subscription system (`UseListen`, `funcListenCallback`), `isListenCallback` check
- **`event.ts`** — event handler collections (`CObjectEventsArr`, `CObjectEventsList`)
- **`SocketBuffer.ts`** — socket callback buffering (`socketBuffer3`, `funcListenCallbackSnapshot`)
- **`SocketServerHook.ts`** — tag-based subscription wrappers for socket communication (`SocketServerHook`, `WebSocketServerHook`)
- **`joinListens.ts`** — merging multiple subscription streams into one (`joinListens`)
- **`listen-socket.ts`** — bridge between event system and RPC (`listenSocket`, `listenSocketFirst`, `listenSocketAll`, `listenSocketSmart`)

### 🌐 **rpc/** — RPC System
**Core:**
- **`rpc-protocol.ts`** — RPC protocol (packet types `Pkt`, `SocketTmpl`)
- **`rpc-client.ts`** — RPC client (`createRpcClient`, `ClientAPI`)
- **`rpc-server.ts`** — RPC server (`createRpcServer`, hooks `PromiseServerHooks`)
- **`rpc-walk.ts`** — structure traversal (callback serialization, `pack`/`unpack`, `resolveCA`)
- **`rpc-limits.ts`** — security limits (`RpcLimits`, `PayloadLimitError`, `isSafeKey`)
- **`rpc-dynamic.ts`** — dynamic object marking (`noStrict`, `isNoStrict`)
- **`id-pool.ts`** — reusable ID pool (`createIdPool`)

**Automation:**
- **`rpc-client-auto.ts`** — client with automatic event subscription (`createRpcClientAuto`, modes `smart`/`first`/`all`)
- **`rpc-server-auto.ts`** — server with automatic subscription handling (`createRpcServerAuto`)
- **`listen-deep.ts`** — deep object transformation for subscriptions (`deepListenFirst`, `deepListenAll`, `deepListenSmart`)

### 📡 **network/** — Network Utilities
- **`WebHook3.ts`** — webhook server/client on Express
  - **Server:** `createWebhookServer({ authToken, port, app? })`
  - **Client:** `createWebhookClient({ serverUrl, clientPort, authToken, autoRenew? })`
  - Support for legacy (`tag`) and new (`tags`) format in `subscribers.json`

### ⏰ **time/** — Time Handling
- **`Time.ts`** — timeframes (`TF`), periodics (`Period`), time formatting, date conversion (`timeToStr_*`, `timeLocalToStr_*`)
- **`funcTimeWait.ts`** — request time tracking by keys (`funcTimeW`, `FuncTimeWait`)

### 🎨 **utils/** — Helper Utilities
- **`Color.ts`** — color handling (`ColorString`, `rgb`, generators `colorGenerator`, similarity check `isSimilarColors`)
- **`Math.ts`** — Pearson correlation calculation (`CorrelationRollingByBuffer`)
- **`isProxy.ts`** — Proxy object detection (Node.js + browser)
- **`fsKeyVolume.ts`** — file system key-value storage (`saveKeyValue`)
- **`inputAutoStep.ts`** — automatic step control for `<input>` (`SetAutoStepForElement`)
- **`node_console.ts`** — enhanced console output with source maps (clickable links in IDE)

---

## 🚀 Quick Start

### Installation
```bash
npm install wenay-common2
```

Here is a comprehensive guide in a concise style. I've taken into account the architecture, backend, frontend (with the new `Hub` pattern), serialization nuances, limits, and hooks.

# wenay-common2 RPC: Complete Guide

Bidirectional, strongly-typed RPC protocol over sockets (Socket.IO or similar).
**Essence:** Server exposes a nested JS object $\to$ Client receives a typed proxy.

---

## 1. Architecture and Limitations

*   **Multiplexing:** A single physical socket hosts independent channels (`socketKey`), each with its own API object.
*   **Data Types:** Works with JSON-compatible data. `Date`, `Map`, `Set`, `Class` **cannot** be transmitted.
*   **Security (RpcLimits):** Server is protected from DDoS attacks. Strict limits on: `maxDepth`, `maxKeys`, `maxArrayLen`, `maxStringLen`, `maxCallbacks`. Exceeding throws `PayloadLimitError`.

---

## 2. Server (Backend)

### 2.1 Socket Connection
```typescript
import { createRpcServerAuto, UseListen } from "wenay-common2";

io.sockets.on('connection', (socket) => {
  // 1. Create unsubscribe trigger for memory cleanup
  const [stop, listenStop] = UseListen<[]>();
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
import { noStrict, UseListen } from "wenay-common2";

// Create pub/sub event system
const [sendEvent, listenEvent] = UseListen<[string]>();

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
    // Client will receive an object with .callback() and .removeCallback() methods
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
  // 1. Socket factory (DI)
  (token) => io("http://localhost:4021", {
    transports: ["websocket"],
    query: token ? { token } : {}
  }),

  // 2. Channel registration
  // rpc() accepts Facade type. Property name ("mainAPI") becomes socketKey.
  (rpc) => ({
    mainAPI: rpc<MainFacade>(),
  })
);
```

### 3.2 Connection Lifecycle
```typescript
// Listen to statuses
Api.onConnect((count) => console.log(`Socket connected (attempt ${count})`));

// Initiate connect. Creates socket, all channels automatically start.
Api.setToken("USER_SECRET_TOKEN");

// Disconnect
// Api.setToken(null);
```

### 3.3 Call Modes
Access API channel: `Api.facade.mainAPI`. Hub automatically calls `initStrict()`, so schema loads automatically.

```typescript
const api = Api.facade.mainAPI;

// Wait for schema (REQUIRED before UI render)
await api.readyStrict();

// --- 1. STRICT (Recommended) ---
// Safe call. Use `?.` since method may be `null` (closed by roles).
// If method is closed, returns `undefined` without sending network request.
const res = await api.strict.admin?.deleteUser?.(5);

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
Hub automatically wraps methods in `createRpcClientAuto`, providing convenient API for events:
```typescript
// Subscribe
api.events.listenEvent.callback((msg) => {
  console.log("Push from server:", msg);
});

// Unsubscribe (sends `___STOP` packet to server)
api.events.listenEvent.removeCallback();
```


### 3.5 Request Management and Debug
Each facade has a system object `api` for low-level control, as well as a couple of methods in the root:

```typescript
const { api, abortAll, schema } = Api.facade.mainAPI;

// --- 1. Monitoring and Debug ---
api.pending();          // Current number of pending responses (Promises)
api.callbacks();        // Current number of live callbacks in memory
api.log(true);          // Enable logging of all incoming/outgoing packets to console

// --- 2. Targeted cleanup (inside .api) ---
api.clearPromises(true); // Reject (cancel) all current requests
api.clearCallbacks();    // Force clear all callbacks
api.remove(myFunc);      // Free memory from specific callback (alias: .end)

// --- 3. Global facade methods ---
abortAll("User logout"); // Hard reset: reject all promises with RPC_ABORT error + clear all callbacks
const map = schema();    // Get raw schema tree (MAP) sent by server
```


---

## 4. Advanced Features

### 4.1 Listen Argument Interception Modes
When using events, the client auto-handler (`mode: "smart"`) by default flexibly adapts arguments. If server sends one argument — it comes as a value, if multiple — as an array.
If you create a client manually without Hub, you can set a strict mode:
```typescript
// "first" — callback always receives only the first argument
// "all" — callback always receives all arguments
// "smart" — (default) auto-detection
const autoApi = createRpcClientAuto(rpc.func, { mode: "first" });
```


### 4.2 Manual Callback Termination from Server
If you passed a callback in function arguments, the server can forcibly terminate it and clear memory on the client before the function completes, by sending a special packet:
```typescript
import { rpcEndCallback } from "wenay-common2";

async function myMethod(cb: (data: any) => void) {
  cb("chunk 1");
  rpcEndCallback(cb); // Sends "___STOP" to client
  // Client callback is deleted, subsequent cb() calls won't go anywhere
}
```


### 4.3 Call / Apply Support on Client
The client proxy can transparently handle standard JS `call` and `apply` calls. Server correctly normalizes them ("collapses" the path):
```typescript
// Both variants correctly call `api.users.create("Ivan")` on server
await api.func.users.create.call(null, "Ivan");
await api.func.users.create.apply(null, ["Ivan"]);
```


### 4.4 Transparent PIPE Request Transit
For microservice architecture. If your Node server itself is a client of another RPC node (via `pipe`), it can "pass through" the remainder of the pipe chain further using `__executeRemainingPipe`, without waiting for an intermediate response.
```
This covers absolutely all library mechanics (Listen modes, `rpcEndCallback`, `call/apply`, `pipe-transit`), while maintaining readability!
```
