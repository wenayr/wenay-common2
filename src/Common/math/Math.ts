type tCorrelationByBuffer = { max: number; bufferOn?: boolean };

type tCorrBuffer = {
    sum1: number;
    sum2: number;
    pow1: number;
    pow2: number;
    mulSum: number;
    step: number;
    // Сохраняем историю для скользящего окна прямо в буфере
    history1: number[];
    history2: number[];
};

export function CorrelationRollingByBuffer(data: tCorrelationByBuffer) {
    let setting: tCorrelationByBuffer = { ...data };
    
    // Используем Map, но помним, что если ключи - объекты, 
    // лучше очищать их вручную или использовать WeakMap для предотвращения утечек памяти
    const map = new Map<any, Map<any, tCorrBuffer>>();

    const defBuf = (): tCorrBuffer => ({
        sum1: 0, sum2: 0,
        pow1: 0, pow2: 0,
        mulSum: 0, step: 0,
        history1: [], history2: []
    });

    const getBuffer = (key1: any, key2: any) => {
        let a1 = map.get(key1);
        if (!a1) map.set(key1, a1 = new Map());
        let a2 = a1.get(key2);
        if (!a2) a1.set(key2, a2 = defBuf());
        return a2;
    };

    return {
        init(data: tCorrelationByBuffer) { setting = { ...data }; },
        clear(data?: tCorrelationByBuffer) { 
            map.clear(); 
            if (data) this.init(data); 
        },
        
        // Потоковый расчет по одному значению
        corr2(val1: number, val2: number, key1: any, key2: any) {
            const buffer = setting.bufferOn ? getBuffer(key1, key2) : defBuf();
            
            // Если буфер отключен, мы просто считаем "в лоб" для переданных значений
            // Но так как corr2 принимает по одному числу, без буфера (истории) корреляцию не посчитать.
            // Поэтому для corr2 буфер истории используется всегда.
            
            buffer.history1.push(val1);
            buffer.history2.push(val2);
            
            let dropped1 = 0;
            let dropped2 = 0;
            
            // Если превысили размер окна, выталкиваем старые значения
            if (buffer.history1.length > setting.max) {
                dropped1 = buffer.history1.shift()!;
                dropped2 = buffer.history2.shift()!;
            } else {
                buffer.step++;
            }

            // Обновляем суммы (прибавляем новое, вычитаем выпавшее из окна)
            buffer.sum1 = buffer.sum1 + val1 - dropped1;
            buffer.sum2 = buffer.sum2 + val2 - dropped2;
            buffer.pow1 = buffer.pow1 + val1 ** 2 - dropped1 ** 2;
            buffer.pow2 = buffer.pow2 + val2 ** 2 - dropped2 ** 2;
            buffer.mulSum = buffer.mulSum + (val1 * val2) - (dropped1 * dropped2);

            return calculatePearson(buffer, buffer.history1.length);
        }
    };
}

/**
 * Изолированная функция расчета коэффициента Пирсона на основе готовых сумм.
 */
function calculatePearson(buffer: Omit<tCorrBuffer, 'history1' | 'history2'>, count: number): { corr: number } {
    if (count < 2) return { corr: 0 }; // Для корреляции нужно минимум 2 точки

    const { sum1, sum2, pow1, pow2, mulSum } = buffer;
    const { sqrt } = Math;

    // Проверка на некорректные значения (NaN или Infinity)
    if (!Number.isFinite(sum1) || !Number.isFinite(sum2) || !Number.isFinite(mulSum)) {
        console.error("Invalid math values in correlation calculation", { sum1, sum2, mulSum });
        return { corr: 0 };
    }

    // Рассчитываем знаменатель (дисперсии)
    // Используем формулу: N * Σ(X^2) - (ΣX)^2 (эквивалентно вашему варианту, но более стабильно)
    const variance1 = count * pow1 - sum1 ** 2;
    const variance2 = count * pow2 - sum2 ** 2;

    if (variance1 <= 0 || variance2 <= 0) {
        return { corr: 0 }; // Избегаем деления на ноль, если данные константны
    }

    const dense = sqrt(variance1 * variance2);
    
    // Рассчитываем числитель (ковариация)
    const numerator = count * mulSum - (sum1 * sum2);

    const result = numerator / dense;
    
    // Защита от погрешностей float (когда результат может стать 1.0000000000000002)
    if (result > 1) return { corr: 1 };
    if (result < -1) return { corr: -1 };

    return { corr: result };
}
