# Карта переименований

Breaking migration: старые имена не оставляем алиасами.

| Было | Стало |
| --- | --- |
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
