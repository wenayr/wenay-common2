type tCorrelationByBuffer = { max: number; bufferOn?: boolean };

type tCorrBuffer = {
    sum1: number;
    sum2: number;
    pow1: number;
    pow2: number;
    mulSum: number;
    step: number;
    // Save history for sliding window directly in buffer
    history1: number[];
    history2: number[];
};

export function CorrelationRollingByBuffer(data: tCorrelationByBuffer) {
    let setting: tCorrelationByBuffer = { ...data };
    
    // Use Map, but remember that if keys are objects,
    // it's better to clear them manually or use WeakMap to prevent memory leaks
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
        // freeing specific key/pair - against Map leak with object keys (full reset - clear())
        remove(key1: any, key2?: any) {
            if (key2 === undefined) map.delete(key1);
            else map.get(key1)?.delete(key2);
        },
        
        // Stream calculation for one value
        corr2(val1: number, val2: number, key1: any, key2: any) {
            // corr2 always needs window history; previously bufferOn:false gave defBuf() on each call -> corr always 0
            const buffer = getBuffer(key1, key2);
            
            // If buffer is disabled, we just calculate 'directly' for passed values
            // But since corr2 takes one number at a time, without buffer (history) correlation can't be calculated.
            // Therefore for corr2 history buffer is always used.
            
            buffer.history1.push(val1);
            buffer.history2.push(val2);
            
            let dropped1 = 0;
            let dropped2 = 0;
            
            // If window size exceeded, push out old values
            if (buffer.history1.length > setting.max) {
                dropped1 = buffer.history1.shift()!;
                dropped2 = buffer.history2.shift()!;
            } else {
                buffer.step++;
            }

            // Update sums (add new, subtract removed from window)
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
 * Isolated function for calculating Pearson coefficient based on ready sums.
 */
function calculatePearson(buffer: Omit<tCorrBuffer, 'history1' | 'history2'>, count: number): { corr: number } {
    if (count < 2) return { corr: 0 }; // For correlation need at least 2 points

    const { sum1, sum2, pow1, pow2, mulSum } = buffer;
    const { sqrt } = Math;

    // Check for invalid values (NaN or Infinity)
    if (!Number.isFinite(sum1) || !Number.isFinite(sum2) || !Number.isFinite(mulSum)) {
        console.error("Invalid math values in correlation calculation", { sum1, sum2, mulSum });
        return { corr: 0 };
    }

    // Calculate denominator (variances)
    // Use formula: N * Σ(X^2) - (ΣX)^2 (equivalent to yours, but more stable)
    const variance1 = count * pow1 - sum1 ** 2;
    const variance2 = count * pow2 - sum2 ** 2;

    if (variance1 <= 0 || variance2 <= 0) {
        return { corr: 0 }; // Avoid division by zero if data is constant
    }

    const dense = sqrt(variance1 * variance2);
    
    // Calculate numerator (covariance)
    const numerator = count * mulSum - (sum1 * sum2);

    const result = numerator / dense;
    
    // Protection from float errors (when result can become 1.0000000000000002)
    if (result > 1) return { corr: 1 };
    if (result < -1) return { corr: -1 };

    return { corr: result };
}
