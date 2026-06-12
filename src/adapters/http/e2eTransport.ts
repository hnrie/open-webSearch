import { createErrorEnvelope } from '../../cli/protocol.js';
import {
    createEncryptedEnvelope,
    decryptBytes,
    deriveSessionKey,
    E2E_CONTENT_TYPE,
    E2E_ENCRYPTED_HEADER,
    encryptBytes,
    getClientPublicKeyHeader,
    isEncryptedRequest,
    parseEncryptedEnvelope,
    type E2EKeyMaterial
} from './e2eEncryption.js';

export type E2ESessionContext = {
    encrypted: boolean;
    clientPublicKey?: string;
    sessionKey?: Buffer;
};

export type E2ETransportFailure = {
    status: number;
    body: ReturnType<typeof createErrorEnvelope>;
};

export function createE2ETransportFailure(
    status: number,
    code: string,
    message: string,
    hint: string
): E2ETransportFailure {
    return {
        status,
        body: createErrorEnvelope(code, message, { hint })
    };
}

export async function openE2ESession(
    request: Request,
    serverKeys: E2EKeyMaterial | undefined,
    requireE2E: boolean
): Promise<E2ESessionContext | E2ETransportFailure> {
    const clientPublicKey = getClientPublicKeyHeader(request.headers);
    const encrypted = isEncryptedRequest(request.headers);

    if (!requireE2E) {
        if (!encrypted) {
            return { encrypted: false };
        }

        if (!serverKeys || !clientPublicKey) {
            return createE2ETransportFailure(
                400,
                'invalid_request',
                'Encrypted request is missing server keys or client public key',
                `Fetch ${'/'.concat('.well-known/open-websearch-e2e')} and send ${'x-e2e-client-public-key'} with encrypted payloads.`
            );
        }

        return {
            encrypted: true,
            clientPublicKey,
            sessionKey: deriveSessionKey(serverKeys.privateKey, clientPublicKey)
        };
    }

    if (!serverKeys) {
        return createE2ETransportFailure(
            503,
            'service_unavailable',
            'E2E encryption is required but OPEN_WEBSEARCH_E2E_PRIVATE_KEY is not configured',
            'Generate a keypair with `open-websearch e2e-keygen` and set OPEN_WEBSEARCH_E2E_PRIVATE_KEY in your deployment environment.'
        );
    }

    if (!clientPublicKey) {
        return createE2ETransportFailure(
            400,
            'encryption_required',
            'Missing client public key for end-to-end encryption',
            `Send header x-e2e-client-public-key with an ephemeral X25519 public key. Discover the server key at ${'/'.concat('.well-known/open-websearch-e2e')}.`
        );
    }

    if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'DELETE' && !encrypted) {
        return createE2ETransportFailure(
            400,
            'encryption_required',
            'Request body must be end-to-end encrypted',
            `Use Content-Type ${E2E_CONTENT_TYPE}, header ${E2E_ENCRYPTED_HEADER}: 1, and an encrypted JSON envelope.`
        );
    }

    return {
        encrypted: true,
        clientPublicKey,
        sessionKey: deriveSessionKey(serverKeys.privateKey, clientPublicKey)
    };
}

export async function decryptRequestBody(
    request: Request,
    session: E2ESessionContext
): Promise<Uint8Array | undefined> {
    if (!session.encrypted || !session.sessionKey) {
        return undefined;
    }

    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'DELETE') {
        return undefined;
    }

    const rawBody = await request.text();
    if (!rawBody.trim()) {
        return new Uint8Array();
    }

    const envelope = parseEncryptedEnvelope(JSON.parse(rawBody));
    return decryptBytes(session.sessionKey, envelope.payload);
}

export function rebuildRequest(request: Request, decryptedBody?: Uint8Array): Request {
    if (decryptedBody === undefined) {
        return request;
    }

    const headers = new Headers(request.headers);
    headers.delete('content-length');
    headers.set('content-type', 'application/json');

    return new Request(request.url, {
        method: request.method,
        headers,
        body: decryptedBody.length > 0 ? Buffer.from(decryptedBody) : undefined
    });
}

export async function encryptJsonResponse(
    session: E2ESessionContext,
    status: number,
    body: unknown
): Promise<Response> {
    if (!session.encrypted || !session.sessionKey) {
        return new Response(JSON.stringify(body), {
            status,
            headers: {
                'Content-Type': 'application/json; charset=utf-8'
            }
        });
    }

    const plaintext = Buffer.from(JSON.stringify(body), 'utf8');
    const payload = encryptBytes(session.sessionKey, plaintext);
    const envelope = createEncryptedEnvelope(payload);

    return new Response(JSON.stringify(envelope), {
        status,
        headers: {
            'Content-Type': E2E_CONTENT_TYPE,
            [E2E_ENCRYPTED_HEADER]: '1'
        }
    });
}

export async function encryptRawResponse(
    session: E2ESessionContext,
    response: Response
): Promise<Response> {
    if (!session.encrypted || !session.sessionKey) {
        return response;
    }

    const plaintext = new Uint8Array(await response.arrayBuffer());
    const payload = encryptBytes(session.sessionKey, plaintext);
    const envelope = createEncryptedEnvelope(payload);
    const headers = new Headers(response.headers);
    headers.set('Content-Type', E2E_CONTENT_TYPE);
    headers.set(E2E_ENCRYPTED_HEADER, '1');

    return new Response(JSON.stringify(envelope), {
        status: response.status,
        statusText: response.statusText,
        headers
    });
}
