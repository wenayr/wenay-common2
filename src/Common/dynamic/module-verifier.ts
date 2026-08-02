// =====================================================================
// Dynamic module verifier — integrity, publisher signature and host policy
// =====================================================================

import {artifactBytesOf, sha256Hex} from '../artifact/artifact-hash'
import {
    canonicalModuleManifest,
    ModuleManifest,
    ModuleManifestValidationLimits,
    moduleManifestSignaturePayload,
    parseModuleManifest,
    tSerializedModuleManifest,
} from './module-manifest'

export type ModulePolicyDecision = {
    accepted: boolean
    reason?: string
}

export type ModuleVerificationPolicy = {
    publisherKeyIds: readonly string[]
    capabilities?: readonly string[]
    permissions?: {
        network?: readonly string[]
        storage?: readonly string[]
        secrets?: readonly string[]
    }
    accept?: (input: {
        manifest: ModuleManifest
        contentHash: string
        manifestHash: string
    }) => ModulePolicyDecision | Promise<ModulePolicyDecision>
}

export type ModuleSignatureVerifier = (input: {
    algorithm: string
    keyId: string
    signature: string
    payload: Uint8Array
}) => boolean | ModulePolicyDecision | Promise<boolean | ModulePolicyDecision>

export type ModuleArtifactVerifierDeps = {
    verifySignature: ModuleSignatureVerifier
    policy: ModuleVerificationPolicy
    manifestLimits?: ModuleManifestValidationLimits
    now?: () => number
}

export type tModuleArtifactBytes = string | Uint8Array
const verifiedArtifacts = new WeakSet<object>()

function fail(message: string): never {
    throw new Error('dynamic module verifier: ' + message)
}

function ownedBytes(bytes: tModuleArtifactBytes) {
    const source = artifactBytesOf(bytes)
    const owned = new Uint8Array(source.byteLength)
    owned.set(source)
    return owned
}

function fixedHexEqual(a: string, b: string) {
    if (a.length != b.length) return false
    let difference = 0
    for (let index = 0; index < a.length; index++) {
        difference |= a.charCodeAt(index) ^ b.charCodeAt(index)
    }
    return difference == 0
}

function decisionReason(value: boolean | ModulePolicyDecision, fallback: string) {
    if ((typeof value == 'boolean' && value) || (typeof value == 'object' && value != null && value.accepted)) {
        return null
    }
    if (typeof value == 'object' && value != null && value.reason?.trim()) return value.reason.trim()
    return fallback
}

function requireAllowlist(values: readonly string[], allowed: readonly string[] | undefined, label: string) {
    const allowlist = new Set(allowed ?? [])
    const denied = values.find(value => !allowlist.has(value))
    if (denied != undefined) fail(label + ' is not allowed: ' + denied)
}

function verifyPolicyAllowlist(manifest: ModuleManifest, policy: ModuleVerificationPolicy) {
    requireAllowlist(manifest.capabilities, policy.capabilities, 'capability')
    requireAllowlist(manifest.permissions.network ?? [], policy.permissions?.network, 'network permission')
    requireAllowlist(manifest.permissions.storage ?? [], policy.permissions?.storage, 'storage permission')
    requireAllowlist(manifest.permissions.secrets ?? [], policy.permissions?.secrets, 'secret permission')
}

function createVerifiedModuleArtifact(input: {
    manifest: ModuleManifest
    bytes: Uint8Array
    manifestHash: string
    verifiedAt: number
}) {
    const {manifest, manifestHash, verifiedAt} = input
    const bytes = ownedBytes(input.bytes)
    const descriptor = Object.freeze({
        moduleId: manifest.moduleId,
        version: manifest.version,
        contentHash: manifest.contentHash,
        manifestHash: 'sha256:' + manifestHash,
        apiContractId: manifest.compatibility.api.contractId,
        apiVersion: manifest.compatibility.api.version,
        ...(manifest.compatibility.state == undefined
            ? {}
            : {stateVersion: manifest.compatibility.state.version}),
        publisherKeyId: manifest.signature.keyId,
        verifiedAt,
    })
    const artifact = Object.freeze({
        manifest,
        descriptor,
        resource: Object.freeze({
            bytes() {
                return ownedBytes(bytes)
            },
        }),
    })
    verifiedArtifacts.add(artifact)
    return artifact
}

export type VerifiedModuleArtifact = ReturnType<typeof createVerifiedModuleArtifact>

export function assertVerifiedModuleArtifact(value: unknown): asserts value is VerifiedModuleArtifact {
    if (typeof value != 'object' || value == null || !verifiedArtifacts.has(value)) {
        fail('artifact provenance is not owned by this verifier')
    }
}

export function createModuleArtifactVerifier(deps: ModuleArtifactVerifierDeps) {
    const now = deps.now ?? Date.now
    const verifySignature = deps.verifySignature
    const manifestLimits = {...deps.manifestLimits}
    const policy = {
        publisherKeyIds: [...deps.policy.publisherKeyIds],
        capabilities: [...(deps.policy.capabilities ?? [])],
        permissions: {
            network: [...(deps.policy.permissions?.network ?? [])],
            storage: [...(deps.policy.permissions?.storage ?? [])],
            secrets: [...(deps.policy.permissions?.secrets ?? [])],
        },
        accept: deps.policy.accept,
    }
    const publisherKeyIds = new Set(policy.publisherKeyIds)

    async function verify(input: {manifest: tSerializedModuleManifest, bytes: tModuleArtifactBytes}) {
        const manifest = parseModuleManifest(input.manifest, manifestLimits)
        const bytes = ownedBytes(input.bytes)
        if (bytes.byteLength != manifest.integrity.size) fail('artifact size does not match integrity.size')
        const actualHash = await sha256Hex(bytes)
        if (!fixedHexEqual(actualHash, manifest.integrity.digest)) {
            fail('artifact bytes do not match contentHash')
        }
        if (!publisherKeyIds.has(manifest.signature.keyId)) {
            fail('publisher key is not allowlisted: ' + manifest.signature.keyId)
        }
        const signaturePayload = moduleManifestSignaturePayload(manifest)
        const signatureDecision = await verifySignature({
            algorithm: manifest.signature.algorithm,
            keyId: manifest.signature.keyId,
            signature: manifest.signature.value,
            payload: ownedBytes(signaturePayload),
        })
        const signatureReason = decisionReason(signatureDecision, 'signature was rejected')
        if (signatureReason) fail(signatureReason)

        verifyPolicyAllowlist(manifest, policy)
        const manifestHash = await sha256Hex(canonicalModuleManifest(manifest))
        if (policy.accept) {
            const policyDecision = await policy.accept({
                manifest,
                contentHash: manifest.contentHash,
                manifestHash: 'sha256:' + manifestHash,
            })
            const policyReason = decisionReason(policyDecision, 'artifact was rejected by policy')
            if (policyReason) fail(policyReason)
        }
        return createVerifiedModuleArtifact({
            manifest,
            bytes,
            manifestHash,
            verifiedAt: now(),
        })
    }

    return {
        control: {
            verify,
        },
    }
}

export type ModuleArtifactVerifier = ReturnType<typeof createModuleArtifactVerifier>
