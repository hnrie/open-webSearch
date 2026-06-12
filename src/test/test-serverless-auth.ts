import { authorizeRequest, extractApiKeyFromHeaders } from '../adapters/http/auth.js';

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function headers(init: Record<string, string>): Headers {
    return new Headers(init);
}

async function main(): Promise<void> {
    assert(
        extractApiKeyFromHeaders(headers({ Authorization: 'Bearer test-token' })) === 'test-token',
        'should parse bearer token'
    );
    assert(
        extractApiKeyFromHeaders(headers({ 'X-API-Key': 'header-key' })) === 'header-key',
        'should parse x-api-key header'
    );

    const open = authorizeRequest(headers({}), { requireApiKey: false });
    assert(open.authorized === true, 'auth should be optional when requireApiKey=false');

    const missing = authorizeRequest(headers({}), { requireApiKey: true, apiKey: 'secret' });
    assert(missing.authorized === false && missing.status === 401, 'missing key should be 401');

    const invalid = authorizeRequest(headers({ Authorization: 'Bearer wrong' }), {
        requireApiKey: true,
        apiKey: 'secret'
    });
    assert(invalid.authorized === false && invalid.status === 403, 'invalid key should be 403');

    const valid = authorizeRequest(headers({ 'X-API-Key': 'secret' }), {
        requireApiKey: true,
        apiKey: 'secret'
    });
    assert(valid.authorized === true, 'valid key should authorize');

    console.log('test-serverless-auth: all tests passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
