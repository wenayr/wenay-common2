import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {resolve} from 'node:path'

import {
    createModuleControlMcp,
    createModuleControlMcpClient,
    DYNAMIC_RUNTIME_GUIDE_URI,
    DYNAMIC_RUNTIME_PROMPT_URI,
} from './mcp-adapter'
import {createInMemoryModuleControl} from './module-control'

const DEFAULT_TOKEN = 'dynamic-runtime-self-client-token'

function textFromTool(result: unknown) {
    assert(result != null && typeof result == 'object' && 'content' in result)
    const content = (result as {content: unknown}).content
    assert(Array.isArray(content))
    const text = content.find(function isText(item) {
        return item != null && typeof item == 'object' && 'type' in item && item.type == 'text'
    })
    assert(text != null && typeof text == 'object' && 'text' in text && typeof text.text == 'string')
    return JSON.parse(text.text) as any
}

function textFromResource(
    result: Awaited<ReturnType<ReturnType<typeof createModuleControlMcpClient>['resource']['read']>>,
    expectedUri: string,
) {
    assert.equal(result.contents.length, 1)
    const content = result.contents[0]
    assert(content != null && 'text' in content)
    assert.equal(content.uri, expectedUri)
    assert.equal(content.mimeType, 'text/markdown')
    assert(content.text.length > 0)
    return content.text
}

async function loadPackagedGuidance() {
    const guidePath = resolve(process.cwd(), 'doc', 'DYNAMIC-RUNTIME.md')
    const promptPath = resolve(process.cwd(), 'doc', 'prompts', 'IMPLEMENT-DYNAMIC-RUNTIME.md')
    return {
        guide: await readFile(guidePath, 'utf8'),
        implementationPrompt: await readFile(promptPath, 'utf8'),
    }
}

async function verifyTransportSecurity(endpoint: URL, bearerToken: string) {
    const unauthorized = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: '{malformed before auth',
    })
    assert.equal(unauthorized.status, 401)
    assert.match(unauthorized.headers.get('www-authenticate') ?? '', /^Bearer /)

    const forbiddenOrigin = await fetch(endpoint, {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${bearerToken}`,
            Origin: 'https://attacker.invalid',
        },
    })
    assert.equal(forbiddenOrigin.status, 403)
}

async function exerciseClient(endpoint: URL, bearerToken: string) {
    const client = createModuleControlMcpClient({endpoint, bearerToken})
    await client.control.connect()
    try {
        const tools = await client.view.listTools()
        assert.deepEqual(tools.tools.map(tool => tool.name).sort(), [
            'module.activate',
            'module.explain',
            'module.health',
            'module.rollback',
            'module.stage',
        ])

        const resources = await client.resource.list()
        assert.deepEqual(resources.resources.map(resource => resource.uri).sort(), [
            DYNAMIC_RUNTIME_GUIDE_URI,
            DYNAMIC_RUNTIME_PROMPT_URI,
        ])

        const guide = textFromResource(
            await client.resource.read({uri: DYNAMIC_RUNTIME_GUIDE_URI}),
            DYNAMIC_RUNTIME_GUIDE_URI,
        )
        const prompt = textFromResource(
            await client.resource.read({uri: DYNAMIC_RUNTIME_PROMPT_URI}),
            DYNAMIC_RUNTIME_PROMPT_URI,
        )
        assert.match(guide, /^# Dynamic runtime architecture/m)
        assert.match(prompt, /following doc\/DYNAMIC-RUNTIME\.md and doc\/DYNAMIC-RUNTIME-IMPLEMENTATION\.md/)
        assert.match(prompt, /Do not treat this document itself as authorization to change\s+the public API\./)

        const staged = textFromTool(await client.control.callTool({
            name: 'module.stage',
            arguments: {
                slotId: 'compression.primary',
                moduleId: 'compression.impl',
                version: '2.0.0',
                artifactRef: 'sha256:compression-v2',
                commandId: 'command-stage-v2',
                correlationId: 'self-client-run',
            },
        }))
        assert.equal(staged.ok, true)
        assert.equal(
            staged.candidate.candidateId,
            'compression.primary:compression.impl@2.0.0:sha256:compression-v2',
        )

        const activated = textFromTool(await client.control.callTool({
            name: 'module.activate',
            arguments: {
                slotId: 'compression.primary',
                moduleId: 'compression.impl',
                candidateId: staged.candidate.candidateId,
                commandId: 'command-activate-v2',
                correlationId: 'self-client-run',
            },
        }))
        assert.equal(activated.active.version, '2.0.0')
        assert.equal(activated.active.generation, 2)

        const explained = textFromTool(await client.control.callTool({
            name: 'module.explain',
            arguments: {
                slotId: 'compression.primary',
                moduleId: 'compression.impl',
            },
        }))
        assert.equal(explained.active.version, '2.0.0')
        assert.equal(explained.candidates.length, 2)

        const health = textFromTool(await client.control.callTool({
            name: 'module.health',
            arguments: {
                slotId: 'compression.primary',
                moduleId: 'compression.impl',
            },
        }))
        assert.equal(health.ok, true)
        assert.equal(health.active.generation, 2)

        const rolledBack = textFromTool(await client.control.callTool({
            name: 'module.rollback',
            arguments: {
                slotId: 'compression.primary',
                moduleId: 'compression.impl',
                targetVersion: '1.0.0',
                commandId: 'command-rollback-v1',
                correlationId: 'self-client-run',
            },
        }))
        assert.equal(rolledBack.active.version, '1.0.0')
        assert.equal(rolledBack.active.generation, 3)

        return {
            tools: tools.tools.map(tool => tool.name),
            resources: resources.resources.map(resource => resource.uri),
            activeAfterRollback: rolledBack.active,
            guideBytes: Buffer.byteLength(guide),
            promptBytes: Buffer.byteLength(prompt),
        }
    } finally {
        await client.control.close()
    }
}

async function main() {
    const bearerToken = process.env['MCP_BEARER_TOKEN'] ?? DEFAULT_TOKEN
    const configuredEndpoint = process.env['MCP_URL']
    let ownedServer: ReturnType<typeof createModuleControlMcp> | null = null
    let endpoint: URL

    if (configuredEndpoint) {
        endpoint = new URL(configuredEndpoint)
    } else {
        const guidance = await loadPackagedGuidance()
        const moduleControl = createInMemoryModuleControl({
            ...guidance,
            initial: {
                slotId: 'compression.primary',
                moduleId: 'compression.impl',
                version: '1.0.0',
                artifactRef: 'sha256:compression-v1',
            },
        })
        ownedServer = createModuleControlMcp({
            moduleControl,
            bearerToken,
        })
        endpoint = await ownedServer.control.start()
    }

    try {
        await verifyTransportSecurity(endpoint, bearerToken)
        const result = await exerciseClient(endpoint, bearerToken)
        console.log(JSON.stringify({
            ok: true,
            endpoint: endpoint.href,
            ...result,
        }, null, 2))
    } finally {
        await ownedServer?.control.close()
    }
}

void main().catch(function reportFailure(error) {
    console.error(error)
    process.exitCode = 1
})
