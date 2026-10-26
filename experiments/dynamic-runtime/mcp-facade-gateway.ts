import {randomUUID} from 'node:crypto'

import {describeMethod, type McpFacadeSurface, type McpToolContext} from '../../src/server/mcp-index'
import type {McpContributionGateway} from './mcp-contribution-gateway'

// =====================================================================
// Contribution gateway -> facade MCP: one registry for isolated module tools and facade tools
// =====================================================================
// Each catalog tool becomes a described facade function under one mount key. The module's
// annotations are passed through untouched: ModuleWorkerMcpAnnotations is McpToolAnnotations
// with the three hints required. A catalog change swaps the whole fragment with
// control.replace, so an attached session gets exactly one tools/list_changed.

const CONTRIBUTION_INPUT = {
    type: 'object',
    properties: {
        input: {description: 'Tool input, passed to the isolated module unchanged'},
        correlationId: {type: 'string', minLength: 1},
    },
    additionalProperties: false,
}

type tContributionArgs = {input?: unknown, correlationId?: string}

export function gatewayFragment(gateway: McpContributionGateway) {
    const fragment: Record<string, any> = {}
    for (const tool of gateway.view.catalog().tools) {
        const segments = tool.name.split('.')
        let node = fragment
        for (const segment of segments.slice(0, -1)) {
            if (typeof node[segment] == 'function') throw new Error(`Gateway tool ${tool.name} nests under another tool`)
            node = node[segment] ??= {}
        }
        const name = tool.name
        node[segments[segments.length - 1]] = describeMethod(function invokeContribution(args: tContributionArgs, ctx: McpToolContext) {
            return gateway.resource.invoke(name, args.input, {
                correlationId: args.correlationId ?? `mcp-${randomUUID()}`,
                signal: ctx.signal,
            })
        }, {
            description: tool.descriptor.description ?? name,
            ...(tool.descriptor.title != null ? {title: tool.descriptor.title} : {}),
            input: CONTRIBUTION_INPUT,
            ...(tool.descriptor.annotations ? {annotations: tool.descriptor.annotations} : {}),
            context: true,
        })
    }
    return fragment
}

/** Keeps the gateway catalog mounted under `key`; returns the unsubscribe. */
export function connectContributionGateway(mcp: McpFacadeSurface, gateway: McpContributionGateway, key = 'module') {
    mcp.control.replace(key, gatewayFragment(gateway))
    return gateway.events.on(function syncCatalog(event) {
        if (event.type == 'catalog') mcp.control.replace(key, gatewayFragment(gateway))
    })
}
