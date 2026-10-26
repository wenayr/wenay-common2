// The MCP entry of the package (`wenay-common2/server/mcp`): MCP tools and resources generated
// from a facade, over the official SDK (`@modelcontextprotocol/sdk`, an optional peer that only
// this entry loads). The metadata helpers are the ones `server/http` exports for OpenAPI.
export * from './mcpFacadeServer'
export * from './mcpFacadeHttp'
export {describeMethod, methodMeta} from './facadeMeta'
export type {FacadeMethodArg, FacadeMethodMeta, McpToolAnnotations, tFacadeMetaMap} from './facadeMeta'
