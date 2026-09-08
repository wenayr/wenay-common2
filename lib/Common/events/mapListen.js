"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mapListen = mapListen;
const Listen_1 = require("./Listen");
function mapListen(sourceListen, transform, options) {
    let unsubscribeFromSource = null;
    let sourceGeneration = 0;
    function disconnectSource() {
        sourceGeneration++;
        const off = unsubscribeFromSource;
        unsubscribeFromSource = null;
        off?.();
    }
    const [emit, targetListen] = (0, Listen_1.listen)({
        event: function mappedSubscriptionChanged(type, count, api) {
            if (type == "add" && count == 1) {
                const generation = ++sourceGeneration;
                api.onClose(disconnectSource);
                const sourceCallback = (...args) => {
                    if (generation != sourceGeneration)
                        return;
                    const result = transform(...args);
                    if (result !== null)
                        emit(...result);
                };
                const off = sourceListen.on(sourceCallback);
                if (generation != sourceGeneration || api.count() == 0)
                    off();
                else
                    unsubscribeFromSource = off;
            }
            if (type == "remove" && count == 0 && unsubscribeFromSource) {
                disconnectSource();
            }
        },
        closeOn: options?.closeOn,
    });
    return [emit, targetListen];
}
