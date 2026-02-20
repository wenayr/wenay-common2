# math

Набор общих утилит и компонентов для TypeScript/Node проектов.

Подробности по модулям: `DOCS.md`.

Карта модулей и что в них искать:
- `src/Common/common.ts` — базовые утилиты (глубокое/поверхностное сравнение и клонирование, бинарный поиск `BSearch*`, конвертация чисел, таймеры, mutex, вспомогательные структуры).
- `src/Common/BaseTypes.ts` — типы `Immutable/Mutable`, `const_Date`, типовые утилиты.
- `src/Common/Time.ts` — таймфреймы `TF`, периодика `Period`, форматирование времени, конвертация дат.
- `src/Common/List.ts` — двусвязный список `CList` и иммутабельные интерфейсы.
- `src/Common/ListNodeAnd.ts` — альтернативный двусвязный список узлов с контрольным элементом.
- `src/Common/ByteStream.ts` — бинарная сериализация: `ByteStreamW` (write) и `ByteStreamR` (read), поддержка числовых типов и массивов.
- `src/Common/Decorator.ts` — декораторы/трансформеры функций (до/после вызова, обработка результата).
- `src/Common/MemoFunc.ts` — мемоизация с TTL и лимитами.
- `src/Common/Listen.ts` — подписки/события, сокет‑обёртки и утилиты для проксирования колбэков.
- `src/Common/event.ts` — коллекции обработчиков событий (списки/массивы).
- `src/Common/waitRun.ts` — throttle/debounce и асинхронные очереди.
- `src/Common/WebHook2.ts` — webhook сервер/клиент на Express.
- `src/Common/SocketServerHook.ts` — обвязка подписок по тегам для сокет‑обмена.
- `src/Common/commonsServer.ts` и `src/Common/commonsServerMini.ts` — фасад RPC поверх сокетов (сервер/клиент/строгая схема).
- `src/Exchange/Bars.ts` — модели баров/таймсерий и сериализация через `ByteStream`.

WebHook2 (быстрый ориентир):
- Сервер: `createWebhookServer({ authToken, port, app? })`
- Клиент: `createWebhookClient({ serverUrl, clientPort, authToken, autoRenew? })`
- Поддерживается старый и новый формат поля тега в `subscribers.json` (`tag` и `tags`).

commonsServerMini (быстрый ориентир):
- `createAPIFacadeServer` — серверный фасад RPC поверх сокета.
- `createAPIFacadeClient` — клиентский фасад RPC (обычные вызовы, void‑вызовы, строгий режим).
- `promiseServer`/`wsWrapper` — низкоуровневые обвязки запрос/ответ + колбэки.
