"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRpcClientAuto = createRpcClientAuto;
const listen_deep_1 = require("./listen-deep");
function createRpcClientAuto(api, options) {
    const { mode = "smart", status } = options ?? {};
    const closeOn = options?.closeOn;
    const listenOptions = {
        ...(status ? { status } : {}),
        ...(closeOn ? { closeOn } : {}),
    };
    switch (mode) {
        case "first":
            return (0, listen_deep_1.deepListenFirst)(api, listenOptions);
        case "all":
            return (0, listen_deep_1.deepListenAll)(api, listenOptions);
        case "smart":
        default:
            return (0, listen_deep_1.deepListenSmart)(api, listenOptions);
    }
}
