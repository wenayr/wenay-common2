"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requiredEnv = requiredEnv;
exports.optionalEnv = optionalEnv;
exports.portEnv = portEnv;
exports.servicePublicUrl = servicePublicUrl;
exports.corsOrigins = corsOrigins;
exports.nodeEnv = nodeEnv;
exports.leaderEnv = leaderEnv;
function requiredEnv(env, name) {
    const value = env[name]?.trim();
    if (!value)
        throw new Error(`missing required env ${name}`);
    return value;
}
function optionalEnv(env, name) {
    return env[name]?.trim() || undefined;
}
function portEnv(env, name) {
    const raw = optionalEnv(env, name);
    if (raw == undefined)
        return undefined;
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new Error(`${name} must be a port number`);
    return port;
}
function servicePublicUrl(value) {
    if (value == undefined)
        return undefined;
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new Error('service public URL must be an absolute HTTP(S) origin');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname != '/' || url.search || url.hash
        || ['0.0.0.0', '[::]'].includes(url.hostname) || url.port == '0') {
        throw new Error('service public URL must be a reachable HTTP(S) origin without credentials, path, query or fragment');
    }
    return url.origin;
}
function toOrigin(raw) {
    try {
        return new URL(raw).origin;
    }
    catch {
        return raw;
    }
}
function corsOrigins(env, known) {
    if (optionalEnv(env, 'SERVICE_ALLOW_ANY_ORIGIN') == '1')
        return true;
    const extra = optionalEnv(env, 'SERVICE_CORS_ORIGINS')?.split(',').map(s => s.trim()).filter(Boolean) ?? [];
    return [...new Set([...known, ...extra].map(toOrigin))];
}
function nodeEnv(env) {
    return {
        nodeId: requiredEnv(env, 'SERVICE_NODE_ID'),
        upstream: requiredEnv(env, 'SERVICE_UPSTREAM'),
        nodeToken: requiredEnv(env, 'SERVICE_NODE_TOKEN'),
        tokenSecret: requiredEnv(env, 'SERVICE_TOKEN_SECRET'),
        port: portEnv(env, 'SERVICE_PORT'),
        host: optionalEnv(env, 'SERVICE_HOST'),
        publicUrl: servicePublicUrl(optionalEnv(env, 'SERVICE_PUBLIC_URL')),
    };
}
function leaderEnv(env) {
    const nodeToken = optionalEnv(env, 'SERVICE_NODE_TOKEN');
    const tokenSecret = optionalEnv(env, 'SERVICE_TOKEN_SECRET');
    return {
        port: portEnv(env, 'SERVICE_PORT'),
        host: optionalEnv(env, 'SERVICE_HOST'),
        publicUrl: servicePublicUrl(optionalEnv(env, 'SERVICE_PUBLIC_URL')),
        dataDir: optionalEnv(env, 'SERVICE_DATA_DIR'),
        secrets: {
            ...(nodeToken ? { nodeToken } : {}),
            ...(tokenSecret ? { tokenSecret } : {}),
        },
    };
}
