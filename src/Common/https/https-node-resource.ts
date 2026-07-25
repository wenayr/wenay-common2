import {createHash} from 'node:crypto'
import {promises as dns} from 'node:dns'
import {
    access,
    chmod,
    copyFile,
    mkdir,
    open,
    readFile,
    rename,
    rm,
    stat,
    unlink,
    writeFile,
} from 'node:fs/promises'
import {homedir} from 'node:os'
import path from 'node:path'
import {spawn} from 'node:child_process'
import {connect as connectNet, isIP} from 'node:net'
import {checkServerIdentity, connect as connectTls} from 'node:tls'
import axios from 'axios'
import {sleepAsync} from '../core/common'
import {HttpsConfig} from './https-config'

// === Resource contracts ===

const CADDY_VERSION = '2.11.4'

type NodeHttpsResourceDeps = {
    env?: NodeJS.ProcessEnv
    platform?: NodeJS.Platform
    arch?: string
    homeDir?: string
    onLog?: (message: string) => void
}

type HttpsRuntimeState = {
    version: 1
    pid: number
    projectRoot: string
    configPath: string
    caddyfilePath: string
    caddyPath: string
    identity: string
    publicPort: number
    challengePort: number
    bind: string
    backend: string
    configHash: string
    startedAt: string
}

// === Platform utilities ===

function fileExists(filePath: string) {
    return access(filePath).then(() => true, () => false)
}

function executableName(platform: NodeJS.Platform) {
    return platform == 'win32' ? 'caddy.exe' : 'caddy'
}

function releasePlatform(platform: NodeJS.Platform) {
    if (platform == 'win32') return 'windows'
    if (platform == 'darwin') return 'mac'
    if (platform == 'linux') return 'linux'
    throw new Error(`automatic Caddy installation is not supported on ${platform}`)
}

function releaseArch(arch: string) {
    if (arch == 'x64') return 'amd64'
    if (arch == 'arm64') return 'arm64'
    throw new Error(`automatic Caddy installation is not supported on ${arch}`)
}

function cacheRoot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, homeDir: string) {
    if (platform == 'win32') {
        return env['LOCALAPPDATA'] || path.join(homeDir, 'AppData', 'Local')
    }
    if (platform == 'darwin') return path.join(homeDir, 'Library', 'Caches')
    return env['XDG_CACHE_HOME'] || path.join(homeDir, '.cache')
}

function dataRoot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, homeDir: string) {
    if (platform == 'win32') {
        return env['APPDATA'] || path.join(homeDir, 'AppData', 'Roaming')
    }
    if (platform == 'darwin') return path.join(homeDir, 'Library', 'Application Support')
    return env['XDG_DATA_HOME'] || path.join(homeDir, '.local', 'share')
}

function hashText(value: string) {
    return createHash('sha256').update(value).digest('hex')
}

async function replaceFile(tempPath: string, targetPath: string) {
    try {
        await rename(tempPath, targetPath)
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code != 'EEXIST' && code != 'EPERM') throw error
        await rm(targetPath, {force: true})
        await rename(tempPath, targetPath)
    }
}

function parseState(value: string): HttpsRuntimeState | undefined {
    let state: unknown
    try {
        state = JSON.parse(value)
    } catch {
        return undefined
    }
    if (!state || typeof state != 'object') return undefined
    const candidate = state as Partial<HttpsRuntimeState>
    if (candidate.version != 1 || typeof candidate.pid != 'number' ||
        typeof candidate.configPath != 'string' || typeof candidate.caddyfilePath != 'string' ||
        typeof candidate.caddyPath != 'string') {
        return undefined
    }
    return candidate as HttpsRuntimeState
}

// === Process and network resources ===

function execFile(file: string, args: string[], opts: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    timeoutMs?: number
} = {}) {
    return new Promise<{stdout: string, stderr: string}>(function runExecutable(resolve, reject) {
        const child = spawn(file, args, {
            cwd: opts.cwd,
            env: opts.env,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        child.stdout.on('data', function collectStdout(chunk: Buffer) {
            stdout.push(chunk)
        })
        child.stderr.on('data', function collectStderr(chunk: Buffer) {
            stderr.push(chunk)
        })

        let timer: NodeJS.Timeout | undefined
        if (opts.timeoutMs) {
            timer = setTimeout(function terminateTimedOutProcess() {
                child.kill()
            }, opts.timeoutMs)
        }
        child.once('error', function executableError(error) {
            if (timer) clearTimeout(timer)
            reject(error)
        })
        child.once('exit', function executableExit(code) {
            if (timer) clearTimeout(timer)
            const result = {
                stdout: Buffer.concat(stdout).toString('utf8'),
                stderr: Buffer.concat(stderr).toString('utf8'),
            }
            if (code == 0) {
                resolve(result)
                return
            }
            reject(new Error(result.stderr.trim() || result.stdout.trim() ||
                `${file} exited with code ${code}`))
        })
    })
}

function connectPort(host: string, port: number, timeoutMs = 3000) {
    return new Promise<void>(function connectToPort(resolve, reject) {
        const socket = connectNet({host, port})
        const timer = setTimeout(function portTimeout() {
            socket.destroy()
            reject(new Error(`connection to ${host}:${port} timed out`))
        }, timeoutMs)
        socket.once('connect', function portConnected() {
            clearTimeout(timer)
            socket.destroy()
            resolve()
        })
        socket.once('error', function portError(error) {
            clearTimeout(timer)
            reject(error)
        })
    })
}

function backendAddress(backend: string) {
    const parsed = new URL(backend.includes('://') ? backend : `http://${backend}`)
    return {
        host: parsed.hostname,
        port: Number(parsed.port || (parsed.protocol == 'https:' ? 443 : 80)),
    }
}

function certificateAddress(config: HttpsConfig) {
    return {
        host: config.bind == '0.0.0.0'
            ? '127.0.0.1'
            : config.bind == '::' ? '::1' : config.bind,
        port: config.publicPort,
    }
}

function inspectCertificate(config: HttpsConfig, timeoutMs = 5000) {
    const address = certificateAddress(config)
    return new Promise<{
        subject: string
        issuer: string
        validFrom: string
        validTo: string
        fingerprint256: string
    }>(function connectCertificate(resolve, reject) {
        const socket = connectTls({
            host: address.host,
            port: address.port,
            servername: isIP(config.identity) ? undefined : config.identity,
            rejectUnauthorized: true,
            checkServerIdentity: function checkConfiguredIdentity(_host, cert) {
                return checkServerIdentity(config.identity, cert)
            },
        })
        const timer = setTimeout(function certificateTimeout() {
            socket.destroy()
            reject(new Error(`TLS connection to ${address.host}:${address.port} timed out`))
        }, timeoutMs)
        socket.once('secureConnect', function certificateConnected() {
            clearTimeout(timer)
            const cert = socket.getPeerCertificate()
            socket.destroy()
            const subject = cert.subject?.CN
            const issuer = cert.issuer?.CN
            resolve({
                subject: Array.isArray(subject) ? subject[0] || config.identity : subject || config.identity,
                issuer: Array.isArray(issuer) ? issuer[0] || '' : issuer || '',
                validFrom: cert.valid_from,
                validTo: cert.valid_to,
                fingerprint256: cert.fingerprint256,
            })
        })
        socket.once('error', function certificateError(error) {
            clearTimeout(timer)
            reject(error)
        })
    })
}

async function downloadFile(url: string, targetPath: string) {
    const response = await axios.get<ArrayBuffer>(url, {
        responseType: 'arraybuffer',
        maxRedirects: 10,
        timeout: 120000,
    })
    const bytes = Buffer.from(response.data)
    await writeFile(targetPath, bytes)
    return bytes
}

async function downloadText(url: string) {
    const response = await axios.get<string>(url, {
        responseType: 'text',
        maxRedirects: 10,
        timeout: 30000,
    })
    return response.data
}

async function extractArchive(
    archivePath: string,
    targetDir: string,
    platform: NodeJS.Platform,
) {
    try {
        await execFile('tar', ['-xf', archivePath, '-C', targetDir], {timeoutMs: 60000})
        return
    } catch (error) {
        if (platform != 'win32') throw error
    }

    const escapedArchive = archivePath.replaceAll("'", "''")
    const escapedTarget = targetDir.replaceAll("'", "''")
    await execFile('powershell', [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-Command',
        `Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath '${escapedTarget}' -Force`,
    ], {timeoutMs: 60000})
}

async function processCommandLine(pid: number, platform: NodeJS.Platform) {
    try {
        process.kill(pid, 0)
    } catch {
        return undefined
    }

    if (platform == 'linux') {
        try {
            return (await readFile(`/proc/${pid}/cmdline`, 'utf8')).replaceAll('\0', ' ')
        } catch {
            // Fall through to ps on non-proc Linux environments.
        }
    }
    if (platform != 'win32') {
        try {
            return (await execFile('ps', ['-p', String(pid), '-o', 'command='], {
                timeoutMs: 5000,
            })).stdout.trim()
        } catch {
            return undefined
        }
    }

    const command = [
        `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction SilentlyContinue`,
        'if ($null -ne $p) { [Console]::Out.Write($p.CommandLine) }',
    ].join('; ')
    try {
        return (await execFile('powershell', [
            '-NoProfile',
            '-Command', command,
        ], {timeoutMs: 5000})).stdout.trim() || undefined
    } catch {
        return undefined
    }
}

// === HTTPS resource facade ===

export function createNodeHttpsResource(deps: NodeHttpsResourceDeps = {}) {
    const env = deps.env || process.env
    const platform = deps.platform || process.platform
    const arch = deps.arch || process.arch
    const home = deps.homeDir || homedir()
    const log = deps.onLog || (() => undefined)
    const cacheDir = path.join(cacheRoot(env, platform, home), 'wenay-common2', 'tools',
        'caddy', CADDY_VERSION)
    const storageDir = path.join(dataRoot(env, platform, home), 'wenay-common2', 'caddy')
    const cachedCaddyPath = path.join(cacheDir, executableName(platform))

    function paths(projectRoot: string, configPath?: string) {
        const root = path.resolve(projectRoot)
        const runtimeDir = path.join(root, '.wenay-https')
        return {
            projectRoot: root,
            inputConfigPath: path.resolve(root, configPath || 'wenay-https.json'),
            runtimeDir,
            statePath: path.join(runtimeDir, 'state.json'),
            stateTempPath: path.join(runtimeDir, 'state.json.tmp'),
            caddyfilePath: path.join(runtimeDir, 'Caddyfile'),
            caddyOutPath: path.join(runtimeDir, 'caddy.out.log'),
            caddyErrPath: path.join(runtimeDir, 'caddy.err.log'),
            storageDir,
        }
    }

    async function loadConfig(projectRoot: string, configPath?: string) {
        const projectPaths = paths(projectRoot, configPath)
        let value: unknown
        try {
            value = JSON.parse(await readFile(projectPaths.inputConfigPath, 'utf8'))
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code == 'ENOENT') return undefined
            throw new Error(`could not read ${projectPaths.inputConfigPath}: ${(error as Error).message}`)
        }
        if (!value || typeof value != 'object' || Array.isArray(value)) {
            throw new Error(`${projectPaths.inputConfigPath} must contain a JSON object`)
        }
        return value
    }

    async function loadState(projectRoot: string, configPath?: string) {
        const projectPaths = paths(projectRoot, configPath)
        try {
            return parseState(await readFile(projectPaths.statePath, 'utf8'))
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code == 'ENOENT') return undefined
            throw error
        }
    }

    async function saveState(state: HttpsRuntimeState) {
        const projectPaths = paths(state.projectRoot, state.configPath)
        await mkdir(projectPaths.runtimeDir, {recursive: true})
        await writeFile(projectPaths.stateTempPath, JSON.stringify(state, null, 2) + '\n', 'utf8')
        await replaceFile(projectPaths.stateTempPath, projectPaths.statePath)
    }

    async function removeState(projectRoot: string, configPath?: string) {
        await rm(paths(projectRoot, configPath).statePath, {force: true})
    }

    async function withProjectLock<T>(
        projectRoot: string,
        configPath: string | undefined,
        task: () => Promise<T>,
    ) {
        const projectPaths = paths(projectRoot, configPath)
        const lockPath = path.join(projectPaths.runtimeDir, '.operation.lock')
        await mkdir(projectPaths.runtimeDir, {recursive: true})
        const deadline = Date.now() + 3600000
        let lock: Awaited<ReturnType<typeof open>> | undefined
        while (!lock && Date.now() < deadline) {
            try {
                lock = await open(lockPath, 'wx')
                await lock.writeFile(String(process.pid), 'utf8')
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code != 'EEXIST') throw error
                let ownerPid = 0
                try {
                    ownerPid = Number(await readFile(lockPath, 'utf8'))
                } catch {
                    // A concurrent owner may still be writing the PID.
                }
                let ownerRunning = false
                if (ownerPid > 0) {
                    try {
                        process.kill(ownerPid, 0)
                        ownerRunning = true
                    } catch {
                        // A dead owner cannot release its lock.
                    }
                }
                if (ownerPid > 0 && !ownerRunning) {
                    await rm(lockPath, {force: true})
                    continue
                }
                await sleepAsync(100)
            }
        }
        if (!lock) throw new Error(`timed out waiting for HTTPS operation lock: ${lockPath}`)
        try {
            return await task()
        } finally {
            await lock.close()
            await rm(lockPath, {force: true})
        }
    }

    async function findOnPath() {
        const command = platform == 'win32' ? 'where.exe' : 'which'
        try {
            const result = await execFile(command, ['caddy'], {env, timeoutMs: 5000})
            return result.stdout.split(/\r?\n/).find(Boolean)
        } catch {
            return undefined
        }
    }

    async function findCaddy(explicitPath?: string) {
        if (explicitPath) {
            const resolved = path.resolve(explicitPath)
            return await fileExists(resolved) ? resolved : undefined
        }
        if (env['WENAY_CADDY_PATH']) {
            const resolved = path.resolve(env['WENAY_CADDY_PATH'])
            if (await fileExists(resolved)) return resolved
        }
        const onPath = await findOnPath()
        if (onPath) return onPath
        return await fileExists(cachedCaddyPath) ? cachedCaddyPath : undefined
    }

    async function waitForInstallLock(lockPath: string) {
        const deadline = Date.now() + 120000
        while (Date.now() < deadline) {
            if (await fileExists(cachedCaddyPath)) return cachedCaddyPath
            try {
                const details = await stat(lockPath)
                if (Date.now() - details.mtimeMs > 300000) {
                    await unlink(lockPath)
                    return undefined
                }
            } catch {
                return undefined
            }
            await sleepAsync(250)
        }
        throw new Error(`timed out waiting for the Caddy install lock: ${lockPath}`)
    }

    async function installCaddy() {
        await mkdir(cacheDir, {recursive: true})
        if (await fileExists(cachedCaddyPath)) return cachedCaddyPath

        const lockPath = path.join(cacheDir, '.install.lock')
        let lock: Awaited<ReturnType<typeof open>> | undefined
        try {
            lock = await open(lockPath, 'wx')
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code != 'EEXIST') throw error
            const installed = await waitForInstallLock(lockPath)
            if (installed) return installed
            lock = await open(lockPath, 'wx')
        }

        const releaseOs = releasePlatform(platform)
        const releaseCpu = releaseArch(arch)
        const archiveExtension = platform == 'win32' ? 'zip' : 'tar.gz'
        const archiveName = `caddy_${CADDY_VERSION}_${releaseOs}_${releaseCpu}.${archiveExtension}`
        const releaseBase = `https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}`
        const archivePath = path.join(cacheDir, `.download-${archiveName}`)
        const extractDir = path.join(cacheDir, '.extract')
        try {
            log(`Downloading Caddy ${CADDY_VERSION} to the shared user cache...`)
            const [archiveBytes, checksums] = await Promise.all([
                downloadFile(`${releaseBase}/${archiveName}`, archivePath),
                downloadText(`${releaseBase}/caddy_${CADDY_VERSION}_checksums.txt`),
            ])
            const checksumLine = checksums.split(/\r?\n/)
                .find(line => line.trim().endsWith(archiveName))
            const expected = checksumLine?.trim().split(/\s+/)[0]?.toLowerCase()
            const checksumAlgorithm = expected?.length == 128 ? 'sha512' : 'sha256'
            const actual = createHash(checksumAlgorithm).update(archiveBytes).digest('hex')
            if (!expected || expected != actual) {
                throw new Error(`Caddy checksum mismatch for ${archiveName}`)
            }

            await rm(extractDir, {recursive: true, force: true})
            await mkdir(extractDir, {recursive: true})
            await extractArchive(archivePath, extractDir, platform)
            const extracted = path.join(extractDir, executableName(platform))
            if (!(await fileExists(extracted))) {
                throw new Error(`Caddy archive did not contain ${executableName(platform)}`)
            }
            if (platform != 'win32') await chmod(extracted, 0o755)
            try {
                await rename(extracted, cachedCaddyPath)
            } catch {
                await copyFile(extracted, cachedCaddyPath)
                if (platform != 'win32') await chmod(cachedCaddyPath, 0o755)
            }
            return cachedCaddyPath
        } finally {
            await rm(archivePath, {force: true})
            await rm(extractDir, {recursive: true, force: true})
            await lock.close()
            await rm(lockPath, {force: true})
        }
    }

    async function ensureCaddy(explicitPath?: string) {
        const found = await findCaddy(explicitPath)
        if (found) return found
        if (explicitPath) throw new Error(`configured Caddy executable does not exist: ${explicitPath}`)
        return installCaddy()
    }

    async function writeCaddyfile(projectRoot: string, configPath: string | undefined, value: string) {
        const projectPaths = paths(projectRoot, configPath)
        await Promise.all([
            mkdir(projectPaths.runtimeDir, {recursive: true}),
            mkdir(storageDir, {recursive: true}),
        ])
        const tempPath = projectPaths.caddyfilePath + '.tmp'
        await writeFile(tempPath, value, 'utf8')
        await replaceFile(tempPath, projectPaths.caddyfilePath)
        return projectPaths.caddyfilePath
    }

    async function validateCaddyfile(caddyPath: string, caddyfilePath: string, projectRoot: string) {
        await execFile(caddyPath, [
            'fmt', '--overwrite', caddyfilePath,
        ], {cwd: projectRoot, env, timeoutMs: 30000})
        await execFile(caddyPath, [
            'validate', '--config', caddyfilePath, '--adapter', 'caddyfile',
        ], {cwd: projectRoot, env, timeoutMs: 30000})
    }

    async function stateProcess(state: HttpsRuntimeState | undefined) {
        if (!state) return {running: false, owned: false}
        try {
            process.kill(state.pid, 0)
        } catch {
            return {running: false, owned: false}
        }
        const commandLine = await processCommandLine(state.pid, platform)
        if (!commandLine) return {running: true, owned: false}
        const owned = commandLine.toLowerCase().includes(state.caddyfilePath.toLowerCase()) &&
            commandLine.toLowerCase().includes('caddy')
        return {running: true, owned, commandLine}
    }

    async function stopState(state: HttpsRuntimeState) {
        const processState = await stateProcess(state)
        if (!processState.running) return false
        if (!processState.owned) {
            throw new Error(`process ${state.pid} no longer belongs to this HTTPS runtime`)
        }
        process.kill(state.pid)
        const deadline = Date.now() + 10000
        while (Date.now() < deadline) {
            if (!(await stateProcess(state)).running) return true
            await sleepAsync(100)
        }
        throw new Error(`Caddy process ${state.pid} did not stop within ten seconds`)
    }

    async function startCaddy(
        projectRoot: string,
        configPath: string | undefined,
        caddyPath: string,
        caddyfilePath: string,
        config: HttpsConfig,
        configHash: string,
    ) {
        const projectPaths = paths(projectRoot, configPath)
        const [out, err] = await Promise.all([
            open(projectPaths.caddyOutPath, 'a'),
            open(projectPaths.caddyErrPath, 'a'),
        ])
        let child
        try {
            child = spawn(caddyPath, [
                'run', '--config', caddyfilePath, '--adapter', 'caddyfile',
            ], {
                cwd: projectRoot,
                env,
                detached: true,
                windowsHide: true,
                stdio: ['ignore', out.fd, err.fd],
            })
            await new Promise<void>(function waitForSpawn(resolve, reject) {
                child!.once('spawn', function caddySpawned() { resolve() })
                child!.once('error', function caddySpawnError(error: Error) { reject(error) })
            })
        } finally {
            await Promise.all([out.close(), err.close()])
        }
        child.unref()
        if (!child.pid) throw new Error('Caddy did not return a process id')

        const state: HttpsRuntimeState = {
            version: 1,
            pid: child.pid,
            projectRoot: path.resolve(projectRoot),
            configPath: configPath || 'wenay-https.json',
            caddyfilePath,
            caddyPath,
            identity: config.identity,
            publicPort: config.publicPort,
            challengePort: config.challengePort,
            bind: config.bind,
            backend: config.backend,
            configHash,
            startedAt: new Date().toISOString(),
        }
        await saveState(state)
        return state
    }

    async function waitCertificate(config: HttpsConfig, state: HttpsRuntimeState) {
        const deadline = Date.now() + config.certificateWaitSeconds * 1000
        let lastError: unknown
        while (Date.now() < deadline) {
            const processState = await stateProcess(state)
            if (!processState.running || !processState.owned) {
                throw new Error(`Caddy exited while obtaining the certificate; inspect ${
                    paths(state.projectRoot, state.configPath).caddyErrPath}`)
            }
            try {
                return await inspectCertificate(config)
            } catch (error) {
                lastError = error
            }
            await sleepAsync(1000)
        }
        throw new Error(`certificate was not ready after ${config.certificateWaitSeconds} seconds: ${
            (lastError as Error | undefined)?.message || 'unknown TLS error'}`)
    }

    async function inspectBackend(config: HttpsConfig) {
        const address = backendAddress(config.backend)
        await connectPort(address.host, address.port)
        return address
    }

    async function resolveIdentity(config: HttpsConfig) {
        if (config.rawIp) return [config.identity]
        return (await dns.lookup(config.identity, {all: true})).map(item => item.address)
    }

    return {
        project: {
            paths,
            loadConfig,
            state: {
                load: loadState,
                save: saveState,
                remove: removeState,
            },
            withLock: withProjectLock,
        },
        caddy: {
            version: CADDY_VERSION,
            storageDir,
            executable: {
                find: findCaddy,
                ensure: ensureCaddy,
            },
            config: {
                hash: hashText,
                write: writeCaddyfile,
                validate: validateCaddyfile,
            },
            process: {
                state: stateProcess,
                stop: stopState,
                start: startCaddy,
            },
            certificate: {
                inspect: inspectCertificate,
                wait: waitCertificate,
            },
        },
        network: {
            inspectBackend,
            resolveIdentity,
        },
    }
}

export type NodeHttpsResource = ReturnType<typeof createNodeHttpsResource>
