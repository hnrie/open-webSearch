import {
    decryptBytes,
    deriveSessionKey,
    encryptBytes,
    generateE2EKeyMaterial,
    parseEncryptedEnvelope
} from '../adapters/http/e2eEncryption.js';
import {
    buildEncryptedRequestInit,
    createE2EClientSession,
    parseEncryptedResponse
} from '../adapters/http/e2eClient.js';

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

async function main(): Promise<void> {
    const serverKeys = generateE2EKeyMaterial();
    const clientKeys = generateE2EKeyMaterial();
    const sessionKey = deriveSessionKey(serverKeys.privateKey, clientKeys.publicKeyBase64);
    const clientSessionKey = deriveSessionKey(clientKeys.privateKey, serverKeys.publicKeyBase64);
    assert(sessionKey.equals(clientSessionKey), 'ECDH session keys should match');

    const plaintext = Buffer.from('{"query":"hello"}', 'utf8');
    const encrypted = encryptBytes(sessionKey, plaintext);
    const decrypted = decryptBytes(clientSessionKey, encrypted);
    assert(decrypted.toString('utf8') === plaintext.toString('utf8'), 'roundtrip encryption should preserve payload');

    const envelope = parseEncryptedEnvelope({
        v: 1,
        alg: 'X25519-AES-256-GCM',
        payload: encrypted
    });
    assert(envelope.payload === encrypted, 'envelope parser should preserve payload');

    const session = createE2EClientSession(serverKeys.publicKeyBase64, clientKeys);
    const init = buildEncryptedRequestInit(session, 'POST', { query: 'encrypted' });
    assert(typeof init.body === 'string', 'encrypted request should include a body');

    const fakeResponse = new Response(JSON.stringify({
        v: 1,
        alg: 'X25519-AES-256-GCM',
        payload: encryptBytes(session.sessionKey, Buffer.from('{"status":"ok"}', 'utf8'))
    }), {
        headers: {
            'Content-Type': 'application/open-websearch+e2e',
            'X-E2E-Encrypted': '1'
        }
    });

    const parsed = await parseEncryptedResponse<{ status: string }>(session, fakeResponse);
    assert(parsed.status === 'ok', 'encrypted response parser should decrypt JSON');

    console.log('test-e2e-encryption: all tests passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
