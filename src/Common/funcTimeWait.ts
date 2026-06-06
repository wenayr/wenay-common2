export type tApiKey = string;
type tType = "UID" | "IP" | tApiKey;
type tWeight = number;
type tTime = number;
type tFunc = {
    timeStamp?: number;
    type: tType;
    weight: number;
};

export function funcTimeW() {
    type tt1 = [tTime, tWeight];
    type ttt = { [key: tType]: tt1[] };
    const dStatic: ttt = {};
    const data: any[] = [];

    return {
        dStatic,
        data,

        // Записывает время в массив
        add(item: tFunc) {
            if (!dStatic[item.type]) {
                dStatic[item.type] = [];
            }
            dStatic[item.type].push([item.timeStamp ?? Date.now(), item.weight]);
        },

        cleanByTime(type: tType, ms = 60 * 1000) {
            const arr = dStatic[type];
            if (!arr || arr.length === 0) return;

            const timeStamp = Date.now();
            // то чистить нечего:
            if (arr[0][0] > timeStamp - ms) return;

            // Или, если хотим "вручную" почистить:
            let cutIndex = 0;
            while (cutIndex < arr.length && arr[cutIndex][0] < timeStamp - ms) {
                cutIndex++;
            }
            if (cutIndex > 0) {
                arr.splice(0, cutIndex);
            }
        },

        // Возвращает сумму веса за период времени (ms)
        weight(type: tType, ms = 60 * 1000) {
            const arr = dStatic[type];
            if (!arr || arr.length === 0) return 0;

            const timeStamp = Date.now();
            let sum = 0;
            let i = arr.length - 1;

            // Считаем вес "с конца", пока не встретим более старое время
            for (; i >= 0; i--) {
                const [_time, _weight] = arr[i];
                if (_time < timeStamp - ms) break;
                sum += _weight;
            }

            // Очищаем "хвост", который уже гарантированно старее (timeStamp - ms)
            // чтобы массив не рос бесконтрольно
            if (i >= 0) {
                arr.splice(0, i + 1);
            }
            return sum;
        },

        // Возвращает timestamp, когда сумма весов превысила weight
        byWeight(type: tType, weight = 50000) {
            const arr = dStatic[type];
            if (!arr || arr.length === 0) return 0;

            let sum = 0;
            let i = arr.length - 1;
            let result = 0;

            for (; i >= 0; i--) {
                sum += arr[i][1];
                if (sum > weight) {
                    // arr[i+1] — корректно (учитывает добавляемый новый запрос); НО если переполнил
                    // самый свежий элемент (i=конец, arr[i+1] нет) — ждать его ts, а НЕ 0 (иначе LoadBase не подождёт → бан)
                    result = arr[i + 1]?.[0] ?? arr[i][0];
                    break;
                }
            }
            // Чтобы массив не разрастался слишком сильно, можно «подчищать»
            if (i > 800) {
                arr.splice(0, i - 800);
            }
            return result;
        },

        // То же самое, только с «промежуточным» timeNow
        byWeightTimeNow(type: tType, timeNow = Date.now(), weight = 50000) {
            const arr = dStatic[type];
            if (!arr || arr.length === 0) return 0;

            let sum = 0;
            let i = arr.length - 1;

            // Сначала «отматываем» массив до timeNow
            for (; i >= 0; i--) {
                if (arr[i][0] <= timeNow) break;
            }
            if (i < 0) return 0;

            let result = 0;
            for (; i >= 0; i--) {
                sum += arr[i][1];
                if (sum > weight) {
                    result = arr[i + 1]?.[0] ?? arr[i][0];   // фолбэк в ts текущего элемента, не 0 (см. byWeight)
                    break;
                }
            }
            if (i > 800) {
                arr.splice(0, i - 800);
            }
            return result;
        },
    };
}


// Массив для хранения времени ожидания у асинхронных функций
export const FuncTimeWait = funcTimeW()