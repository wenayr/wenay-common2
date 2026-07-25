import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {createCaddyfile, httpsPublicUrl, normalizeHttpsConfig} from './https-config'
import {createNodeHttpsResource} from './https-node-resource'

function testHostnameConfig() {
    const config = normalizeHttpsConfig({
        identity: 'Example.COM',
        backend: '127.0.0.1:3000',
        email: 'admin@example.com',
    })
    assert.equal(config.identity, 'example.com')
    assert.equal(config.backend, '127.0.0.1:3000')
    assert.equal(config.rawIp, false)
    assert.equal(httpsPublicUrl(config), 'https://example.com:443/')

    const caddyfile = createCaddyfile(config, 'C:\\state\\caddy')
    assert.match(caddyfile, /storage file_system "C:\/state\/caddy"/)
    assert.match(caddyfile, /https:\/\/example\.com:443 \{/)
    assert.match(caddyfile, /alt_http_port 80/)
    assert.doesNotMatch(caddyfile, /profile shortlived/)
    assert.match(caddyfile, /reverse_proxy 127\.0\.0\.1:3000/)
}

function testRawIpConfig() {
    const config = normalizeHttpsConfig({
        identity: '203.0.113.10',
        backend: 'https://127.0.0.1:3443',
        publicPort: 3100,
        challengePort: 3102,
        bind: '192.168.1.20',
    })
    assert.equal(config.backend, 'https://127.0.0.1:3443')
    assert.equal(config.rawIp, true)

    const caddyfile = createCaddyfile(config, '/var/lib/wenay-caddy')
    assert.match(caddyfile, /default_sni 203\.0\.113\.10/)
    assert.match(caddyfile, /profile shortlived/)
    assert.match(caddyfile, /bind 192\.168\.1\.20/)
}

function testUnsafeValues() {
    assert.throws(function invalidIdentity() {
        normalizeHttpsConfig({
            identity: 'example.com {\nrespond 200',
            backend: '127.0.0.1:3000',
        })
    }, /invalid DNS hostname/)
    assert.throws(function backendPath() {
        normalizeHttpsConfig({
            identity: 'example.com',
            backend: 'http://127.0.0.1:3000/admin',
        })
    }, /must not contain/)
    assert.throws(function duplicatePorts() {
        normalizeHttpsConfig({
            identity: 'example.com',
            backend: '127.0.0.1:3000',
            publicPort: 443,
            challengePort: 443,
        })
    }, /must differ/)
}

async function testProjectOperationLock() {
    const root = await mkdtemp(path.join(tmpdir(), 'wenay-https-lock-'))
    const resource = createNodeHttpsResource()
    let active = 0
    let maxActive = 0
    async function operation() {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise<void>(resolve => setTimeout(resolve, 30))
        active--
    }
    try {
        await Promise.all([
            resource.project.withLock(root, undefined, operation),
            resource.project.withLock(root, undefined, operation),
        ])
        assert.equal(maxActive, 1)
    } finally {
        await rm(root, {recursive: true, force: true})
    }
}

async function main() {
    testHostnameConfig()
    testRawIpConfig()
    testUnsafeValues()
    await testProjectOperationLock()
    console.log('HTTPS config and operation-lock tests passed')
}

main().catch(function testFailed(error) {
    console.error(error)
    process.exitCode = 1
})
