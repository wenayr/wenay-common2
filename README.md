# wenay-common2

Набор общих утилит и компонентов для TypeScript/Node.js проектов.

## 📦 Структура библиотеки

### 🔧 **core/** — Базовые утилиты
- **`common.ts`** — глубокое/поверхностное клонирование и сравнение, бинарный поиск (`BSearch*`), конвертация чисел, таймеры, mutex, вспомогательные структуры (`MyMap`, `StructMap`), работа с буфером обмена
- **`BaseTypes.ts`** — типы `Immutable`/`Mutable`, `const_Date`, типовые утилиты (`PickTypes`, `OmitTypes`, `KeysByType`)
- **`Decorator.ts`** — декораторы/трансформеры функций (до/после вызова, обработка результата)
- **`MemoFunc.ts`** — мемоизация с TTL и лимитами, эвикция по LRU

### 📊 **data/** — Структуры данных и сериализация
- **`List.ts`** — двусвязный список `CList` с иммутабельными интерфейсами
- **`ListNodeAnd.ts`** — альтернативный двусвязный список узлов с контрольным элементом
- **`ByteStream.ts`** — бинарная сериализация: `ByteStreamW` (write) и `ByteStreamR` (read), поддержка числовых типов и массивов
- **`objectPath.ts`** — работа с путями в объектах (`objectGetValueByPath`, `objectSetValueByPath`, итерация `iterateDeepObjectEntries`)

### ⏱️ **async/** — Асинхронные утилиты
- **`waitRun.ts`** — throttle/debounce (`enhancedWaitRun`), асинхронные очереди (`createAsyncQueue`, `queueRun`), очередь задач с контролем готовности (`createTaskQueue`)
- **`PromiseArrayListen.ts`** — обработка массива промисов с подписками на успех/ошибку
- **`createIterableObject.ts`** — прокси для итерируемых объектов (readonly/read-write)

### 🔔 **events/** — События и подписки
- **`Listen.ts`** — система подписок (`UseListen`, `funcListenCallback`), проверка `isListenCallback`
- **`event.ts`** — коллекции обработчиков событий (`CObjectEventsArr`, `CObjectEventsList`)
- **`SocketBuffer.ts`** — буферизация сокет-колбэков (`socketBuffer3`, `funcListenCallbackSnapshot`)
- **`SocketServerHook.ts`** — обвязка подписок по тегам для сокет-обмена (`SocketServerHook`, `WebSocketServerHook`)
- **`joinListens.ts`** — объединение нескольких потоков подписок в один (`joinListens`)
- **`listen-socket.ts`** — мост между системой событий и RPC (`listenSocket`, `listenSocketFirst`, `listenSocketAll`, `listenSocketSmart`)

### 🌐 **rpc/** — RPC-система
**Ядро:**
- **`rpc-protocol.ts`** — протокол RPC (типы пакетов `Pkt`, `SocketTmpl`)
- **`rpc-client.ts`** — клиент RPC (`createRpcClient`, `ClientAPI`)
- **`rpc-server.ts`** — сервер RPC (`createRpcServer`, хуки `PromiseServerHooks`)
- **`rpc-walk.ts`** — обход структур (сериализация колбэков, `pack`/`unpack`, `resolveCA`)
- **`rpc-limits.ts`** — лимиты безопасности (`RpcLimits`, `PayloadLimitError`, `isSafeKey`)
- **`rpc-dynamic.ts`** — маркировка динамических объектов (`noStrict`, `isNoStrict`)
- **`id-pool.ts`** — пул переиспользуемых ID (`createIdPool`)

**Автоматизация:**
- **`rpc-client-auto.ts`** — клиент с автоматической подпиской на события (`createRpcClientAuto`, режимы `smart`/`first`/`all`)
- **`rpc-server-auto.ts`** — сервер с автоматической обработкой подписок (`createRpcServerAuto`)
- **`listen-deep.ts`** — глубокая трансформация объектов для подписок (`deepListenFirst`, `deepListenAll`, `deepListenSmart`)

### 📡 **network/** — Сетевые утилиты
- **`WebHook3.ts`** — webhook сервер/клиент на Express
    - **Сервер:** `createWebhookServer({ authToken, port, app? })`
    - **Клиент:** `createWebhookClient({ serverUrl, clientPort, authToken, autoRenew? })`
    - Поддержка старого (`tag`) и нового (`tags`) формата в `subscribers.json`

### ⏰ **time/** — Работа со временем
- **`Time.ts`** — таймфреймы (`TF`), периодика (`Period`), форматирование времени, конвертация дат (`timeToStr_*`, `timeLocalToStr_*`)
- **`funcTimeWait.ts`** — тайм-трекинг запросов по ключам (`funcTimeW`, `FuncTimeWait`)

### 🎨 **utils/** — Вспомогательные утилиты
- **`Color.ts`** — работа с цветами (`ColorString`, `rgb`, генераторы `colorGenerator`, проверка похожести `isSimilarColors`)
- **`Math.ts`** — расчёт корреляции Пирсона (`CorrelationRollingByBuffer`)
- **`isProxy.ts`** — проверка Proxy-объектов (Node.js + браузер)
- **`fsKeyVolume.ts`** — key-value хранилище на файловой системе (`saveKeyValue`)
- **`inputAutoStep.ts`** — автоматическое управление шагом для `<input>` (`SetAutoStepForElement`)
- **`node_console.ts`** — улучшенный вывод в консоль с source maps (clickable links в IDE)

---

## 🚀 Быстрый старт

### Установка
```bash
npm install wenay-common2
```