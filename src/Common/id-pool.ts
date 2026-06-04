export const createIdPool = () => {
    const s: number[] = [];          // стек свободных id для переиспользования
    const free = new Set<number>();  // какие id СЕЙЧАС свободны (защита от двойного release)
    let n = 0;                       // высшая выданная граница; всё > n никогда не выдавалось
    return {
        next: () => {
            const id = s.length > 0 ? s.pop()! : ++n;
            free.delete(id);
            return id;
        },
        release(id: number) {
            // игнорируем двойное освобождение и id вне диапазона выданных
            if (id < 1 || id > n || free.has(id)) return;
            free.add(id);
            s.push(id);
        }
    }
}
export type idPool = ReturnType<typeof createIdPool>;
