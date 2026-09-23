"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLocalBlobStorage = createLocalBlobStorage;
exports.createBlobHttpRouter = createBlobHttpRouter;
exports.createBlobArtifactStorage = createBlobArtifactStorage;
const node_crypto_1 = require("node:crypto");
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
const express_1 = __importDefault(require("express"));
function createLocalBlobStorage(deps) {
    if (!Number.isSafeInteger(deps.maxBytes) || deps.maxBytes < 1)
        throw new Error('invalid blob byte limit');
    const directory = node_path_1.default.resolve(deps.directory);
    function filename(id) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id) || id.includes('..'))
            throw new Error('invalid blob id');
        return node_path_1.default.join(directory, id);
    }
    async function authorize(access) { await deps.authorize(access); }
    async function upload(context, input) {
        await authorize({ context, operation: 'upload', phase: 'begin' });
        if (!(input instanceof Uint8Array) || input.byteLength == 0 || input.byteLength > deps.maxBytes)
            throw new Error('invalid blob size');
        const bytes = Buffer.from(input);
        await deps.validate?.(bytes);
        const id = deps.identify?.(bytes) ?? (0, node_crypto_1.createHash)('sha256').update(bytes).digest('hex');
        const target = filename(id);
        await (0, promises_1.mkdir)(directory, { recursive: true });
        const temporary = node_path_1.default.join(directory, '.' + (0, node_crypto_1.randomUUID)() + '.upload');
        let created = false;
        try {
            await (0, promises_1.writeFile)(temporary, bytes, { flag: 'wx' });
            await authorize({ context, operation: 'upload', phase: 'commit', id });
            try {
                await (0, promises_1.link)(temporary, target);
                created = true;
            }
            catch (error) {
                if (error.code != 'EEXIST')
                    throw error;
                if (!(await (0, promises_1.readFile)(target)).equals(bytes))
                    throw new Error('blob id collision');
            }
            await (0, promises_1.unlink)(temporary);
            return { id, size: bytes.byteLength };
        }
        catch (error) {
            if (created)
                await (0, promises_1.unlink)(target).catch(function rollbackFailed() { });
            throw error;
        }
        finally {
            await (0, promises_1.unlink)(temporary).catch(function alreadyRemoved(error) {
                if (error.code != 'ENOENT')
                    throw error;
            });
        }
    }
    async function read(context, id) {
        const file = filename(id);
        await authorize({ context, operation: 'read', phase: 'begin', id });
        return (0, promises_1.readFile)(file);
    }
    async function remove(context, id) {
        const file = filename(id);
        await authorize({ context, operation: 'remove', phase: 'commit', id });
        await (0, promises_1.unlink)(file).catch(function absent(error) { if (error.code != 'ENOENT')
            throw error; });
    }
    async function info(context, id) {
        const file = filename(id);
        await authorize({ context, operation: 'read', phase: 'begin', id });
        const value = await (0, promises_1.stat)(file);
        return { id, size: value.size };
    }
    return { control: { upload, remove }, resource: { read, authorize }, view: { info, maxBytes: deps.maxBytes } };
}
function createBlobHttpRouter(deps) {
    const router = express_1.default.Router();
    const contexts = new WeakMap();
    router.post('/', async function gate(req, res, next) {
        try {
            const context = await deps.context(req);
            await deps.storage.resource.authorize({ context, operation: 'upload', phase: 'begin' });
            contexts.set(req, context);
            next();
        }
        catch {
            res.sendStatus(403);
        }
    }, express_1.default.raw({ type: () => true, limit: deps.storage.view.maxBytes }), async function upload(req, res) {
        try {
            const value = await deps.storage.control.upload(contexts.get(req), req.body);
            res.json({ ok: true, value });
        }
        catch {
            res.status(400).json({ ok: false, error: { message: 'blob upload refused' } });
        }
    });
    router.get('/:id', async function read(req, res) {
        try {
            const id = String(req.params['id']);
            const bytes = await deps.storage.resource.read(await deps.context(req), id);
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Cache-Control', deps.cacheControl ?? 'private, no-store');
            res.type(deps.contentType?.(id) ?? 'application/octet-stream').send(bytes);
        }
        catch {
            res.sendStatus(404);
        }
    });
    router.use(function failed(error, _req, res, _next) {
        const large = error?.type == 'entity.too.large';
        res.status(large ? 413 : 400).json({ ok: false, error: { message: large ? 'blob too large' : 'blob body refused' } });
    });
    return router;
}
function createBlobArtifactStorage(deps) {
    return {
        async open({ storageKey, account }) {
            if (typeof storageKey != 'string')
                throw new Error('blob storage key must be an id');
            await deps.storage.view.info(deps.context(account), storageKey);
            return deps.open({ id: storageKey, account });
        },
        ...(deps.remove ? { remove: deps.remove } : {}),
    };
}
