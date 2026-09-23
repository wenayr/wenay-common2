import {createHash, randomUUID} from 'node:crypto'
import {mkdir, writeFile, readFile, link, unlink, stat} from 'node:fs/promises'
import path from 'node:path'
import express, {type Request, type Response, type NextFunction} from 'express'
import type {ArtifactStoragePort} from '../Common/artifact/artifact-host'

export type BlobAccess<C> = {
    context: C
    operation: 'upload' | 'read' | 'remove'
    phase: 'begin' | 'commit'
    id?: string
}
export type LocalBlobStorageDeps<C> = {
    /** Dedicated trusted directory; other writers must not mutate stored objects or install symlinks. */
    directory: string
    maxBytes: number
    authorize: (access: BlobAccess<C>) => void | Promise<void>
    validate?: (bytes: Buffer) => void | Promise<void>
    /** Default SHA-256. A custom strategy must produce safe, immutable, collision-resistant ids. */
    identify?: (bytes: Buffer) => string
}

/** Immutable bytes outside replay; metadata and retention remain with Resource/Artifact or the application. */
export function createLocalBlobStorage<C>(deps: LocalBlobStorageDeps<C>) {
    if (!Number.isSafeInteger(deps.maxBytes) || deps.maxBytes < 1) throw new Error('invalid blob byte limit')
    const directory = path.resolve(deps.directory)
    function filename(id: string) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id) || id.includes('..')) throw new Error('invalid blob id')
        return path.join(directory, id)
    }
    async function authorize(access: BlobAccess<C>) { await deps.authorize(access) }
    async function upload(context: C, input: Uint8Array) {
        await authorize({context, operation: 'upload', phase: 'begin'})
        if (!(input instanceof Uint8Array) || input.byteLength == 0 || input.byteLength > deps.maxBytes) throw new Error('invalid blob size')
        const bytes = Buffer.from(input)
        await deps.validate?.(bytes)
        const id = deps.identify?.(bytes) ?? createHash('sha256').update(bytes).digest('hex')
        const target = filename(id)
        await mkdir(directory, {recursive: true})
        const temporary = path.join(directory, '.' + randomUUID() + '.upload')
        let created = false
        try {
            await writeFile(temporary, bytes, {flag: 'wx'})
            await authorize({context, operation: 'upload', phase: 'commit', id})
            try {
                // Atomic no-replace publication: concurrent identical uploads share one object.
                await link(temporary, target)
                created = true
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code != 'EEXIST') throw error
                if (!(await readFile(target)).equals(bytes)) throw new Error('blob id collision')
            }
            await unlink(temporary)
            return {id, size: bytes.byteLength}
        } catch (error) {
            if (created) await unlink(target).catch(function rollbackFailed() {})
            throw error
        } finally {
            await unlink(temporary).catch(function alreadyRemoved(error: NodeJS.ErrnoException) {
                if (error.code != 'ENOENT') throw error
            })
        }
    }
    async function read(context: C, id: string) {
        const file = filename(id)
        await authorize({context, operation: 'read', phase: 'begin', id})
        return readFile(file)
    }
    async function remove(context: C, id: string) {
        const file = filename(id)
        await authorize({context, operation: 'remove', phase: 'commit', id})
        await unlink(file).catch(function absent(error: NodeJS.ErrnoException) { if (error.code != 'ENOENT') throw error })
    }
    async function info(context: C, id: string) {
        const file = filename(id)
        await authorize({context, operation: 'read', phase: 'begin', id})
        const value = await stat(file)
        return {id, size: value.size}
    }
    return {control: {upload, remove}, resource: {read, authorize}, view: {info, maxBytes: deps.maxBytes}}
}
export type LocalBlobStorage<C> = ReturnType<typeof createLocalBlobStorage<C>>

/** Mount the returned router at a product-selected path before JSON/body parsers. */
export function createBlobHttpRouter<C>(deps: {
    storage: LocalBlobStorage<C>
    context: (request: Request) => C | Promise<C>
    contentType?: (id: string) => string
    /** Defaults to private, no-store. Public immutable caching is an explicit application choice. */
    cacheControl?: string
}) {
    const router = express.Router()
    const contexts = new WeakMap<Request, C>()
    router.post('/', async function gate(req, res, next) {
        try {
            const context = await deps.context(req)
            await deps.storage.resource.authorize({context, operation: 'upload', phase: 'begin'})
            contexts.set(req, context)
            next()
        } catch { res.sendStatus(403) }
    }, express.raw({type: () => true, limit: deps.storage.view.maxBytes}), async function upload(req, res) {
        try {
            const value = await deps.storage.control.upload(contexts.get(req)!, req.body)
            res.json({ok: true, value})
        } catch { res.status(400).json({ok: false, error: {message: 'blob upload refused'}}) }
    })
    router.get('/:id', async function read(req, res) {
        try {
            const id = String(req.params['id'])
            const bytes = await deps.storage.resource.read(await deps.context(req), id)
            res.setHeader('X-Content-Type-Options', 'nosniff')
            res.setHeader('Cache-Control', deps.cacheControl ?? 'private, no-store')
            res.type(deps.contentType?.(id) ?? 'application/octet-stream').send(bytes)
        } catch { res.sendStatus(404) }
    })
    router.use(function failed(error: unknown, _req: Request, res: Response, _next: NextFunction) {
        const large = (error as {type?: string})?.type == 'entity.too.large'
        res.status(large ? 413 : 400).json({ok: false, error: {message: large ? 'blob too large' : 'blob body refused'}})
    })
    return router
}

/** Artifact owns metadata/retention. The application supplies a protected or signed HTTP URL. */
export function createBlobArtifactStorage<C>(deps: {
    storage: LocalBlobStorage<C>
    context: (account: string) => C
    open: (input: {id: string, account: string}) => ReturnType<ArtifactStoragePort['open']>
    /** Omit to retain bytes on metadata revocation; shared hash objects need explicit reference policy. */
    remove?: ArtifactStoragePort['remove']
}) {
    return {
        async open({storageKey, account}) {
            if (typeof storageKey != 'string') throw new Error('blob storage key must be an id')
            await deps.storage.view.info(deps.context(account), storageKey)
            return deps.open({id: storageKey, account})
        },
        ...(deps.remove ? {remove: deps.remove} : {}),
    } satisfies ArtifactStoragePort
}
