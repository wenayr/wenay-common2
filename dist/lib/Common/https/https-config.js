"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HTTPS_COMMANDS = void 0;
exports.normalizeHttpsConfig = normalizeHttpsConfig;
exports.httpsPublicUrl = httpsPublicUrl;
exports.createCaddyfile = createCaddyfile;
const node_net_1 = require("node:net");
const node_url_1 = require("node:url");
exports.HTTPS_COMMANDS = {
    ensure: 'ensure',
    status: 'status',
    doctor: 'doctor',
    stop: 'stop',
};
function validPort(value, name) {
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
        throw new Error(`${name} must be an integer from 1 to 65535`);
    }
    return value;
}
function normalizeIdentity(value) {
    const identity = value.trim();
    if (!identity)
        throw new Error('identity is required');
    if ((0, node_net_1.isIP)(identity))
        return identity;
    if (identity.includes('/') || identity.includes(':')) {
        throw new Error('identity must be a DNS hostname or IP address without a scheme or port');
    }
    const ascii = (0, node_url_1.domainToASCII)(identity).toLowerCase();
    if (!ascii || ascii.length > 253)
        throw new Error(`invalid DNS hostname: ${identity}`);
    const labels = ascii.split('.');
    if (labels.some(label => !label || label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
        throw new Error(`invalid DNS hostname: ${identity}`);
    }
    return ascii;
}
function normalizeBackend(value) {
    const raw = value.trim();
    if (!raw)
        throw new Error('backend is required');
    const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`;
    let parsed;
    try {
        parsed = new URL(withScheme);
    }
    catch {
        throw new Error(`invalid backend URL: ${value}`);
    }
    if (parsed.protocol != 'http:' && parsed.protocol != 'https:') {
        throw new Error('backend must use http or https');
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash ||
        (parsed.pathname && parsed.pathname != '/')) {
        throw new Error('backend must not contain credentials, a path, query, or fragment');
    }
    if (!parsed.port) {
        parsed.port = parsed.protocol == 'https:' ? '443' : '80';
    }
    return parsed.protocol == 'https:'
        ? `https://${parsed.host}`
        : parsed.host;
}
function normalizeBind(value) {
    const bind = (value || '0.0.0.0').trim();
    if (bind == 'localhost')
        return bind;
    if (!(0, node_net_1.isIP)(bind))
        throw new Error('bind must be localhost or an IP address');
    return bind;
}
function normalizeEmail(value) {
    const email = value?.trim() || undefined;
    if (email && (!email.includes('@') || /[\s"'{}]/.test(email))) {
        throw new Error('email must be a plain ACME account email address');
    }
    return email;
}
function normalizeHttpsConfig(input) {
    const identity = normalizeIdentity(input.identity);
    const publicPort = validPort(input.publicPort ?? 443, 'publicPort');
    const challengePort = validPort(input.challengePort ?? 80, 'challengePort');
    if (publicPort == challengePort) {
        throw new Error('publicPort and challengePort must differ');
    }
    const certificateWaitSeconds = input.certificateWaitSeconds ?? 120;
    if (!Number.isInteger(certificateWaitSeconds) || certificateWaitSeconds < 1 ||
        certificateWaitSeconds > 3600) {
        throw new Error('certificateWaitSeconds must be an integer from 1 to 3600');
    }
    return {
        identity,
        backend: normalizeBackend(input.backend),
        publicPort,
        challengePort,
        bind: normalizeBind(input.bind),
        email: normalizeEmail(input.email),
        certificateWaitSeconds,
        caddyPath: input.caddyPath?.trim() || undefined,
        rawIp: (0, node_net_1.isIP)(identity) != 0,
    };
}
function caddyQuote(value) {
    return `"${value.replaceAll('\\', '/').replaceAll('"', '\\"')}"`;
}
function httpsPublicUrl(config) {
    const identity = (0, node_net_1.isIP)(config.identity) == 6 ? `[${config.identity}]` : config.identity;
    return `https://${identity}:${config.publicPort}/`;
}
function createCaddyfile(config, storageDir) {
    const globalLines = [
        '{',
        '    admin off',
        '    auto_https disable_redirects',
        `    storage file_system ${caddyQuote(storageDir)}`,
    ];
    if (config.email)
        globalLines.push(`    email ${config.email}`);
    if (config.rawIp)
        globalLines.push(`    default_sni ${config.identity}`);
    globalLines.push('}');
    const issuer = config.rawIp
        ? [
            '        issuer acme https://acme-v02.api.letsencrypt.org/directory {',
            '            profile shortlived',
            `            alt_http_port ${config.challengePort}`,
            '            disable_tlsalpn_challenge',
            '        }',
        ]
        : [
            '        issuer acme {',
            `            alt_http_port ${config.challengePort}`,
            '            disable_tlsalpn_challenge',
            '        }',
        ];
    return [
        ...globalLines,
        '',
        httpsPublicUrl(config).slice(0, -1) + ' {',
        `    bind ${config.bind}`,
        '    encode zstd gzip',
        '    tls {',
        ...issuer,
        '    }',
        `    reverse_proxy ${config.backend}`,
        '}',
        '',
    ].join('\n');
}
