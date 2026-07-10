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
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveKeyValue = saveKeyValue;
const fs = __importStar(require("fs"));
const waitRun_1 = require("../Common/async/waitRun");
const Decorator_1 = require("../Common/core/Decorator");
function saveKeyValue({ dirDef = "", key: _key = "" }) {
    async function ensureDir(dir) {
        const fullDir = dirDef ? `${dirDef}/${dir}` : dir;
        await fs.promises.mkdir(fullDir, { recursive: true });
        return `${fullDir}/`;
    }
    async function resolvePath(path, key) {
        const fullPath = await ensureDir(path);
        return `${fullPath}${key}`;
    }
    async function get({ key = _key, path = "" } = {}) {
        const filePath = await resolvePath(path, key);
        return fs.promises.readFile(filePath, "utf-8");
    }
    async function has({ key = _key, path = "" } = {}) {
        const filePath = await resolvePath(path, key);
        return fs.promises.access(filePath)
            .then(() => true)
            .catch(() => false);
    }
    let _tmpSeq = 0;
    async function set({ key = _key, obj, path = "" }) {
        const filePath = await resolvePath(path, key);
        const tmp = `${filePath}.${++_tmpSeq}.tmp`;
        await fs.promises.writeFile(tmp, obj);
        await fs.promises.rename(tmp, filePath);
    }
    async function setElMap({ key = _key, keyEl, valueEl, path = "" }) {
        const exists = await has({ key, path });
        let data = {};
        if (exists) {
            try {
                data = JSON.parse(await get({ key, path }));
            }
            catch {
                data = {};
            }
        }
        data[keyEl] = valueEl;
        await set({ key, obj: JSON.stringify(data), path });
    }
    async function delEl({ key = _key, keyEl, path = "" }) {
        if (!(await has({ key, path })))
            throw new Error(`Файл не найден: ${path}${key}`);
        let data = {};
        try {
            data = JSON.parse(await get({ key, path }));
        }
        catch {
            data = {};
        }
        delete data[keyEl];
        await set({ key, obj: JSON.stringify(data), path });
        return true;
    }
    async function del({ key = _key, path = "" } = {}) {
        const filePath = await resolvePath(path, key);
        await fs.promises.rm(filePath);
    }
    const queue = (0, waitRun_1.createAsyncQueue)(1);
    const queueFunc = (f) => (0, Decorator_1.Transformer)(f, ([args, func]) => queue.enqueue(() => func(...args)));
    return {
        get,
        has,
        set: queueFunc(set),
        setElMap: queueFunc(setElMap),
        delEl: queueFunc(delEl),
        del: queueFunc(del),
    };
}
