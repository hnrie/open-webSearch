import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createSuccessEnvelope, createErrorEnvelope } from '../../cli/protocol.js';
import { createOpenWebSearchRuntime } from '../../runtime/createRuntime.js';
import type { OpenWebSearchRuntime } from '../../runtime/runtimeTypes.js';
import { setupTools } from '../../tools/setupTools.js';
import { authorizeRequest, readApiAuthOptionsFromEnv, type ApiAuthOptions } from './auth.js';
import {
    createApiStatusPayload,
    handleFetchCsdnRequest,
    handleFetchGithubReadmeRequest,
    handleFetchJuejinRequest,
    handleFetchLinuxDoRequest,
    handleFetchWebRequest,
    handleSearchRequest
} from './apiRouteHandlers.js';

export type ServerlessAppOptions = {
    version?: string;
    auth?: ApiAuthOptions;
    runtime?: OpenWebSearchRuntime;
};

const JSON_HEADERS = {
    'Content-Type': 'application/json; charset=utf-8'
} as const;

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
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, Mcp-Session-Id, MCP-Protocol-Version',
        'Access-Control-Expose-Headers': 'Mcp-Session-Id',
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

function jsonResponse(request: Request, status: number, body: unknown): Response {
    return withCors(request, new Response(JSON.stringify(body), {
        status,
        headers: JSON_HEADERS
    }));
}

function unauthorizedResponse(request: Request, authResult: Extract<ReturnType<typeof authorizeRequest>, { authorized: false }>): Response {
    return jsonResponse(request, authResult.status, createErrorEnvelope(
        authResult.status === 401 ? 'unauthorized' : authResult.status === 403 ? 'forbidden' : 'service_unavailable',
        authResult.message,
        {
            hint: 'Provide Authorization: Bearer <OPEN_WEBSEARCH_API_KEY> or X-API-Key: <OPEN_WEBSEARCH_API_KEY>'
        }
    ));
}

function createMcpServer(): McpServer {
    const runtime = createOpenWebSearchRuntime();
    const server = new McpServer({
        name: 'web-search',
        version: '1.2.0'
    });
    setupTools(server, runtime);
    return server;
}

async function handleMcpRequest(request: Request): Promise<Response> {
    const server = createMcpServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
    });

    await server.connect(transport);

    try {
        const response = await transport.handleRequest(request);
        return response;
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

export function createServerlessFetchHandler(options: ServerlessAppOptions = {}) {
    const version = options.version ?? process.env.npm_package_version ?? 'unknown';
    const auth = options.auth ?? readApiAuthOptionsFromEnv();
    const runtime = options.runtime ?? createOpenWebSearchRuntime();

    return async function handleServerlessRequest(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const pathname = normalizePathname(url.pathname);

        if (request.method === 'OPTIONS') {
            return withCors(request, new Response(null, { status: 204 }));
        }

        const publicPaths = new Set(['/health']);
        if (!publicPaths.has(pathname)) {
            const authResult = authorizeRequest(request.headers, auth);
            if (!authResult.authorized) {
                return unauthorizedResponse(request, authResult);
            }
        }

        if (pathname === '/health' && request.method === 'GET') {
            return jsonResponse(request, 200, createSuccessEnvelope({
                daemon: 'running',
                deployment: 'serverless'
            }));
        }

        if (pathname === '/status' && request.method === 'GET') {
            const baseUrl = getRequestOrigin(request);
            return jsonResponse(request, 200, createSuccessEnvelope(
                createApiStatusPayload(runtime, {
                    version,
                    baseUrl,
                    deployment: 'serverless',
                    apiKeyRequired: auth.requireApiKey,
                    playwrightAvailable: false
                })
            ));
        }

        if (pathname === '/search' && request.method === 'POST') {
            const body = await readJsonBody(request);
            const result = await handleSearchRequest(runtime, body, { forceRequestMode: true });
            return jsonResponse(request, result.status, result.body);
        }

        if (pathname === '/fetch-web' && request.method === 'POST') {
            const body = await readJsonBody(request);
            const result = await handleFetchWebRequest(runtime, body);
            return jsonResponse(request, result.status, result.body);
        }

        if (pathname === '/fetch-github-readme' && request.method === 'POST') {
            const body = await readJsonBody(request);
            const result = await handleFetchGithubReadmeRequest(runtime, body);
            return jsonResponse(request, result.status, result.body);
        }

        if (pathname === '/fetch-csdn' && request.method === 'POST') {
            const body = await readJsonBody(request);
            const result = await handleFetchCsdnRequest(runtime, body);
            return jsonResponse(request, result.status, result.body);
        }

        if (pathname === '/fetch-juejin' && request.method === 'POST') {
            const body = await readJsonBody(request);
            const result = await handleFetchJuejinRequest(runtime, body);
            return jsonResponse(request, result.status, result.body);
        }

        if (pathname === '/fetch-linuxdo' && request.method === 'POST') {
            const body = await readJsonBody(request);
            const result = await handleFetchLinuxDoRequest(runtime, body);
            return jsonResponse(request, result.status, result.body);
        }

        if (pathname === '/mcp' && (request.method === 'POST' || request.method === 'GET' || request.method === 'DELETE')) {
            const response = await handleMcpRequest(request);
            return withCors(request, response);
        }

        return jsonResponse(request, 404, createErrorEnvelope(
            'not_found',
            `No route for ${request.method} ${pathname}`,
            {
                hint: 'Use /health, /status, /search, /fetch-*, or /mcp'
            }
        ));
    };
}
