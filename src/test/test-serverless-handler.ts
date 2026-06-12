import { createServerlessFetchHandler } from '../adapters/http/serverlessApp.js';
import { createOpenWebSearchRuntime } from '../runtime/createRuntime.js';
import { AppConfig } from '../config.js';

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

async function request(
    handler: (request: Request) => Promise<Response>,
    path: string,
    init: RequestInit & { apiKey?: string } = {}
): Promise<Response> {
    const headers = new Headers(init.headers);
    if (init.apiKey) {
        headers.set('Authorization', `Bearer ${init.apiKey}`);
    }

    return handler(new Request(`https://example.test${path}`, {
        ...init,
        headers
    }));
}

async function testHealthIsPublic(): Promise<void> {
    const handler = createServerlessFetchHandler({
        version: 'test',
        auth: { apiKey: 'secret', requireApiKey: true }
    });

    const response = await request(handler, '/health');
    assert(response.status === 200, 'health should be public');
    const body = await response.json() as { status: string; data: { deployment: string } };
    assert(body.status === 'ok', 'health envelope should be ok');
    assert(body.data.deployment === 'serverless', 'health should report serverless deployment');
}

async function testProtectedRoutesRequireApiKey(): Promise<void> {
    const handler = createServerlessFetchHandler({
        version: 'test',
        auth: { apiKey: 'secret', requireApiKey: true }
    });

    const response = await request(handler, '/status');
    assert(response.status === 401, 'status without API key should be 401');
}

async function testStatusWithApiKey(): Promise<void> {
    const handler = createServerlessFetchHandler({
        version: 'test',
        auth: { apiKey: 'secret', requireApiKey: true }
    });

    const response = await request(handler, '/status', { apiKey: 'secret' });
    assert(response.status === 200, 'status with API key should succeed');
    const body = await response.json() as {
        status: string;
        data: {
            deployment: string;
            configSummary: { searchMode: string; playwrightAvailable: boolean; apiKeyRequired: boolean };
        };
    };
    assert(body.data.deployment === 'serverless', 'status should report serverless deployment');
    assert(body.data.configSummary.searchMode === 'request', 'serverless should force request mode');
    assert(body.data.configSummary.playwrightAvailable === false, 'playwright should be unavailable');
    assert(body.data.configSummary.apiKeyRequired === true, 'status should report API key requirement');
}

async function testSearchRoute(): Promise<void> {
    const handler = createServerlessFetchHandler({
        version: 'test',
        auth: { requireApiKey: false },
        runtime: createStubRuntime()
    });

    const response = await request(handler, '/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'hello', limit: 2 })
    });

    assert(response.status === 200, 'search should succeed');
    const body = await response.json() as { status: string; data: { results: unknown[] } };
    assert(body.status === 'ok', 'search envelope should be ok');
    assert(Array.isArray(body.data.results), 'search data.results should be an array');
    assert(body.data.results.length > 0, 'search should return at least one result');
}

async function testMcpInitialize(): Promise<void> {
    const handler = createServerlessFetchHandler({
        version: 'test',
        auth: { apiKey: 'secret', requireApiKey: true }
    });

    const response = await request(handler, '/mcp', {
        method: 'POST',
        apiKey: 'secret',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream'
        },
        body: JSON.stringify({
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
        })
    });

    assert(response.status === 200, `MCP initialize should succeed, got ${response.status}`);
    const contentType = response.headers.get('content-type') || '';
    assert(
        contentType.includes('application/json') || contentType.includes('text/event-stream'),
        `unexpected MCP content type: ${contentType}`
    );
}

async function testCorsPreflight(): Promise<void> {
    const handler = createServerlessFetchHandler({
        version: 'test',
        auth: { requireApiKey: false }
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
    await testHealthIsPublic();
    await testProtectedRoutesRequireApiKey();
    await testStatusWithApiKey();
    await testSearchRoute();
    await testMcpInitialize();
    await testCorsPreflight();
    console.log('test-serverless-handler: all tests passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
