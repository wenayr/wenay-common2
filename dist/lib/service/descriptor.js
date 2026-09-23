"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.describeService = describeService;
function describeService(definition) {
    return {
        name: definition.name,
        views: Object.fromEntries(Object.entries(definition.views ?? {}).map(([name, view]) => [name, {
                allow: view.allow == 'public' ? 'public' : [...view.allow],
            }])),
        commands: Object.fromEntries(Object.keys(definition.commands).map(name => [name, null])),
        ...(definition.resources ? { resources: Object.fromEntries(Object.entries(definition.resources).map(([name, resource]) => [name, {
                    allow: [...resource.allow], placement: resource.placement,
                }])) } : {}),
    };
}
