// =====================================================================
// Контент-адресация артефактов: sha256 как версия (descriptor.version)
// =====================================================================
// Версия артефакта = hash его байтов: подмена содержимого по дороге между
// узлами обнаруживается одной проверкой, без PKI и подписей. Работает и в
// Node (>=18), и в браузере — через WebCrypto (globalThis.crypto.subtle).

const encoder = new TextEncoder()

export function artifactBytesOf(data: string | Uint8Array) {
    return typeof data == 'string' ? encoder.encode(data) : data
}

/** Hex sha256 от строки или байтов — каноничный content-hash артефакта. */
export async function sha256Hex(data: string | Uint8Array) {
    const bytes = artifactBytesOf(data)
    // Типы WebCrypto в Node сужают вход до BufferSource из DOM-lib; Uint8Array валиден в рантайме везде
    const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
    let out = ''
    for (const byte of new Uint8Array(digest)) out += byte.toString(16).padStart(2, '0')
    return out
}
