import type {tServiceDefinition} from './definition'

declare const serviceType: unique symbol

/** JSON data only; the phantom field retains the server definition's inferred types. */
export type ServiceClientDefinition<D extends tServiceDefinition<any, any>> = {
    name: string
    views: Record<string, {allow: 'public' | readonly string[]}>
    commands: Record<string, null>
    resources?: Record<string, {allow: readonly string[], placement: 'authority'}>
    readonly [serviceType]: D
}

/** Generate this on the server/build side; import only the resulting JSON in a browser. */
export function describeService<D extends tServiceDefinition<any, any>>(definition: D) {
    return {
        name: definition.name,
        views: Object.fromEntries(Object.entries(definition.views ?? {}).map(([name, view]) => [name, {
            allow: view.allow == 'public' ? 'public' : [...view.allow],
        }])),
        commands: Object.fromEntries(Object.keys(definition.commands).map(name => [name, null])),
        ...(definition.resources ? {resources: Object.fromEntries(Object.entries(definition.resources).map(([name, resource]) => [name, {
            allow: [...resource.allow], placement: resource.placement,
        }]))} : {}),
    } as ServiceClientDefinition<D>
}
