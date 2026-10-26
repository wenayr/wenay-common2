// The HTTP entry of the package (`wenay-common2/server/http`): facade routes + the OpenAPI document of the same object.
export * from './httpFacadeServer'
export * from './httpFacadeOpenApi'
export {describeMethod, methodMeta} from './facadeMeta'
export type {FacadeMethodArg, FacadeMethodMeta, McpToolAnnotations, tFacadeMetaMap} from './facadeMeta'
