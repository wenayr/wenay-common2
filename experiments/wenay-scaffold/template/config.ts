// =====================================================================
// Env parsing shared by the process entrypoints
// =====================================================================
// TEMPLATE-OWNED. Env is a HOST concern (doc/DYNAMIC-RUNTIME.md): the domain
// module never reads process.env; the entrypoints parse it here and pass
// plain values down through deps.

export type tEnv = Record<string, string | undefined>

export function requiredEnv(env: tEnv, name: string) {
    const value = env[name]?.trim()
    if (!value) throw new Error(`missing required env ${name}`)
    return value
}

export function optionalEnv(env: tEnv, name: string) {
    return env[name]?.trim() || undefined
}

export function portEnv(env: tEnv, name: string) {
    const raw = optionalEnv(env, name)
    if (raw == undefined) return undefined
    const port = Number(raw)
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`${name} must be a port number`)
    return port
}

// the cors option matches literal Origin headers, so entries must be bare
// origins — a URL with a path (e.g. an upstream with a route) would never match
function toOrigin(raw: string) {
    try { return new URL(raw).origin } catch { return raw }
}

/**
 * Browser CORS origins for the Socket.IO surfaces. CORS only constrains what a
 * browser page may read: Node clients (the node link, the self-checks) send no
 * Origin header and pass regardless. Default: only the stand's own known
 * origins. SERVICE_CORS_ORIGINS extends the list (comma-separated);
 * SERVICE_ALLOW_ANY_ORIGIN=1 is the development escape hatch that restores the
 * reflect-any-origin behavior — off unless asked for explicitly.
 */
export function corsOrigins(env: tEnv, known: string[]) {
    if (optionalEnv(env, 'SERVICE_ALLOW_ANY_ORIGIN') == '1') return true
    const extra = optionalEnv(env, 'SERVICE_CORS_ORIGINS')?.split(',').map(s => s.trim()).filter(Boolean) ?? []
    return [...new Set([...known, ...extra].map(toOrigin))]
}

/** A node process: identity, where the leader is, and the two corridor secrets. */
export function nodeEnv(env: tEnv) {
    return {
        nodeId: requiredEnv(env, 'SERVICE_NODE_ID'),
        upstream: requiredEnv(env, 'SERVICE_UPSTREAM'),
        /** Authenticates the node→leader LINK (transport trust). */
        nodeToken: requiredEnv(env, 'SERVICE_NODE_TOKEN'),
        /** Shared secret of the client-token codec: the node verifies locally. */
        tokenSecret: requiredEnv(env, 'SERVICE_TOKEN_SECRET'),
        /** Absent = ephemeral port (the node registers whatever it bound). */
        port: portEnv(env, 'SERVICE_PORT'),
    }
}

/** The leader process: bind port plus optionally pinned corridor secrets. */
export function leaderEnv(env: tEnv) {
    const nodeToken = optionalEnv(env, 'SERVICE_NODE_TOKEN')
    const tokenSecret = optionalEnv(env, 'SERVICE_TOKEN_SECRET')
    return {
        port: portEnv(env, 'SERVICE_PORT'),
        // absent secrets stay absent: the leader factory mints per-run ones and
        // the entrypoint passes leader.secrets to the node processes it spawns
        secrets: {
            ...(nodeToken ? {nodeToken} : {}),
            ...(tokenSecret ? {tokenSecret} : {}),
        },
    }
}
