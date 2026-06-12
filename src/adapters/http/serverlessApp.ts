import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createSuccessEnvelope, createErrorEnvelope } from '../../cli/protocol.js';
import { createOpenWebSearchRuntime } from '../../runtime/createRuntime.js';
import type { OpenWebSearchRuntime } from '../../runtime/runtimeTypes.js';
import { setupTools } from '../../tools/setupTools.js';
import {
    createApiStatusPayload,
    handleFetchCsdnRequest,
    handleFetchGithubReadmeRequest,
    handleFetchJuejinRequest,
    handleFetchLinuxDoRequest,
    handleFetchWebRequest,
    handleSearchRequest
} from './apiRouteHandlers.js';
import {
    createWellKnownPayload,
    E2E_WELL_KNOWN_PATH,
    readE2ESecurityOptionsFromEnv,
    type E2ESecurityOptions
} from './e2eEncryption.js';
import {
    decryptRequestBody,
    encryptJsonResponse,
    encryptRawResponse,
    openE2ESession,
    rebuildRequest,
    type E2ESessionContext
} from './e2eTransport.js';

export type ServerlessAppOptions = {
    version?: string;
    e2e?: E2ESecurityOptions;
    runtime?: OpenWebSearchRuntime;
};

function normalizePathname(pathname: string): string {
    if (!pathname || pathname === '/') {
        return '/';
    }

    return pathname.endsWith('/') && pathname.length > 1
        ? pathname.slice(0, -1)
        : pathname;
}

function getRequestOrigin(request: Request): string {
    const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
    const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
    const host = forwardedHost || request.headers.get('host') || 'localhost';
    const protocol = forwardedProto || (host.includes('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https');
    return `${protocol}://${host}`;
}

function corsHeaders(request: Request): Record<string, string> {
    const configuredOrigin = process.env.CORS_ORIGIN?.trim() || '*';
    const requestOrigin = request.headers.get('origin')?.trim();
    const allowOrigin = configuredOrigin === '*' ? '*' : (requestOrigin || configuredOrigin);

    return {
        'Access-Control-Allow-Origin': allowOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-E2E-Client-Public-Key, X-E2E-Encrypted, Mcp-Session-Id, MCP-Protocol-Version',
        'Access-Control-Expose-Headers': 'Mcp-Session-Id, X-E2E-Encrypted',
        'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
        'Vary': 'Origin'
    };
}

function withCors(request: Request, response: Response): Response {
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(corsHeaders(request))) {
        headers.set(key, value);
    }

    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
    });
}

function createMcpServer(runtime: OpenWebSearchRuntime): McpServer {
    const server = new McpServer({
        name: 'web-search',
        version: '1.2.0'
    });
    setupTools(server, runtime);
    return server;
}

async function handleMcpRequest(request: Request, runtime: OpenWebSearchRuntime): Promise<Response> {
    const server = createMcpServer(runtime);
    const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
    });

    await server.connect(transport);

    try {
        return await transport.handleRequest(request);
    } finally {
        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
    }
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'DELETE') {
        return {};
    }

    const contentType = request.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
        return {};
    }

    const body = await request.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body)
        ? body as Record<string, unknown>
        : {};
}

async function respondJson(
    request: Request,
    session: E2ESessionContext,
    status: number,
    body: unknown
): Promise<Response> {
    const response = await encryptJsonResponse(session, status, body);
    return withCors(request, response);
}

export function createServerlessFetchHandler(options: ServerlessAppOptions = {}) {
    const version = options.version ?? process.env.npm_package_version ?? 'unknown';
    const e2e = options.e2e ?? readE2ESecurityOptionsFromEnv();
    const runtime = options.runtime ?? createOpenWebSearchRuntime();

    return async function handleServerlessRequest(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const pathname = normalizePathname(url.pathname);

        if (request.method === 'OPTIONS') {
            return withCors(request, new Response(null, { status: 204 }));
        }

        const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
        if (forwardedProto === 'http' && !url.hostname.includes('localhost') && !url.hostname.startsWith('127.0.0.1')) {
            return respondJson(request, { encrypted: false }, 400, createErrorEnvelope(
                'insecure_transport',
                'HTTPS is required for serverless deployments',
                { hint: 'Connect over https:// and use end-to-end encrypted payloads.' }
            ));
        }

        const publicPaths = new Set(['/health', E2E_WELL_KNOWN_PATH]);
        const sessionResult = publicPaths.has(pathname)
            ? { encrypted: false } satisfies E2ESessionContext
            : await openE2ESession(request, e2e.serverKeys, e2e.requireE2E);

        if ('body' in sessionResult) {
            return respondJson(request, { encrypted: false }, sessionResult.status, sessionResult.body);
        }

        const session = sessionResult;
        let effectiveRequest = request;

        try {
            const decryptedBody = await decryptRequestBody(request, session);
            if (decryptedBody !== undefined) {
                effectiveRequest = rebuildRequest(request, decryptedBody);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return respondJson(request, session, 400, createErrorEnvelope(
                'decryption_failed',
                message,
                { hint: 'Ensure the client ephemeral key, encrypted envelope, and server private key match.' }
            ));
        }

        if (pathname === '/health' && request.method === 'GET') {
            return respondJson(request, { encrypted: false }, 200, createSuccessEnvelope({
                daemon: 'running',
                deployment: 'serverless',
                transport: 'https'
            }));
        }

        if (pathname === E2E_WELL_KNOWN_PATH && request.method === 'GET') {
            if (!e2e.serverKeys) {
                return respondJson(request, { encrypted: false }, 503, createErrorEnvelope(
                    'service_unavailable',
                    'E2E encryption keys are not configured on this deployment',
                    { hint: 'Run `open-websearch e2e-keygen` and set OPEN_WEBSEARCH_E2E_PRIVATE_KEY.' }
                ));
            }

            return respondJson(request, { encrypted: false }, 200, createSuccessEnvelope(
                createWellKnownPayload(e2e.serverKeys)
            ));
        }

        if (pathname === '/status' && request.method === 'GET') {
            const baseUrl = getRequestOrigin(request);
            return respondJson(request, session, 200, createSuccessEnvelope(
                createApiStatusPayload(runtime, {
                    version,
                    baseUrl,
                    deployment: 'serverless',
                    e2eEncryptionRequired: e2e.requireE2E,
                    e2eAlgorithm: e2e.serverKeys ? 'X25519-AES-256-GCM' : undefined,
                    e2eKeyId: e2e.serverKeys?.keyId,
                    playwrightAvailable: false
                })
            ));
        }

        if (pathname === '/search' && effectiveRequest.method === 'POST') {
            const body = await readJsonBody(effectiveRequest);
            const result = await handleSearchRequest(runtime, body, { forceRequestMode: true });
            return respondJson(request, session, result.status, result.body);
        }

        if (pathname === '/fetch-web' && effectiveRequest.method === 'POST') {
            const body = await readJsonBody(effectiveRequest);
            const result = await handleFetchWebRequest(runtime, body);
            return respondJson(request, session, result.status, result.body);
        }

        if (pathname === '/fetch-github-readme' && effectiveRequest.method === 'POST') {
            const body = await readJsonBody(effectiveRequest);
            const result = await handleFetchGithubReadmeRequest(runtime, body);
            return respondJson(request, session, result.status, result.body);
        }

        if (pathname === '/fetch-csdn' && effectiveRequest.method === 'POST') {
            const body = await readJsonBody(effectiveRequest);
            const result = await handleFetchCsdnRequest(runtime, body);
            return respondJson(request, session, result.status, result.body);
        }

        if (pathname === '/fetch-juejin' && effectiveRequest.method === 'POST') {
            const body = await readJsonBody(effectiveRequest);
            const result = await handleFetchJuejinRequest(runtime, body);
            return respondJson(request, session, result.status, result.body);
        }

        if (pathname === '/fetch-linuxdo' && effectiveRequest.method === 'POST') {
            const body = await readJsonBody(effectiveRequest);
            const result = await handleFetchLinuxDoRequest(runtime, body);
            return respondJson(request, session, result.status, result.body);
        }

        if (pathname === '/mcp' && (effectiveRequest.method === 'POST' || effectiveRequest.method === 'GET' || effectiveRequest.method === 'DELETE')) {
            const response = await handleMcpRequest(effectiveRequest, runtime);
            const encrypted = await encryptRawResponse(session, response);
            return withCors(request, encrypted);
        }

        return respondJson(request, session, 404, createErrorEnvelope(
            'not_found',
            `No route for ${request.method} ${pathname}`,
            {
                hint: 'Use /health, /.well-known/open-websearch-e2e, /status, /search, /fetch-*, or /mcp with E2E encryption.'
            }
        ));
    };
}
