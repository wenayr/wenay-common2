"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.methodMeta = exports.dynamicMeta = exports.describeMethod = exports.describeDynamic = void 0;
__exportStar(require("./mcpFacadeServer"), exports);
__exportStar(require("./mcpFacadeHttp"), exports);
var facadeMeta_1 = require("./facadeMeta");
Object.defineProperty(exports, "describeDynamic", { enumerable: true, get: function () { return facadeMeta_1.describeDynamic; } });
Object.defineProperty(exports, "describeMethod", { enumerable: true, get: function () { return facadeMeta_1.describeMethod; } });
Object.defineProperty(exports, "dynamicMeta", { enumerable: true, get: function () { return facadeMeta_1.dynamicMeta; } });
Object.defineProperty(exports, "methodMeta", { enumerable: true, get: function () { return facadeMeta_1.methodMeta; } });
