"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertVerifiedModuleArtifact = assertVerifiedModuleArtifact;
exports.createModuleArtifactVerifier = createModuleArtifactVerifier;
const artifact_hash_1 = require("../artifact/artifact-hash");
const module_manifest_1 = require("./module-manifest");
const verifiedArtifacts = new WeakSet();
function fail(message) {
    throw new Error('dynamic module verifier: ' + message);
}
function ownedBytes(bytes) {
    const source = (0, artifact_hash_1.artifactBytesOf)(bytes);
    const owned = new Uint8Array(source.byteLength);
    owned.set(source);
    return owned;
}
function fixedHexEqual(a, b) {
    if (a.length != b.length)
        return false;
    let difference = 0;
    for (let index = 0; index < a.length; index++) {
        difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
    }
    return difference == 0;
}
function decisionReason(value, fallback) {
    if ((typeof value == 'boolean' && value) || (typeof value == 'object' && value != null && value.accepted)) {
        return null;
    }
    if (typeof value == 'object' && value != null && value.reason?.trim())
        return value.reason.trim();
    return fallback;
}
function requireAllowlist(values, allowed, label) {
    const allowlist = new Set(allowed ?? []);
    const denied = values.find(value => !allowlist.has(value));
    if (denied != undefined)
        fail(label + ' is not allowed: ' + denied);
}
function verifyPolicyAllowlist(manifest, policy) {
    requireAllowlist(manifest.capabilities, policy.capabilities, 'capability');
    requireAllowlist(manifest.permissions.network ?? [], policy.permissions?.network, 'network permission');
    requireAllowlist(manifest.permissions.storage ?? [], policy.permissions?.storage, 'storage permission');
    requireAllowlist(manifest.permissions.secrets ?? [], policy.permissions?.secrets, 'secret permission');
}
function createVerifiedModuleArtifact(input) {
    const { manifest, manifestHash, verifiedAt } = input;
    const bytes = ownedBytes(input.bytes);
    const descriptor = Object.freeze({
        moduleId: manifest.moduleId,
        version: manifest.version,
        contentHash: manifest.contentHash,
        manifestHash: 'sha256:' + manifestHash,
        apiContractId: manifest.compatibility.api.contractId,
        apiVersion: manifest.compatibility.api.version,
        ...(manifest.compatibility.state == undefined
            ? {}
            : { stateVersion: manifest.compatibility.state.version }),
        publisherKeyId: manifest.signature.keyId,
        verifiedAt,
    });
    const artifact = Object.freeze({
        manifest,
        descriptor,
        resource: Object.freeze({
            bytes() {
                return ownedBytes(bytes);
            },
        }),
    });
    verifiedArtifacts.add(artifact);
    return artifact;
}
function assertVerifiedModuleArtifact(value) {
    if (typeof value != 'object' || value == null || !verifiedArtifacts.has(value)) {
        fail('artifact provenance is not owned by this verifier');
    }
}
function createModuleArtifactVerifier(deps) {
    const now = deps.now ?? Date.now;
    const verifySignature = deps.verifySignature;
    const manifestLimits = { ...deps.manifestLimits };
    const policy = {
        publisherKeyIds: [...deps.policy.publisherKeyIds],
        capabilities: [...(deps.policy.capabilities ?? [])],
        permissions: {
            network: [...(deps.policy.permissions?.network ?? [])],
            storage: [...(deps.policy.permissions?.storage ?? [])],
            secrets: [...(deps.policy.permissions?.secrets ?? [])],
        },
        accept: deps.policy.accept,
    };
    const publisherKeyIds = new Set(policy.publisherKeyIds);
    async function verify(input) {
        const manifest = (0, module_manifest_1.parseModuleManifest)(input.manifest, manifestLimits);
        const bytes = ownedBytes(input.bytes);
        if (bytes.byteLength != manifest.integrity.size)
            fail('artifact size does not match integrity.size');
        const actualHash = await (0, artifact_hash_1.sha256Hex)(bytes);
        if (!fixedHexEqual(actualHash, manifest.integrity.digest)) {
            fail('artifact bytes do not match contentHash');
        }
        if (!publisherKeyIds.has(manifest.signature.keyId)) {
            fail('publisher key is not allowlisted: ' + manifest.signature.keyId);
        }
        const signaturePayload = (0, module_manifest_1.moduleManifestSignaturePayload)(manifest);
        const signatureDecision = await verifySignature({
            algorithm: manifest.signature.algorithm,
            keyId: manifest.signature.keyId,
            signature: manifest.signature.value,
            payload: ownedBytes(signaturePayload),
        });
        const signatureReason = decisionReason(signatureDecision, 'signature was rejected');
        if (signatureReason)
            fail(signatureReason);
        verifyPolicyAllowlist(manifest, policy);
        const manifestHash = await (0, artifact_hash_1.sha256Hex)((0, module_manifest_1.canonicalModuleManifest)(manifest));
        if (policy.accept) {
            const policyDecision = await policy.accept({
                manifest,
                contentHash: manifest.contentHash,
                manifestHash: 'sha256:' + manifestHash,
            });
            const policyReason = decisionReason(policyDecision, 'artifact was rejected by policy');
            if (policyReason)
                fail(policyReason);
        }
        return createVerifiedModuleArtifact({
            manifest,
            bytes,
            manifestHash,
            verifiedAt: now(),
        });
    }
    return {
        control: {
            verify,
        },
    };
}
