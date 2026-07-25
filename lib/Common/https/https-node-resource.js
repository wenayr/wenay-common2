"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createNodeHttpsResource = createNodeHttpsResource;
const node_crypto_1 = require("node:crypto");
const node_dns_1 = require("node:dns");
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = __importDefault(require("node:path"));
const node_child_process_1 = require("node:child_process");
const node_net_1 = require("node:net");
const node_tls_1 = require("node:tls");
const axios_1 = __importDefault(require("axios"));
const common_1 = require("../core/common");
const CADDY_VERSION = '2.11.4';
function fileExists(filePath) {
    return (0, promises_1.access)(filePath).then(() => true, () => false);
}
function executableName(platform) {
    return platform == 'win32' ? 'caddy.exe' : 'caddy';
}
function releasePlatform(platform) {
    if (platform == 'win32')
        return 'windows';
    if (platform == 'darwin')
        return 'mac';
    if (platform == 'linux')
        return 'linux';
    throw new Error(`automatic Caddy installation is not supported on ${platform}`);
}
function releaseArch(arch) {
    if (arch == 'x64')
        return 'amd64';
    if (arch == 'arm64')
        return 'arm64';
    throw new Error(`automatic Caddy installation is not supported on ${arch}`);
}
function cacheRoot(env, platform, homeDir) {
    if (platform == 'win32') {
        return env['LOCALAPPDATA'] || node_path_1.default.join(homeDir, 'AppData', 'Local');
    }
    if (platform == 'darwin')
        return node_path_1.default.join(homeDir, 'Library', 'Caches');
    return env['XDG_CACHE_HOME'] || node_path_1.default.join(homeDir, '.cache');
}
function dataRoot(env, platform, homeDir) {
    if (platform == 'win32') {
        return env['APPDATA'] || node_path_1.default.join(homeDir, 'AppData', 'Roaming');
    }
    if (platform == 'darwin')
        return node_path_1.default.join(homeDir, 'Library', 'Application Support');
    return env['XDG_DATA_HOME'] || node_path_1.default.join(homeDir, '.local', 'share');
}
function hashText(value) {
    return (0, node_crypto_1.createHash)('sha256').update(value).digest('hex');
}
async function replaceFile(tempPath, targetPath) {
    try {
        await (0, promises_1.rename)(tempPath, targetPath);
    }
    catch (error) {
        const code = error.code;
        if (code != 'EEXIST' && code != 'EPERM')
            throw error;
        await (0, promises_1.rm)(targetPath, { force: true });
        await (0, promises_1.rename)(tempPath, targetPath);
    }
}
function parseState(value) {
    let state;
    try {
        state = JSON.parse(value);
    }
    catch {
        return undefined;
    }
    if (!state || typeof state != 'object')
        return undefined;
    const candidate = state;
    if (candidate.version != 1 || typeof candidate.pid != 'number' ||
        typeof candidate.configPath != 'string' || typeof candidate.caddyfilePath != 'string' ||
        typeof candidate.caddyPath != 'string') {
        return undefined;
    }
    return candidate;
}
function execFile(file, args, opts = {}) {
    return new Promise(function runExecutable(resolve, reject) {
        const child = (0, node_child_process_1.spawn)(file, args, {
            cwd: opts.cwd,
            env: opts.env,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const stdout = [];
        const stderr = [];
        child.stdout.on('data', function collectStdout(chunk) {
            stdout.push(chunk);
        });
        child.stderr.on('data', function collectStderr(chunk) {
            stderr.push(chunk);
        });
        let timer;
        if (opts.timeoutMs) {
            timer = setTimeout(function terminateTimedOutProcess() {
                child.kill();
            }, opts.timeoutMs);
        }
        child.once('error', function executableError(error) {
            if (timer)
                clearTimeout(timer);
            reject(error);
        });
        child.once('exit', function executableExit(code) {
            if (timer)
                clearTimeout(timer);
            const result = {
                stdout: Buffer.concat(stdout).toString('utf8'),
                stderr: Buffer.concat(stderr).toString('utf8'),
            };
            if (code == 0) {
                resolve(result);
                return;
            }
            reject(new Error(result.stderr.trim() || result.stdout.trim() ||
                `${file} exited with code ${code}`));
        });
    });
}
function connectPort(host, port, timeoutMs = 3000) {
    return new Promise(function connectToPort(resolve, reject) {
        const socket = (0, node_net_1.connect)({ host, port });
        const timer = setTimeout(function portTimeout() {
            socket.destroy();
            reject(new Error(`connection to ${host}:${port} timed out`));
        }, timeoutMs);
        socket.once('connect', function portConnected() {
            clearTimeout(timer);
            socket.destroy();
            resolve();
        });
        socket.once('error', function portError(error) {
            clearTimeout(timer);
            reject(error);
        });
    });
}
function backendAddress(backend) {
    const parsed = new URL(backend.includes('://') ? backend : `http://${backend}`);
    return {
        host: parsed.hostname,
        port: Number(parsed.port || (parsed.protocol == 'https:' ? 443 : 80)),
    };
}
function certificateAddress(config) {
    return {
        host: config.bind == '0.0.0.0'
            ? '127.0.0.1'
            : config.bind == '::' ? '::1' : config.bind,
        port: config.publicPort,
    };
}
function inspectCertificate(config, timeoutMs = 5000) {
    const address = certificateAddress(config);
    return new Promise(function connectCertificate(resolve, reject) {
        const socket = (0, node_tls_1.connect)({
            host: address.host,
            port: address.port,
            servername: (0, node_net_1.isIP)(config.identity) ? undefined : config.identity,
            rejectUnauthorized: true,
            checkServerIdentity: function checkConfiguredIdentity(_host, cert) {
                return (0, node_tls_1.checkServerIdentity)(config.identity, cert);
            },
        });
        const timer = setTimeout(function certificateTimeout() {
            socket.destroy();
            reject(new Error(`TLS connection to ${address.host}:${address.port} timed out`));
        }, timeoutMs);
        socket.once('secureConnect', function certificateConnected() {
            clearTimeout(timer);
            const cert = socket.getPeerCertificate();
            socket.destroy();
            const subject = cert.subject?.CN;
            const issuer = cert.issuer?.CN;
            resolve({
                subject: Array.isArray(subject) ? subject[0] || config.identity : subject || config.identity,
                issuer: Array.isArray(issuer) ? issuer[0] || '' : issuer || '',
                validFrom: cert.valid_from,
                validTo: cert.valid_to,
                fingerprint256: cert.fingerprint256,
            });
        });
        socket.once('error', function certificateError(error) {
            clearTimeout(timer);
            reject(error);
        });
    });
}
async function downloadFile(url, targetPath) {
    const response = await axios_1.default.get(url, {
        responseType: 'arraybuffer',
        maxRedirects: 10,
        timeout: 120000,
    });
    const bytes = Buffer.from(response.data);
    await (0, promises_1.writeFile)(targetPath, bytes);
    return bytes;
}
async function downloadText(url) {
    const response = await axios_1.default.get(url, {
        responseType: 'text',
        maxRedirects: 10,
        timeout: 30000,
    });
    return response.data;
}
async function extractArchive(archivePath, targetDir, platform) {
    try {
        await execFile('tar', ['-xf', archivePath, '-C', targetDir], { timeoutMs: 60000 });
        return;
    }
    catch (error) {
        if (platform != 'win32')
            throw error;
    }
    const escapedArchive = archivePath.replaceAll("'", "''");
    const escapedTarget = targetDir.replaceAll("'", "''");
    await execFile('powershell', [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-Command',
        `Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath '${escapedTarget}' -Force`,
    ], { timeoutMs: 60000 });
}
async function processCommandLine(pid, platform) {
    try {
        process.kill(pid, 0);
    }
    catch {
        return undefined;
    }
    if (platform == 'linux') {
        try {
            return (await (0, promises_1.readFile)(`/proc/${pid}/cmdline`, 'utf8')).replaceAll('\0', ' ');
        }
        catch {
        }
    }
    if (platform != 'win32') {
        try {
            return (await execFile('ps', ['-p', String(pid), '-o', 'command='], {
                timeoutMs: 5000,
            })).stdout.trim();
        }
        catch {
            return undefined;
        }
    }
    const command = [
        `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction SilentlyContinue`,
        'if ($null -ne $p) { [Console]::Out.Write($p.CommandLine) }',
    ].join('; ');
    try {
        return (await execFile('powershell', [
            '-NoProfile',
            '-Command', command,
        ], { timeoutMs: 5000 })).stdout.trim() || undefined;
    }
    catch {
        return undefined;
    }
}
function createNodeHttpsResource(deps = {}) {
    const env = deps.env || process.env;
    const platform = deps.platform || process.platform;
    const arch = deps.arch || process.arch;
    const home = deps.homeDir || (0, node_os_1.homedir)();
    const log = deps.onLog || (() => undefined);
    const cacheDir = node_path_1.default.join(cacheRoot(env, platform, home), 'wenay-common2', 'tools', 'caddy', CADDY_VERSION);
    const storageDir = node_path_1.default.join(dataRoot(env, platform, home), 'wenay-common2', 'caddy');
    const cachedCaddyPath = node_path_1.default.join(cacheDir, executableName(platform));
    function paths(projectRoot, configPath) {
        const root = node_path_1.default.resolve(projectRoot);
        const runtimeDir = node_path_1.default.join(root, '.wenay-https');
        return {
            projectRoot: root,
            inputConfigPath: node_path_1.default.resolve(root, configPath || 'wenay-https.json'),
            runtimeDir,
            statePath: node_path_1.default.join(runtimeDir, 'state.json'),
            stateTempPath: node_path_1.default.join(runtimeDir, 'state.json.tmp'),
            caddyfilePath: node_path_1.default.join(runtimeDir, 'Caddyfile'),
            caddyOutPath: node_path_1.default.join(runtimeDir, 'caddy.out.log'),
            caddyErrPath: node_path_1.default.join(runtimeDir, 'caddy.err.log'),
            storageDir,
        };
    }
    async function loadConfig(projectRoot, configPath) {
        const projectPaths = paths(projectRoot, configPath);
        let value;
        try {
            value = JSON.parse(await (0, promises_1.readFile)(projectPaths.inputConfigPath, 'utf8'));
        }
        catch (error) {
            if (error.code == 'ENOENT')
                return undefined;
            throw new Error(`could not read ${projectPaths.inputConfigPath}: ${error.message}`);
        }
        if (!value || typeof value != 'object' || Array.isArray(value)) {
            throw new Error(`${projectPaths.inputConfigPath} must contain a JSON object`);
        }
        return value;
    }
    async function loadState(projectRoot, configPath) {
        const projectPaths = paths(projectRoot, configPath);
        try {
            return parseState(await (0, promises_1.readFile)(projectPaths.statePath, 'utf8'));
        }
        catch (error) {
            if (error.code == 'ENOENT')
                return undefined;
            throw error;
        }
    }
    async function saveState(state) {
        const projectPaths = paths(state.projectRoot, state.configPath);
        await (0, promises_1.mkdir)(projectPaths.runtimeDir, { recursive: true });
        await (0, promises_1.writeFile)(projectPaths.stateTempPath, JSON.stringify(state, null, 2) + '\n', 'utf8');
        await replaceFile(projectPaths.stateTempPath, projectPaths.statePath);
    }
    async function removeState(projectRoot, configPath) {
        await (0, promises_1.rm)(paths(projectRoot, configPath).statePath, { force: true });
    }
    async function withProjectLock(projectRoot, configPath, task) {
        const projectPaths = paths(projectRoot, configPath);
        const lockPath = node_path_1.default.join(projectPaths.runtimeDir, '.operation.lock');
        await (0, promises_1.mkdir)(projectPaths.runtimeDir, { recursive: true });
        const deadline = Date.now() + 3600000;
        let lock;
        while (!lock && Date.now() < deadline) {
            try {
                lock = await (0, promises_1.open)(lockPath, 'wx');
                await lock.writeFile(String(process.pid), 'utf8');
            }
            catch (error) {
                if (error.code != 'EEXIST')
                    throw error;
                let ownerPid = 0;
                try {
                    ownerPid = Number(await (0, promises_1.readFile)(lockPath, 'utf8'));
                }
                catch {
                }
                let ownerRunning = false;
                if (ownerPid > 0) {
                    try {
                        process.kill(ownerPid, 0);
                        ownerRunning = true;
                    }
                    catch {
                    }
                }
                if (ownerPid > 0 && !ownerRunning) {
                    await (0, promises_1.rm)(lockPath, { force: true });
                    continue;
                }
                await (0, common_1.sleepAsync)(100);
            }
        }
        if (!lock)
            throw new Error(`timed out waiting for HTTPS operation lock: ${lockPath}`);
        try {
            return await task();
        }
        finally {
            await lock.close();
            await (0, promises_1.rm)(lockPath, { force: true });
        }
    }
    async function findOnPath() {
        const command = platform == 'win32' ? 'where.exe' : 'which';
        try {
            const result = await execFile(command, ['caddy'], { env, timeoutMs: 5000 });
            return result.stdout.split(/\r?\n/).find(Boolean);
        }
        catch {
            return undefined;
        }
    }
    async function findCaddy(explicitPath) {
        if (explicitPath) {
            const resolved = node_path_1.default.resolve(explicitPath);
            return await fileExists(resolved) ? resolved : undefined;
        }
        if (env['WENAY_CADDY_PATH']) {
            const resolved = node_path_1.default.resolve(env['WENAY_CADDY_PATH']);
            if (await fileExists(resolved))
                return resolved;
        }
        const onPath = await findOnPath();
        if (onPath)
            return onPath;
        return await fileExists(cachedCaddyPath) ? cachedCaddyPath : undefined;
    }
    async function waitForInstallLock(lockPath) {
        const deadline = Date.now() + 120000;
        while (Date.now() < deadline) {
            if (await fileExists(cachedCaddyPath))
                return cachedCaddyPath;
            try {
                const details = await (0, promises_1.stat)(lockPath);
                if (Date.now() - details.mtimeMs > 300000) {
                    await (0, promises_1.unlink)(lockPath);
                    return undefined;
                }
            }
            catch {
                return undefined;
            }
            await (0, common_1.sleepAsync)(250);
        }
        throw new Error(`timed out waiting for the Caddy install lock: ${lockPath}`);
    }
    async function installCaddy() {
        await (0, promises_1.mkdir)(cacheDir, { recursive: true });
        if (await fileExists(cachedCaddyPath))
            return cachedCaddyPath;
        const lockPath = node_path_1.default.join(cacheDir, '.install.lock');
        let lock;
        try {
            lock = await (0, promises_1.open)(lockPath, 'wx');
        }
        catch (error) {
            if (error.code != 'EEXIST')
                throw error;
            const installed = await waitForInstallLock(lockPath);
            if (installed)
                return installed;
            lock = await (0, promises_1.open)(lockPath, 'wx');
        }
        const releaseOs = releasePlatform(platform);
        const releaseCpu = releaseArch(arch);
        const archiveExtension = platform == 'win32' ? 'zip' : 'tar.gz';
        const archiveName = `caddy_${CADDY_VERSION}_${releaseOs}_${releaseCpu}.${archiveExtension}`;
        const releaseBase = `https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}`;
        const archivePath = node_path_1.default.join(cacheDir, `.download-${archiveName}`);
        const extractDir = node_path_1.default.join(cacheDir, '.extract');
        try {
            log(`Downloading Caddy ${CADDY_VERSION} to the shared user cache...`);
            const [archiveBytes, checksums] = await Promise.all([
                downloadFile(`${releaseBase}/${archiveName}`, archivePath),
                downloadText(`${releaseBase}/caddy_${CADDY_VERSION}_checksums.txt`),
            ]);
            const checksumLine = checksums.split(/\r?\n/)
                .find(line => line.trim().endsWith(archiveName));
            const expected = checksumLine?.trim().split(/\s+/)[0]?.toLowerCase();
            const checksumAlgorithm = expected?.length == 128 ? 'sha512' : 'sha256';
            const actual = (0, node_crypto_1.createHash)(checksumAlgorithm).update(archiveBytes).digest('hex');
            if (!expected || expected != actual) {
                throw new Error(`Caddy checksum mismatch for ${archiveName}`);
            }
            await (0, promises_1.rm)(extractDir, { recursive: true, force: true });
            await (0, promises_1.mkdir)(extractDir, { recursive: true });
            await extractArchive(archivePath, extractDir, platform);
            const extracted = node_path_1.default.join(extractDir, executableName(platform));
            if (!(await fileExists(extracted))) {
                throw new Error(`Caddy archive did not contain ${executableName(platform)}`);
            }
            if (platform != 'win32')
                await (0, promises_1.chmod)(extracted, 0o755);
            try {
                await (0, promises_1.rename)(extracted, cachedCaddyPath);
            }
            catch {
                await (0, promises_1.copyFile)(extracted, cachedCaddyPath);
                if (platform != 'win32')
                    await (0, promises_1.chmod)(cachedCaddyPath, 0o755);
            }
            return cachedCaddyPath;
        }
        finally {
            await (0, promises_1.rm)(archivePath, { force: true });
            await (0, promises_1.rm)(extractDir, { recursive: true, force: true });
            await lock.close();
            await (0, promises_1.rm)(lockPath, { force: true });
        }
    }
    async function ensureCaddy(explicitPath) {
        const found = await findCaddy(explicitPath);
        if (found)
            return found;
        if (explicitPath)
            throw new Error(`configured Caddy executable does not exist: ${explicitPath}`);
        return installCaddy();
    }
    async function writeCaddyfile(projectRoot, configPath, value) {
        const projectPaths = paths(projectRoot, configPath);
        await Promise.all([
            (0, promises_1.mkdir)(projectPaths.runtimeDir, { recursive: true }),
            (0, promises_1.mkdir)(storageDir, { recursive: true }),
        ]);
        const tempPath = projectPaths.caddyfilePath + '.tmp';
        await (0, promises_1.writeFile)(tempPath, value, 'utf8');
        await replaceFile(tempPath, projectPaths.caddyfilePath);
        return projectPaths.caddyfilePath;
    }
    async function validateCaddyfile(caddyPath, caddyfilePath, projectRoot) {
        await execFile(caddyPath, [
            'fmt', '--overwrite', caddyfilePath,
        ], { cwd: projectRoot, env, timeoutMs: 30000 });
        await execFile(caddyPath, [
            'validate', '--config', caddyfilePath, '--adapter', 'caddyfile',
        ], { cwd: projectRoot, env, timeoutMs: 30000 });
    }
    async function stateProcess(state) {
        if (!state)
            return { running: false, owned: false };
        try {
            process.kill(state.pid, 0);
        }
        catch {
            return { running: false, owned: false };
        }
        const commandLine = await processCommandLine(state.pid, platform);
        if (!commandLine)
            return { running: true, owned: false };
        const owned = commandLine.toLowerCase().includes(state.caddyfilePath.toLowerCase()) &&
            commandLine.toLowerCase().includes('caddy');
        return { running: true, owned, commandLine };
    }
    async function stopState(state) {
        const processState = await stateProcess(state);
        if (!processState.running)
            return false;
        if (!processState.owned) {
            throw new Error(`process ${state.pid} no longer belongs to this HTTPS runtime`);
        }
        process.kill(state.pid);
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
            if (!(await stateProcess(state)).running)
                return true;
            await (0, common_1.sleepAsync)(100);
        }
        throw new Error(`Caddy process ${state.pid} did not stop within ten seconds`);
    }
    async function startCaddy(projectRoot, configPath, caddyPath, caddyfilePath, config, configHash) {
        const projectPaths = paths(projectRoot, configPath);
        const [out, err] = await Promise.all([
            (0, promises_1.open)(projectPaths.caddyOutPath, 'a'),
            (0, promises_1.open)(projectPaths.caddyErrPath, 'a'),
        ]);
        let child;
        try {
            child = (0, node_child_process_1.spawn)(caddyPath, [
                'run', '--config', caddyfilePath, '--adapter', 'caddyfile',
            ], {
                cwd: projectRoot,
                env,
                detached: true,
                windowsHide: true,
                stdio: ['ignore', out.fd, err.fd],
            });
            await new Promise(function waitForSpawn(resolve, reject) {
                child.once('spawn', function caddySpawned() { resolve(); });
                child.once('error', function caddySpawnError(error) { reject(error); });
            });
        }
        finally {
            await Promise.all([out.close(), err.close()]);
        }
        child.unref();
        if (!child.pid)
            throw new Error('Caddy did not return a process id');
        const state = {
            version: 1,
            pid: child.pid,
            projectRoot: node_path_1.default.resolve(projectRoot),
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
        };
        await saveState(state);
        return state;
    }
    async function waitCertificate(config, state) {
        const deadline = Date.now() + config.certificateWaitSeconds * 1000;
        let lastError;
        while (Date.now() < deadline) {
            const processState = await stateProcess(state);
            if (!processState.running || !processState.owned) {
                throw new Error(`Caddy exited while obtaining the certificate; inspect ${paths(state.projectRoot, state.configPath).caddyErrPath}`);
            }
            try {
                return await inspectCertificate(config);
            }
            catch (error) {
                lastError = error;
            }
            await (0, common_1.sleepAsync)(1000);
        }
        throw new Error(`certificate was not ready after ${config.certificateWaitSeconds} seconds: ${lastError?.message || 'unknown TLS error'}`);
    }
    async function inspectBackend(config) {
        const address = backendAddress(config.backend);
        await connectPort(address.host, address.port);
        return address;
    }
    async function resolveIdentity(config) {
        if (config.rawIp)
            return [config.identity];
        return (await node_dns_1.promises.lookup(config.identity, { all: true })).map(item => item.address);
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
    };
}
