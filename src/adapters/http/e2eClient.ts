import crypto from 'node:crypto';
import {
    createEncryptedEnvelope,
    decryptBytes,
    deriveSessionKey,
    E2E_ALGORITHM,
    E2E_CLIENT_PUBLIC_KEY_HEADER,
    E2E_CONTENT_TYPE,
    E2E_ENCRYPTED_HEADER,
    E2E_WELL_KNOWN_PATH,
    encryptBytes,
    exportPublicKeyBase64,
    generateE2EKeyMaterial,
    parseEncryptedEnvelope,
    type E2EKeyMaterial
} from './e2eEncryption.js';

export type E2EClientSession = {
    clientKeys: E2EKeyMaterial;
    serverPublicKey: string;
    sessionKey: Buffer;
};

export async function fetchServerPublicKey(baseUrl: string): Promise<{ serverPublicKey: string; keyId: string }> {
    const response = await fetch(new URL(E2E_WELL_KNOWN_PATH, baseUrl));
    if (!response.ok) {
        throw new Error(`Failed to fetch E2E public key: HTTP ${response.status}`);
    }

    const body = await response.json() as {
        status?: string;
        data?: { serverPublicKey?: string; keyId?: string };
        serverPublicKey?: string;
        keyId?: string;
    };

    const payload = body.data ?? body;
    if (!payload.serverPublicKey) {
        throw new Error('Server E2E public key is missing from well-known response');
    }

    return {
        serverPublicKey: payload.serverPublicKey,
        keyId: payload.keyId || ''
    };
}

export function createE2EClientSession(serverPublicKey: string, clientKeys: E2EKeyMaterial = generateE2EKeyMaterial()): E2EClientSession {
    return {
        clientKeys,
        serverPublicKey,
        sessionKey: deriveSessionKey(clientKeys.privateKey, serverPublicKey)
    };
}

export function buildEncryptedRequestInit(
    session: E2EClientSession,
    method: string,
    plaintextBody?: unknown
): RequestInit {
    const headers: Record<string, string> = {
        [E2E_CLIENT_PUBLIC_KEY_HEADER]: session.clientKeys.publicKeyBase64,
        [E2E_ENCRYPTED_HEADER]: '1'
    };

    if (plaintextBody === undefined) {
        return { method, headers };
    }

    const plaintext = Buffer.from(JSON.stringify(plaintextBody), 'utf8');
    const payload = encryptBytes(session.sessionKey, plaintext);
    headers['Content-Type'] = E2E_CONTENT_TYPE;

    return {
        method,
        headers,
        body: JSON.stringify(createEncryptedEnvelope(payload))
    };
}

export async function parseEncryptedResponse<T>(session: E2EClientSession, response: Response): Promise<T> {
    const contentType = response.headers.get('content-type') || '';
    const raw = await response.text();

    if (!contentType.includes(E2E_CONTENT_TYPE) && !response.headers.get(E2E_ENCRYPTED_HEADER)) {
        return JSON.parse(raw) as T;
    }

    const envelope = parseEncryptedEnvelope(JSON.parse(raw));
    if (envelope.alg !== E2E_ALGORITHM) {
        throw new Error(`Unexpected E2E algorithm: ${envelope.alg}`);
    }

    const decrypted = decryptBytes(session.sessionKey, envelope.payload);
    return JSON.parse(decrypted.toString('utf8')) as T;
}

export async function e2eJsonRequest<T>(
    baseUrl: string,
    path: string,
    options: {
        method?: string;
        body?: unknown;
        session?: E2EClientSession;
    } = {}
): Promise<T> {
    const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
    let session = options.session;

    if (!session) {
        const { serverPublicKey } = await fetchServerPublicKey(baseUrl);
        session = createE2EClientSession(serverPublicKey);
    }

    const response = await fetch(new URL(path, baseUrl), buildEncryptedRequestInit(session, method, options.body));
    const parsed = await parseEncryptedResponse<T>(session, response);

    if (!response.ok) {
        throw new Error(`E2E request failed with HTTP ${response.status}: ${JSON.stringify(parsed)}`);
    }

    return parsed;
}

export function createEphemeralClientKeypair(): { publicKeyBase64: string; privateKeyBase64: string } {
    const keys = generateE2EKeyMaterial();
    return {
        publicKeyBase64: keys.publicKeyBase64,
        privateKeyBase64: keys.privateKeyBase64
    };
}

export function exportEphemeralPublicKey(privateKeyBase64: string): string {
    const privateKey = crypto.createPrivateKey({
        key: Buffer.from(privateKeyBase64, 'base64'),
        type: 'pkcs8',
        format: 'der'
    });
    return exportPublicKeyBase64(crypto.createPublicKey(privateKey));
}
