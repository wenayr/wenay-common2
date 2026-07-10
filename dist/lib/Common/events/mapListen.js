"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mapListen = mapListen;
const Listen_1 = require("./Listen");
function mapListen(sourceListen, transform, options) {
    let unsubscribeFromSource = null;
    const [emit, targetListen] = (0, Listen_1.listen)({
        event: (type, count) => {
            if (type == "add" && count == 1) {
                const sourceCallback = (...args) => {
                    const result = transform(...args);
                    if (result !== null)
                        emit(...result);
                };
                unsubscribeFromSource = sourceListen.on(sourceCallback);
            }
            if (type == "remove" && count == 0 && unsubscribeFromSource) {
                unsubscribeFromSource();
                unsubscribeFromSource = null;
            }
        },
        closeOn: options?.closeOn,
    });
    return [emit, targetListen];
}
