import crypto from 'node:crypto';

export const E2E_ALGORITHM = 'X25519-AES-256-GCM' as const;
export const E2E_HKDF_INFO = 'open-websearch-e2e-v1';
export const E2E_CONTENT_TYPE = 'application/open-websearch+e2e';
export const E2E_CLIENT_PUBLIC_KEY_HEADER = 'x-e2e-client-public-key';
export const E2E_ENCRYPTED_HEADER = 'x-e2e-encrypted';
export const E2E_WELL_KNOWN_PATH = '/.well-known/open-websearch-e2e';

export type E2EKeyMaterial = {
    publicKey: crypto.KeyObject;
    privateKey: crypto.KeyObject;
    publicKeyBase64: string;
    privateKeyBase64: string;
    keyId: string;
};

export type E2EEncryptedEnvelope = {
    v: 1;
    alg: typeof E2E_ALGORITHM;
    payload: string;
};

export type E2ESecurityOptions = {
    requireE2E: boolean;
    serverKeys?: E2EKeyMaterial;
};

export function exportPublicKeyBase64(publicKey: crypto.KeyObject): string {
    return publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
}

export function exportPrivateKeyBase64(privateKey: crypto.KeyObject): string {
    return privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
}

export function importPublicKeyBase64(publicKeyBase64: string): crypto.KeyObject {
    return crypto.createPublicKey({
        key: Buffer.from(publicKeyBase64, 'base64'),
        type: 'spki',
        format: 'der'
    });
}

export function importPrivateKeyBase64(privateKeyBase64: string): crypto.KeyObject {
    return crypto.createPrivateKey({
        key: Buffer.from(privateKeyBase64, 'base64'),
        type: 'pkcs8',
        format: 'der'
    });
}

export function computeKeyId(publicKeyBase64: string): string {
    return crypto
        .createHash('sha256')
        .update(Buffer.from(publicKeyBase64, 'base64'))
        .digest('base64url')
        .slice(0, 22);
}

export function generateE2EKeyMaterial(): E2EKeyMaterial {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
    const publicKeyBase64 = exportPublicKeyBase64(publicKey);
    return {
        publicKey,
        privateKey,
        publicKeyBase64,
        privateKeyBase64: exportPrivateKeyBase64(privateKey),
        keyId: computeKeyId(publicKeyBase64)
    };
}

export function loadE2EKeyMaterialFromPrivateKey(privateKeyBase64: string): E2EKeyMaterial {
    const privateKey = importPrivateKeyBase64(privateKeyBase64);
    const publicKey = crypto.createPublicKey(privateKey);
    const publicKeyBase64 = exportPublicKeyBase64(publicKey);
    return {
        publicKey,
        privateKey,
        publicKeyBase64,
        privateKeyBase64,
        keyId: computeKeyId(publicKeyBase64)
    };
}

export function deriveSessionKey(
    localPrivateKey: crypto.KeyObject,
    peerPublicKeyBase64: string
): Buffer {
    const peerPublicKey = importPublicKeyBase64(peerPublicKeyBase64);
    const sharedSecret = crypto.diffieHellman({
        privateKey: localPrivateKey,
        publicKey: peerPublicKey
    });
    return Buffer.from(crypto.hkdfSync('sha256', sharedSecret, Buffer.alloc(0), E2E_HKDF_INFO, 32));
}

export function encryptBytes(sessionKey: Buffer, plaintext: Uint8Array): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', sessionKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptBytes(sessionKey: Buffer, payloadBase64: string): Buffer {
    const data = Buffer.from(payloadBase64, 'base64');
    if (data.length < 28) {
        throw new Error('Encrypted payload is too short');
    }

    const iv = data.subarray(0, 12);
    const tag = data.subarray(12, 28);
    const ciphertext = data.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', sessionKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function createEncryptedEnvelope(payloadBase64: string): E2EEncryptedEnvelope {
    return {
        v: 1,
        alg: E2E_ALGORITHM,
        payload: payloadBase64
    };
}

export function parseEncryptedEnvelope(body: unknown): E2EEncryptedEnvelope {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new Error('Encrypted body must be a JSON object');
    }

    const envelope = body as Partial<E2EEncryptedEnvelope>;
    if (envelope.v !== 1 || envelope.alg !== E2E_ALGORITHM || typeof envelope.payload !== 'string' || !envelope.payload) {
        throw new Error('Invalid encrypted envelope');
    }

    return {
        v: 1,
        alg: E2E_ALGORITHM,
        payload: envelope.payload
    };
}

export function isEncryptedRequest(headers: Headers): boolean {
    return headers.get(E2E_ENCRYPTED_HEADER) === '1'
        || (headers.get('content-type') || '').includes(E2E_CONTENT_TYPE);
}

export function getClientPublicKeyHeader(headers: Headers): string | undefined {
    const value = headers.get(E2E_CLIENT_PUBLIC_KEY_HEADER)?.trim();
    return value || undefined;
}

export function readE2ESecurityOptionsFromEnv(): E2ESecurityOptions {
    const deploymentMode = process.env.DEPLOYMENT_MODE?.trim().toLowerCase();
    const isServerless = deploymentMode === 'serverless';
    const requireE2E = process.env.REQUIRE_E2E_ENCRYPTION === 'true'
        || (isServerless && process.env.REQUIRE_E2E_ENCRYPTION !== 'false');
    const privateKeyBase64 = process.env.OPEN_WEBSEARCH_E2E_PRIVATE_KEY?.trim()
        || process.env.E2E_PRIVATE_KEY?.trim();

    if (!privateKeyBase64) {
        return { requireE2E, serverKeys: undefined };
    }

    return {
        requireE2E,
        serverKeys: loadE2EKeyMaterialFromPrivateKey(privateKeyBase64)
    };
}

export function createWellKnownPayload(serverKeys: E2EKeyMaterial) {
    return {
        algorithm: E2E_ALGORITHM,
        version: 1,
        serverPublicKey: serverKeys.publicKeyBase64,
        keyId: serverKeys.keyId,
        headers: {
            clientPublicKey: E2E_CLIENT_PUBLIC_KEY_HEADER,
            encrypted: E2E_ENCRYPTED_HEADER,
            contentType: E2E_CONTENT_TYPE
        }
    };
}
