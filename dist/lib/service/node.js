"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createServiceNode = createServiceNode;
const store_node_1 = require("../Common/Observe/store-node");
const access_1 = require("./access");
function createServiceNode(deps) {
    const { definition } = deps;
    let access = null;
    function accessOf(store) {
        return access ??= (0, access_1.createServiceAccess)({ definition, store });
    }
    const node = (0, store_node_1.createStoreNode)({
        line: {
            nodeId: deps.nodeId,
            storeId: definition.storeId,
            originId: definition.originId,
            lineId: definition.name + '-' + deps.nodeId + '-line',
        },
        roster: {
            url: deps.selfUrl,
            ...(deps.heartbeatMs != undefined ? { heartbeatMs: deps.heartbeatMs } : {}),
            ...(deps.graceMs != undefined ? { graceMs: deps.graceMs } : {}),
        },
        auth: { verify: deps.verifyToken },
        commands: Object.keys(definition.commands),
        upstream: deps.upstream,
        serve: {
            onConnection: deps.serve.onConnection,
            wrap: (fragment) => ({ [definition.name]: fragment }),
            audience: {
                reader(defaults) {
                    const views = accessOf(defaults.store).publicViews();
                    return views ? { views } : { replica: defaults.replica, node: defaults.node };
                },
                principal(who, defaults, session) {
                    return accessOf(defaults.store).principal(who, defaults, session);
                },
            },
        },
        onLeave: deps.onLeave,
        ...(deps.log ? { log: deps.log } : {}),
    });
    return {
        ...node,
        close() {
            access?.close();
            node.close();
        },
    };
}
