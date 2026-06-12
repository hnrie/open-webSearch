import { createServerlessFetchHandler } from '../adapters/http/serverlessApp.js';
import { createOpenWebSearchRuntime } from '../runtime/createRuntime.js';
import { AppConfig } from '../config.js';
import { generateE2EKeyMaterial } from '../adapters/http/e2eEncryption.js';
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

function createTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
    return {
        defaultSearchEngine: 'bing',
        allowedSearchEngines: [],
        searchMode: 'request',
        proxyUrl: 'http://127.0.0.1:7890',
        useProxy: false,
        fakeIpCidrs: [],
        fetchWebAllowInsecureTls: false,
        playwrightPackage: 'auto',
        playwrightModulePath: undefined,
        playwrightExecutablePath: undefined,
        playwrightWsEndpoint: undefined,
        playwrightCdpEndpoint: undefined,
        playwrightHeadless: true,
        playwrightNavigationTimeoutMs: 20000,
        enableCors: true,
        corsOrigin: '*',
        enableHttpServer: true,
        ...overrides
    };
}

function createStubRuntime() {
    return createOpenWebSearchRuntime({
        config: createTestConfig(),
        dependencies: {
            searchExecutors: {
                bing: async (query, limit) => [{
                    title: 'Result',
                    url: 'https://example.com',
                    description: `${query}:${limit}`,
                    source: 'example.com',
                    engine: 'bing'
                }]
            },
            fetchGithubReadme: async () => '# README',
            fetchWebContent: async (url, maxChars) => ({
                url,
                finalUrl: url,
                contentType: 'text/plain',
                title: 'Example',
                retrievalMethod: 'request' as const,
                truncated: false,
                content: `ok:${maxChars}`,
                readabilityApplied: false
            }),
            fetchCsdnArticle: async () => ({ content: 'csdn' }),
            fetchJuejinArticle: async () => ({ content: 'juejin' }),
            fetchLinuxDoArticle: async () => ({ content: 'linuxdo' })
        }
    });
}

async function request(handler: (request: Request) => Promise<Response>, path: string, init: RequestInit = {}): Promise<Response> {
    return handler(new Request(`https://example.test${path}`, init));
}

async function testHealthAndWellKnown(): Promise<void> {
    const serverKeys = generateE2EKeyMaterial();
    const handler = createServerlessFetchHandler({
        version: 'test',
        e2e: { requireE2E: true, serverKeys }
    });

    const health = await request(handler, '/health');
    assert(health.status === 200, 'health should be public');

    const wellKnown = await request(handler, '/.well-known/open-websearch-e2e');
    assert(wellKnown.status === 200, 'well-known should expose server public key');
    const wellKnownBody = await wellKnown.json() as { data: { serverPublicKey: string } };
    assert(wellKnownBody.data.serverPublicKey === serverKeys.publicKeyBase64, 'well-known public key should match');
}

async function testE2ERequiredWithoutEncryption(): Promise<void> {
    const serverKeys = generateE2EKeyMaterial();
    const handler = createServerlessFetchHandler({
        version: 'test',
        e2e: { requireE2E: true, serverKeys }
    });

    const response = await request(handler, '/status');
    assert(response.status === 400, 'status without E2E headers should be rejected');
}

async function testEncryptedStatusAndSearch(): Promise<void> {
    const serverKeys = generateE2EKeyMaterial();
    const handler = createServerlessFetchHandler({
        version: 'test',
        e2e: { requireE2E: true, serverKeys },
        runtime: createStubRuntime()
    });
    const session = createE2EClientSession(serverKeys.publicKeyBase64);

    const statusResponse = await request(
        handler,
        '/status',
        buildEncryptedRequestInit(session, 'GET')
    );
    assert(statusResponse.status === 200, 'encrypted status should succeed');
    const statusBody = await parseEncryptedResponse<{
        status: string;
        data: { configSummary: { e2eEncryptionRequired: boolean } };
    }>(session, statusResponse);
    assert(statusBody.data.configSummary.e2eEncryptionRequired === true, 'status should report E2E requirement');

    const searchResponse = await request(
        handler,
        '/search',
        buildEncryptedRequestInit(session, 'POST', { query: 'hello', limit: 2 })
    );
    assert(searchResponse.status === 200, 'encrypted search should succeed');
    const searchBody = await parseEncryptedResponse<{
        status: string;
        data: { results: unknown[] };
    }>(session, searchResponse);
    assert(searchBody.status === 'ok', 'search envelope should be ok');
    assert(searchBody.data.results.length > 0, 'search should return results');
}

async function testMcpInitializeEncrypted(): Promise<void> {
    const serverKeys = generateE2EKeyMaterial();
    const handler = createServerlessFetchHandler({
        version: 'test',
        e2e: { requireE2E: true, serverKeys }
    });
    const session = createE2EClientSession(serverKeys.publicKeyBase64);

    const mcpInit = buildEncryptedRequestInit(session, 'POST', {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: {
                name: 'test-client',
                version: '1.0.0'
            }
        }
    });
    const mcpHeaders = new Headers(mcpInit.headers);
    mcpHeaders.set('Accept', 'application/json, text/event-stream');

    const response = await request(handler, '/mcp', {
        ...mcpInit,
        headers: mcpHeaders
    });

    assert(response.status === 200, `encrypted MCP initialize should succeed, got ${response.status}`);
    const decrypted = await parseEncryptedResponse<{ jsonrpc: string }>(session, response);
    assert(decrypted.jsonrpc === '2.0', 'MCP response should decrypt to JSON-RPC');
}

async function testCorsPreflight(): Promise<void> {
    const serverKeys = generateE2EKeyMaterial();
    const handler = createServerlessFetchHandler({
        version: 'test',
        e2e: { requireE2E: true, serverKeys }
    });

    const response = await request(handler, '/search', {
        method: 'OPTIONS',
        headers: {
            Origin: 'https://cursor.com',
            'Access-Control-Request-Method': 'POST'
        }
    });

    assert(response.status === 204, 'OPTIONS should return 204');
    assert(response.headers.get('access-control-allow-origin') !== null, 'CORS origin header should be present');
}

async function main(): Promise<void> {
    await testHealthAndWellKnown();
    await testE2ERequiredWithoutEncryption();
    await testEncryptedStatusAndSearch();
    await testMcpInitializeEncrypted();
    await testCorsPreflight();
    console.log('test-serverless-handler: all tests passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
