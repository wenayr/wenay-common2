export const createIdPool = () => {
    const s: number[] = [];
    let n = 0;
    return {
        next: () => s.length > 0 ? s.pop()! : ++n,
        release(id: number){s.push(id)}
    }
}
export type idPool = ReturnType<typeof createIdPool>;