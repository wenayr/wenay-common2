# Карта переименований

Breaking migration: старые имена не оставляем алиасами.

| Было | Стало |
| --- | --- |
| **3.0.0 — exchange data is the separate package `wenay-exchange`** (peer: this package) | |
| `import {Bars} from 'wenay-common2'` · `from 'wenay-common2/client'` | `import {Bars} from 'wenay-exchange'` |
| `CQuotesHistory` / `CQuotesHistoryMutable*` and the other `IHistoryBase`, `LoadBase`, `MarketData` root names | the same names from `'wenay-exchange'` (`TF`, `Period`, the time API and `Params` stay here) |
| **3.0.0 — export aliases and axios** | |
| `wenay-common2/lib/client` · `wenay-common2/lib/server` | `wenay-common2/client` · `wenay-common2/server` |
| `createWebhookClient(...).status(tag)` → `AxiosResponse` | `{status, data: {subscribed, expireAt?}}` |
| webhook client rejections: `AxiosError` (`error.response.status`) | `HttpStatusError` (`error.status`, `method`, `url`) |
| **2.16.0 — Scale tier (breaking, before the tier's first publication)** | |
| `createAuthority({storeId, originId, nodeId, lineId, initial, selfUrl, weight, heartbeatMs, acceptNode, meta, commands, limits, receipts, renewBeforeMs})` | `createAuthority({line: {storeId, originId, nodeId, lineId, initial}, roster: {url, weight, heartbeatMs, staleMs, acceptNode, meta}, corridor: {commands, limits, receipts}, identity: {..., renewBeforeMs}})` |
| `authority.directory` | `authority.roster` (`api` = the nodes PROJECTION line) |
| `authority.serve.browser().directory` | `authority.serve.browser().roster` |
| `nodeLink().directory` / `.revoked` / `.receipts` | `nodeLink().control` (ONE line) |
| `AuthorityUpstream.directory/revoked/receipts` · `StoreNodeUpstream.directory/revoked` | `.control` |
| `createStoreNode({nodeId, storeId, originId, lineId, initial, weight, heartbeatMs, graceMs, selfUrl, serve, wrap, socketKeys, opt})` | `createStoreNode({line: {...}, roster: {url, weight, heartbeatMs, graceMs}, serve: {onConnection, wrap, keys, opt}})` |
| `createClusterClient({storeId, originId, nodeId, lineId, initial, directory, placement: {staleMs}})` | `createClusterClient({line: {...}, roster, placement: {…}})` (no staleMs) |
| `createNodeDirectory({lineId})` · `control.upsert(row)` | `createNodeDirectory({store?, staleMs, sweepMs})` · `control.set(row)` (+ `patch`, `grace`, `sweep`) |
| `NodeDirectoryEntry.ts` · `NodeDirectoryView.stale` | `alive` + `since` (owner-published) · `eligible` only |
| `nodeDirectoryViews(state, {staleMs, now})` | `nodeDirectoryViews(nodesSection)` |
| `followNodeDirectory(remote, {staleMs, now, ...}).follow` | `followNodeDirectory(remote, {initial?, staleMs?, expose?}).store` (+ `onNode`, `api`) |
| `createCommandReceipts({lineId})` (replicated map) | `createCommandReceipts({store?, initial?, replay?})` (Store section; `api` null when embedded) |
| `UseListen` | `listen` |
| `UseListenStore` | `listenStore` |
| `UseListen2` | `slimListen` |
| `toListen2` | `toSlimListen` |
| `UseListenTransform` | `mapListen` |
| `funcListenCallbackBase` | `createListen` |
| `funcListenCallbackFast` | `createFastListen` |
| `funcListenCallbackStore` | `createStoreListen` |
| `funcListenCore` | `createListenCore` |
| `addListen` | `on` |
| `removeListen` | `off` |
| `eventClose` | `onClose` |
| `removeEventClose(cb)` | `const off = onClose(cb); off()` |
| `addListenClose` | `closeOn` |
| `tSubHandle` | `SubscriptionHandle` |
| `PromiseArrayListen` | `promiseProgress` |
| `listenOk` / `listenError` | `onOk` / `onError` |
| `promise.all()` / `promise.allSettled()` | `all()` / `allSettled()` |
| `getData()` / `status()` | `items()` / `stats()` |
| `realSocket2` | `SocketSource` |
| `getTypeCallback` | `SocketPayload` |
| `socketBuffer3` | `socketBuffer` |
| `funcListenCallbackSnapshot` | `listenSnapshot` |
| `createRpcServerAuto2` | `createRpcServerAutoDetect` |
| `UseReplayListen` | `replayListen` |
| `ListenNext` | root exports from `wenay-common2` (`listen`, `listenStore`, `slimListen`) |
| `wenay-common2/listen2` | removed; use root exports from `wenay-common2` |
| `ObserveAll2` | `Observe` |
| `wenay-common2/observe-all2` | `wenay-common2/observe` |
| `src/Common/ObserveAll2` | `src/Common/Observe` |
