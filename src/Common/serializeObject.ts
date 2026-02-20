//
// type SerializedObject = {
//     data: SerializedValue; // Сериализованное значение (с объектами, ссылками или примитивами)
//     meta: {
//         methods: Record<string, string>; // Сохранённые текстовые строки функций
//         cyclic: Record<string, string>; // Циклические пути в объекте
//     };
// };
//
// // Возможные сериализованные значения
// type SerializedValue =
//     | Primitive // Примитивные значения (string, number, boolean, null)
//     | SerializedFunction // Объект функции
//     | SerializedCyclicReference // Циклическая ссылка
//     | { [key: string]: SerializedValue } // Объект
//     | SerializedValue[]; // Массив
//
// // Примитивные данные
// type Primitive = string | number | boolean | null;
//
// // Представление функции в сериализации
// type SerializedFunction = {
//     [typeKey: string]: string; // Тип, например "__type": "function"
//     // id: string; // ID функции в мета-данных
// };
//
// // Представление циклической ссылки
// type SerializedCyclicReference = {
//     [typeKey: string]: string; // Тип, например "__type": "cyclic"
//     // ref: string; // Путь к объекту в дереве сериализации
// };
//
// // Опции для сериализации и десериализации
// interface SerializationKeys {
//     type?: string; // Ключ для обозначения типа (`__type` по умолчанию)
//     id?: string; // Ключ для идентификатора функции (`id` по умолчанию)
//     reference?: string; // Ключ для циклических ссылок (`ref` по умолчанию)
//     functionType?: string; // Значение для типа функций (`function` по умолчанию)
//     cyclicType?: string; // Значение для циклической ссылки (`cyclic` по умолчанию)
// }
//
// interface SerializationOptions {
//     shortenMethods?: boolean; // Уменьшать размер сериализованных методов
//     transformer?: (value: any, path: string) => any; // Трансформация значений
//     keys?: SerializationKeys; // Кастомизация текстовых ключей
// }
//
// const ObjectSerializer = {
//     serialize<T>(
//         obj: T,
//         options: SerializationOptions = {},
//         path = "root",
//         registry = new WeakMap<any, string>(),
//         methodsMap = new Map<Function|string, string>()
//     ): SerializedObject {
//         const meta: SerializedObject["meta"] = { methods: {}, cyclic: {} };
//
//         // Установить текстовые ключи (используем значения по умолчанию, если не указаны)
//         const keys: Required<SerializationKeys> = {
//             type: options.keys?.type || "__type",
//             id: options.keys?.id || "id",
//             reference: options.keys?.reference || "ref",
//             functionType: options.keys?.functionType || "function",
//             cyclicType: options.keys?.cyclicType || "cyclic",
//         };
//
//         // Сериализация функции
//         const serializeFunction = (func: Function): SerializedFunction => {
//             const funcId = methodsMap.get(func) || `method_${methodsMap.size + 1}`;
//             if (!methodsMap.has(func)) {
//                 methodsMap.set(func, funcId);
//                 meta.methods[funcId] = options.shortenMethods
//                     ? func.toString().replace(/\s+/g, " ").trim() // Убираем лишние пробелы
//                     : func.toString();
//             }
//             return { [keys.type]: keys.functionType, [keys.id]: funcId };
//         };
//
//         // Сериализация циклической ссылки
//         const serializeCyclicReference = (value: any, currentPath: string): SerializedCyclicReference => {
//             const existingPath = registry.get(value);
//             meta.cyclic[currentPath] = existingPath!;
//             return { [keys.type]: keys.cyclicType, [keys.reference]: existingPath! };
//         };
//
//         // Рекурсивная обработка значений
//         const processValue = (value: any, currentPath: string): SerializedValue => {
//             // Применение трансформера, если указан
//             if (options.transformer) {
//                 value = options.transformer(value, currentPath);
//             }
//
//             if (typeof value === "function") return serializeFunction(value);
//
//             if (typeof value === "object" && value !== null) {
//                 if (registry.has(value)) return serializeCyclicReference(value, currentPath);
//
//                 registry.set(value, currentPath);
//                 return Array.isArray(value)
//                     ? value.map((child, index) => processValue(child, `${currentPath}[${index}]`))
//                     : Object.fromEntries(
//                         Object.entries(value).map(([key, child]) => [
//                             key,
//                             processValue(child, `${currentPath}.${key}`),
//                         ])
//                     );
//             }
//
//             // Примитивы возвращаем как есть
//             return value;
//         };
//
//         // Обработка корневого объекта
//         return { data: processValue(obj, path), meta };
//     },
//
//     deserialize<T = any>(serialized: SerializedObject, options: SerializationOptions = {}): T {
//         const { data, meta } = serialized;
//
//         // Установить текстовые ключи (используем значения по умолчанию, если не указаны)
//         const keys: Required<SerializationKeys> = {
//             type: options.keys?.type || "__type",
//             id: options.keys?.id || "id",
//             reference: options.keys?.reference || "ref",
//             functionType: options.keys?.functionType || "function",
//             cyclicType: options.keys?.cyclicType || "cyclic",
//         };
//
//         const refRegistry = new Map<string, any>(); // Ссылки на восстановленные объекты
//
//         // Рекурсивная обработка значений
//         const processValue = (value: SerializedValue, path: string): any => {
//             if (typeof value !== "object" || value === null) {
//                 return value; // Примитивы возвращаем сразу
//             }
//
//             // Если это функция
//             if ((value as SerializedFunction)[keys.type] === keys.functionType) {
//                 return new Function(`return (${meta.methods[(value as SerializedFunction)[keys.id]]})`)(); // Восстанавливаем функцию
//             }
//
//             // Если это циклическая ссылка
//             if ((value as SerializedCyclicReference)[keys.type] === keys.cyclicType) {
//                 return refRegistry.get((value as SerializedCyclicReference)[keys.reference]); // Вернуть ссылку из регистра
//             }
//
//             // Рекурсивная десериализация объекта или массива
//             const deserialized = Array.isArray(value) ? [] : {};
//             refRegistry.set(path, deserialized);
//
//             for (const [key, child] of Object.entries(value as object)) {
//                 deserialized[key] = processValue(child, `${path}.${key}`);
//             }
//
//             return deserialized; // Полностью восстановленный объект
//         };
//
//         return processValue(data, "root");
//     },
// };
// // Пример использованияasync
// async function test() {
//     const a = () => console.log("Hello, World!")
//     const sourceObject: Record<string, any> = {
//         key1: "value1",
//         key2: a,
//         nested: {
//             deepKey: a
//         },
//     };
//
//     // Создаём трансформер для удаления или изменения значений
//     const customTransformer = (v: any, path: string) => {
//         return typeof v == "object" && v != null ? v : typeof v == "function" ? "func" : !v ? "null" : "unknow";
//     };
//
//     // Сериализация с трансформером
//     const serialized = ObjectSerializer.serialize(sourceObject, {
//         shortenMethods: true,
//         transformer: customTransformer, // Указание трансформера
//     });
//
//     console.log("Serialized:", JSON.stringify(serialized, null, 2));
//
//     // Десериализация
//     const deserialized = ObjectSerializer.deserialize(serialized);
//     console.log("Deserialized:", deserialized);
//
//     // Проверка методов
//     JSON.stringify(deserialized)
// }