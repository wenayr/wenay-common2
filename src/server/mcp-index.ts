// The MCP entry of the package (`wenay-common2/server/mcp`): MCP tools and resources generated
// from a facade, over the official SDK (`@modelcontextprotocol/sdk`, an optional peer that only
// this entry loads). The metadata helpers are the ones `server/http` exports for OpenAPI;
// describeDynamic (noStrict templates and dispatchers) is MCP's own.
export * from './mcpFacadeServer'
export * from './mcpFacadeHttp'
export {describeDynamic, describeMethod, dynamicMeta, methodMeta} from './facadeMeta'
export type {FacadeDynamicMeta, FacadeMethodArg, FacadeMethodMeta, McpToolAnnotations, tFacadeMetaMap} from './facadeMeta'
