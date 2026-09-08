"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyCommands = verifyCommands;
exports.forwardCommandsByToken = forwardCommandsByToken;
const command_fragment_1 = require("./command-fragment");
function verifyCommands(deps) {
    const { host, accountOf } = deps;
    function fragment() {
        return (0, command_fragment_1.bindCommandNames)(host.names, function bindVerifiedCommand(name) {
            return async function verifiedCommand(token, requestId, input) {
                return host.execute(await accountOf(token), name, requestId, input);
            };
        });
    }
    return { fragment, names: host.names };
}
function forwardCommandsByToken(deps) {
    function fragment(token) {
        return (0, command_fragment_1.bindCommandNames)(deps.names, function bindRelayedCommand(name) {
            return function forwardedWithToken(requestId, input) {
                return Promise.resolve(deps.upstream[name](token, requestId, input));
            };
        });
    }
    return { fragment, names: deps.names };
}
