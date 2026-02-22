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