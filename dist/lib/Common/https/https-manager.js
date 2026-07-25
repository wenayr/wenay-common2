"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createNodeHttpsManager = createNodeHttpsManager;
const https_config_1 = require("./https-config");
const https_node_resource_1 = require("./https-node-resource");
function createHttpsManager(deps) {
    const projectRoot = deps.projectRoot;
    const configPath = deps.configPath;
    const log = deps.onLog || (() => undefined);
    const resource = deps.resource;
    async function config(overrides = {}) {
        const stored = await resource.project.loadConfig(projectRoot, configPath);
        const input = {
            ...(stored || {}),
            ...overrides,
        };
        return (0, https_config_1.normalizeHttpsConfig)(input);
    }
    async function status() {
        const state = await resource.project.state.load(projectRoot, configPath);
        const processState = await resource.caddy.process.state(state);
        let certificate;
        let certificateError;
        if (state && processState.running && processState.owned) {
            try {
                const currentConfig = (0, https_config_1.normalizeHttpsConfig)({
                    identity: state.identity,
                    backend: state.backend,
                    publicPort: state.publicPort,
                    challengePort: state.challengePort,
                    bind: state.bind,
                });
                certificate = await resource.caddy.certificate.inspect(currentConfig);
            }
            catch (error) {
                certificateError = error.message;
            }
        }
        return {
            configured: !!state,
            running: processState.running,
            owned: processState.owned,
            pid: state?.pid,
            identity: state?.identity,
            publicUrl: state ? (0, https_config_1.httpsPublicUrl)(state) : undefined,
            backend: state?.backend,
            startedAt: state?.startedAt,
            certificate,
            certificateError,
            caddyErrorLog: state
                ? resource.project.paths(projectRoot, state.configPath).caddyErrPath
                : resource.project.paths(projectRoot, configPath).caddyErrPath,
        };
    }
    async function stopOperation() {
        const state = await resource.project.state.load(projectRoot, configPath);
        if (!state) {
            return { stopped: false, reason: 'not configured' };
        }
        const stopped = await resource.caddy.process.stop(state);
        await resource.project.state.remove(projectRoot, configPath);
        return {
            stopped,
            reason: stopped ? 'stopped' : 'already stopped',
        };
    }
    function stop() {
        return resource.project.withLock(projectRoot, configPath, stopOperation);
    }
    async function ensureOperation(overrides) {
        const currentConfig = await config(overrides);
        await resource.network.inspectBackend(currentConfig);
        const caddyPath = await resource.caddy.executable.ensure(currentConfig.caddyPath);
        const caddyfile = (0, https_config_1.createCaddyfile)(currentConfig, resource.caddy.storageDir);
        const configHash = resource.caddy.config.hash(caddyfile);
        const existing = await resource.project.state.load(projectRoot, configPath);
        const processState = await resource.caddy.process.state(existing);
        if (existing && processState.running && !processState.owned) {
            throw new Error(`process ${existing.pid} no longer belongs to this HTTPS runtime`);
        }
        if (existing && processState.running && existing.configHash == configHash &&
            existing.caddyPath == caddyPath) {
            log(`Caddy is already running for ${currentConfig.identity}; checking the certificate...`);
            const certificate = await resource.caddy.certificate.wait(currentConfig, existing);
            return {
                changed: false,
                running: true,
                publicUrl: (0, https_config_1.httpsPublicUrl)(currentConfig),
                pid: existing.pid,
                certificate,
            };
        }
        if (existing && processState.running) {
            log('HTTPS configuration changed; stopping the previous owned Caddy process...');
            await resource.caddy.process.stop(existing);
        }
        if (existing)
            await resource.project.state.remove(projectRoot, configPath);
        const caddyfilePath = await resource.caddy.config.write(projectRoot, configPath, caddyfile);
        await resource.caddy.config.validate(caddyPath, caddyfilePath, projectRoot);
        log(`Starting Caddy for ${currentConfig.identity}...`);
        const state = await resource.caddy.process.start(projectRoot, configPath, caddyPath, caddyfilePath, currentConfig, configHash);
        try {
            const certificate = await resource.caddy.certificate.wait(currentConfig, state);
            return {
                changed: true,
                running: true,
                publicUrl: (0, https_config_1.httpsPublicUrl)(currentConfig),
                pid: state.pid,
                certificate,
            };
        }
        catch (error) {
            await resource.caddy.process.stop(state).catch(() => undefined);
            await resource.project.state.remove(projectRoot, configPath);
            throw error;
        }
    }
    function ensure(overrides = {}) {
        return resource.project.withLock(projectRoot, configPath, function ensureExclusive() {
            return ensureOperation(overrides);
        });
    }
    async function doctor(overrides = {}) {
        const checks = [];
        let currentConfig;
        try {
            currentConfig = await config(overrides);
            checks.push({ name: 'config', ok: true, details: 'configuration is valid' });
        }
        catch (error) {
            checks.push({ name: 'config', ok: false, details: error.message });
            return { ok: false, checks };
        }
        const caddyPath = await resource.caddy.executable.find(currentConfig.caddyPath);
        checks.push({
            name: 'caddy',
            ok: !!caddyPath,
            details: caddyPath || `Caddy ${resource.caddy.version} will be downloaded by ensure`,
        });
        try {
            const backend = await resource.network.inspectBackend(currentConfig);
            checks.push({
                name: 'backend',
                ok: true,
                details: `${backend.host}:${backend.port} is reachable`,
            });
        }
        catch (error) {
            checks.push({ name: 'backend', ok: false, details: error.message });
        }
        try {
            const addresses = await resource.network.resolveIdentity(currentConfig);
            checks.push({
                name: 'identity',
                ok: true,
                details: addresses.join(', '),
            });
        }
        catch (error) {
            checks.push({ name: 'identity', ok: false, details: error.message });
        }
        const currentStatus = await status();
        checks.push({
            name: 'runtime',
            ok: !currentStatus.configured || currentStatus.running && currentStatus.owned,
            details: currentStatus.running
                ? `owned Caddy process ${currentStatus.pid} is running`
                : 'Caddy is not running',
        });
        return {
            ok: checks.every(check => check.ok),
            checks,
        };
    }
    return {
        ensure,
        status,
        doctor,
        stop,
    };
}
function createNodeHttpsManager(deps) {
    const resource = (0, https_node_resource_1.createNodeHttpsResource)({
        onLog: deps.onLog,
    });
    return createHttpsManager({
        ...deps,
        resource,
    });
}
