"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.facadeNodeKind = facadeNodeKind;
exports.walkFacade = walkFacade;
exports.facadeMember = facadeMember;
const Listen_1 = require("../Common/events/Listen");
const replay_listen_1 = require("../Common/events/replay-listen");
const rpc_dynamic_1 = require("../Common/rcp/rpc-dynamic");
const rpc_limits_1 = require("../Common/rcp/rpc-limits");
function facadeNodeKind(value) {
    if ((0, rpc_dynamic_1.isNoStrict)(value))
        return 'dynamic';
    if ((0, replay_listen_1.isReplayListen)(value) || (0, Listen_1.isListenCallback)(value))
        return 'listen';
    if ((0, Listen_1.isListenOn)(value))
        return 'on';
    return undefined;
}
function walkFacade(object, options) {
    const { label, take } = options;
    const rootKind = facadeNodeKind(object);
    if (rootKind)
        throw new Error(`${label} object is a ${rootKind} node, not a facade`);
    const entries = [];
    const ancestors = new Set();
    function visit(node, path) {
        if (ancestors.has(node)) {
            throw new Error(`${label} contains a circular branch at ${JSON.stringify(path)}`);
        }
        ancestors.add(node);
        try {
            for (const key of Object.keys(node)) {
                if (!(0, rpc_limits_1.isSafeKey)(key))
                    throw new Error(`${label} contains a forbidden key: ${key}`);
                if (key.length == 0)
                    throw new Error(`${label} contains an empty path segment`);
                const value = node[key];
                const nextPath = [...path, key];
                if (take?.(value, nextPath, node))
                    continue;
                if (facadeNodeKind(value) != undefined)
                    continue;
                if (typeof value == 'function') {
                    entries.push({ path: nextPath, fn: value, context: node });
                    continue;
                }
                if (value != null && typeof value == 'object')
                    visit(value, nextPath);
            }
        }
        finally {
            ancestors.delete(node);
        }
    }
    visit(object, []);
    return entries;
}
function facadeMember(object, path) {
    let node = object;
    for (const key of path) {
        if (node == null || (typeof node != 'object' && typeof node != 'function'))
            return undefined;
        if (!Object.prototype.hasOwnProperty.call(node, key))
            return undefined;
        node = node[key];
    }
    return node;
}
