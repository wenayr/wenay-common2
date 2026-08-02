"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createModuleWorkerIsolation = createModuleWorkerIsolation;
const module_verifier_1 = require("../../Common/dynamic/module-verifier");
const module_worker_1 = require("./module-worker");
function decodeVerifiedSource(artifact) {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(artifact.resource.bytes());
}
function compareVersions(a, b) {
    for (let index = 0; index < 3; index++) {
        const difference = (a[index] ?? 0) - (b[index] ?? 0);
        if (difference)
            return difference;
    }
    return 0;
}
function runtimeRangeAllowsNode(range) {
    if (range == '*')
        return true;
    const match = /^(\^|>=|=)?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range);
    if (!match)
        return false;
    const required = [Number(match[2]), Number(match[3] ?? 0), Number(match[4] ?? 0)];
    const current = process.versions.node.split('.').slice(0, 3).map(Number);
    if (match[1] == '>=')
        return compareVersions(current, required) >= 0;
    if (match[1] == '^')
        return current[0] == required[0] && compareVersions(current, required) >= 0;
    if (match[3] == undefined)
        return current[0] == required[0];
    return compareVersions(current, required) == 0;
}
function assertSupportedManifest(artifact) {
    const manifest = artifact.manifest;
    const runtime = manifest.compatibility.runtime;
    if (runtime?.name != 'node' || !runtimeRangeAllowsNode(runtime.range)) {
        throw new Error('module worker isolation: artifact runtime is not compatible with this Node host');
    }
    if (manifest.entrypoint != './index.js') {
        throw new Error('module worker isolation: only the verified bundled ./index.js entrypoint is supported');
    }
    if (manifest.budget.cpuMs != undefined) {
        throw new Error('module worker isolation: cpuMs requires process or container isolation');
    }
    if ((manifest.permissions.network?.length ?? 0)
        || (manifest.permissions.storage?.length ?? 0)
        || (manifest.permissions.secrets?.length ?? 0)) {
        throw new Error('module worker isolation: declared ambient permissions require a capability-enforcing isolator');
    }
    if (manifest.budget.memoryMb != undefined
        && (manifest.budget.memoryMb < 16 || manifest.budget.memoryMb > 4_096)) {
        throw new Error('module worker isolation: memoryMb must be between 16 and 4096');
    }
}
function createModuleWorkerIsolation(deps = {}) {
    function open(input) {
        const { artifact, candidateId, candidateGeneration } = input;
        (0, module_verifier_1.assertVerifiedModuleArtifact)(artifact);
        assertSupportedManifest(artifact);
        const manifest = artifact.manifest;
        const maximumCallTimeout = Math.max(manifest.budget.callTimeoutMs, manifest.budget.warmupTimeoutMs, manifest.health.timeoutMs);
        const workerDeps = {
            verified: {
                verification: module_worker_1.MODULE_WORKER_VERIFIED_SOURCE,
                moduleId: manifest.moduleId,
                version: manifest.version,
                contentHash: manifest.contentHash,
                source: decodeVerifiedSource(artifact),
            },
            candidateId,
            bindingGeneration: candidateGeneration,
            startupTimeoutMs: Math.min(deps.startupTimeoutMs ?? manifest.budget.warmupTimeoutMs, manifest.budget.warmupTimeoutMs),
            heartbeatIntervalMs: deps.heartbeatIntervalMs,
            heartbeatTimeoutMs: deps.heartbeatTimeoutMs,
            defaultCallTimeoutMs: manifest.budget.callTimeoutMs,
            maxCallTimeoutMs: maximumCallTimeout,
            maxConcurrentCalls: manifest.budget.concurrency,
            maxSourceBytes: manifest.integrity.size,
            maxInputBytes: deps.maxInputBytes,
            maxOutputBytes: deps.maxOutputBytes,
            memoryMb: manifest.budget.memoryMb,
            allowedDependencies: manifest.dependencies,
            dependencyCall: deps.dependencyCall,
            mcpPolicy: deps.resolveMcpPolicy?.(artifact),
        };
        return (0, module_worker_1.createModuleWorkerSession)(workerDeps);
    }
    return {
        resource: {
            open,
        },
    };
}
