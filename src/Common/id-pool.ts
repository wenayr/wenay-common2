export const createIdPool = () => {
    const s: number[] = [];          // stack of free ids for reuse
    const free = new Set<number>();  // which ids are CURRENTLY free (protection against double release)
    let n = 0;                       // highest issued boundary; everything > n was never issued
    return {
        next: () => {
            const id = s.length > 0 ? s.pop()! : ++n;
            free.delete(id);
            return id;
        },
        release(id: number) {
            // ignore double release and ids outside issued range
            if (id < 1 || id > n || free.has(id)) return;
            free.add(id);
            s.push(id);
        }
    }
}
export type idPool = ReturnType<typeof createIdPool>;

/**
 * Node-namespaced id minter for shared keyed state: after a failover two authorities
 * that both continue 'work-N' collide on the same key (the conflict then surfaces in
 * diffKeyedState). Per-node namespaces make ids disjoint by construction:
 * `${kind}-${node}-${n}`. The node segment must not contain '-'.
 * adopt(ids) raises the counter past every OWN id found in an adopted state
 * (foreign namespaces are ignored), so a restarted/promoted node never re-issues
 * a taken id. Plug into hosts via their id/makeId option.
 */
export const createNodeIdMinter = (opts: {node: string, start?: number}) => {
    const {node} = opts
    if (node.includes('-')) throw new Error('createNodeIdMinter: node must not contain "-"')
    let n = opts.start ?? 0
    return {
        node,
        /** Mint the next own id: `${kind}-${node}-${n}`. */
        next: (kind = 'id') => `${kind}-${node}-${++n}`,
        /** Scan adopted ids, raise the counter past own ones; returns how many own ids were seen. */
        adopt(ids: Iterable<string>) {
            let seen = 0
            for (const id of ids) {
                const m = /^(.+)-([^-]+)-(\d+)$/.exec(id)
                if (!m || m[2] != node) continue
                seen++
                const num = Number(m[3])
                if (num > n) n = num
            }
            return seen
        },
        /** Current counter value (highest own number minted or adopted). */
        current: () => n,
    }
}
export type NodeIdMinter = ReturnType<typeof createNodeIdMinter>;
