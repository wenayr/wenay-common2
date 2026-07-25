import {isIP} from 'node:net'
import {domainToASCII} from 'node:url'

export const HTTPS_COMMANDS = {
    ensure: 'ensure',
    status: 'status',
    doctor: 'doctor',
    stop: 'stop',
} as const

export type tHttpsCommand = keyof typeof HTTPS_COMMANDS

export type HttpsConfigInput = {
    identity: string
    backend: string
    publicPort?: number
    challengePort?: number
    bind?: string
    email?: string
    certificateWaitSeconds?: number
    caddyPath?: string
}

function validPort(value: number, name: string) {
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
        throw new Error(`${name} must be an integer from 1 to 65535`)
    }
    return value
}

function normalizeIdentity(value: string) {
    const identity = value.trim()
    if (!identity) throw new Error('identity is required')
    if (isIP(identity)) return identity
    if (identity.includes('/') || identity.includes(':')) {
        throw new Error('identity must be a DNS hostname or IP address without a scheme or port')
    }

    const ascii = domainToASCII(identity).toLowerCase()
    if (!ascii || ascii.length > 253) throw new Error(`invalid DNS hostname: ${identity}`)
    const labels = ascii.split('.')
    if (labels.some(label => !label || label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
        throw new Error(`invalid DNS hostname: ${identity}`)
    }
    return ascii
}

function normalizeBackend(value: string) {
    const raw = value.trim()
    if (!raw) throw new Error('backend is required')
    const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`
    let parsed: URL
    try {
        parsed = new URL(withScheme)
    } catch {
        throw new Error(`invalid backend URL: ${value}`)
    }
    if (parsed.protocol != 'http:' && parsed.protocol != 'https:') {
        throw new Error('backend must use http or https')
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash ||
        (parsed.pathname && parsed.pathname != '/')) {
        throw new Error('backend must not contain credentials, a path, query, or fragment')
    }
    if (!parsed.port) {
        parsed.port = parsed.protocol == 'https:' ? '443' : '80'
    }
    return parsed.protocol == 'https:'
        ? `https://${parsed.host}`
        : parsed.host
}

function normalizeBind(value: string | undefined) {
    const bind = (value || '0.0.0.0').trim()
    if (bind == 'localhost') return bind
    if (!isIP(bind)) throw new Error('bind must be localhost or an IP address')
    return bind
}

function normalizeEmail(value: string | undefined) {
    const email = value?.trim() || undefined
    if (email && (!email.includes('@') || /[\s"'{}]/.test(email))) {
        throw new Error('email must be a plain ACME account email address')
    }
    return email
}

export function normalizeHttpsConfig(input: HttpsConfigInput) {
    const identity = normalizeIdentity(input.identity)
    const publicPort = validPort(input.publicPort ?? 443, 'publicPort')
    const challengePort = validPort(input.challengePort ?? 80, 'challengePort')
    if (publicPort == challengePort) {
        throw new Error('publicPort and challengePort must differ')
    }

    const certificateWaitSeconds = input.certificateWaitSeconds ?? 120
    if (!Number.isInteger(certificateWaitSeconds) || certificateWaitSeconds < 1 ||
        certificateWaitSeconds > 3600) {
        throw new Error('certificateWaitSeconds must be an integer from 1 to 3600')
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
        rawIp: isIP(identity) != 0,
    }
}

export type HttpsConfig = ReturnType<typeof normalizeHttpsConfig>

function caddyQuote(value: string) {
    return `"${value.replaceAll('\\', '/').replaceAll('"', '\\"')}"`
}

export function httpsPublicUrl(config: Pick<HttpsConfig, 'identity' | 'publicPort'>) {
    const identity = isIP(config.identity) == 6 ? `[${config.identity}]` : config.identity
    return `https://${identity}:${config.publicPort}/`
}

export function createCaddyfile(config: HttpsConfig, storageDir: string) {
    const globalLines = [
        '{',
        '    admin off',
        '    auto_https disable_redirects',
        `    storage file_system ${caddyQuote(storageDir)}`,
    ]
    if (config.email) globalLines.push(`    email ${config.email}`)
    if (config.rawIp) globalLines.push(`    default_sni ${config.identity}`)
    globalLines.push('}')

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
        ]

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
    ].join('\n')
}
