import { AppConfig } from '../../config.js';
import { OpenWebSearchRuntime } from '../../runtime/runtimeTypes.js';
import { createErrorEnvelope, createSuccessEnvelope } from '../../cli/protocol.js';
import { normalizeEngineName, resolveRequestedEngines, SupportedSearchEngine } from '../../core/search/searchEngines.js';

export type ApiStatusPayload = {
    daemon: 'running';
    runtime: 'ready';
    activation: 'active';
    version: string;
    capabilities: string[];
    baseUrl: string;
    deployment: 'local' | 'serverless';
    configSummary: {
        defaultSearchEngine: string;
        allowedSearchEngines: string[];
        searchMode: string;
        useProxy: boolean;
        fetchWebAllowInsecureTls: boolean;
        playwrightAvailable: boolean;
        apiKeyRequired: boolean;
    };
};

export function getApiCapabilities(): string[] {
    return [
        'search',
        'fetch-web',
        'fetch-csdn',
        'fetch-juejin',
        'fetch-github-readme',
        'fetch-linuxdo',
        'mcp'
    ];
}

export function parseRequestedEngines(runtime: OpenWebSearchRuntime, engines: unknown): SupportedSearchEngine[] {
    if (engines === undefined) {
        return [runtime.config.defaultSearchEngine as SupportedSearchEngine];
    }

    if (!Array.isArray(engines) || engines.some((engine) => typeof engine !== 'string')) {
        throw new Error('engines must be an array of strings');
    }

    if (engines.length === 0) {
        throw new Error('engines must not be empty');
    }

    const normalized = engines
        .map((engine) => normalizeEngineName(engine))
        .filter(Boolean);

    return resolveRequestedEngines(
        normalized,
        runtime.config.allowedSearchEngines,
        runtime.config.defaultSearchEngine
    ) as SupportedSearchEngine[];
}

export function parseLimit(limit: unknown): number {
    if (limit === undefined) {
        return 10;
    }

    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 50) {
        throw new Error('limit must be an integer between 1 and 50');
    }

    return limit;
}

export function parseSearchMode(searchMode: unknown): AppConfig['searchMode'] | undefined {
    if (searchMode === undefined) {
        return undefined;
    }

    if (searchMode !== 'request' && searchMode !== 'auto' && searchMode !== 'playwright') {
        throw new Error('searchMode must be one of: request, auto, playwright');
    }

    return searchMode;
}

export function parseUrl(url: unknown): string {
    if (typeof url !== 'string' || !url.trim()) {
        throw new Error('url must be a non-empty string');
    }

    return url.trim();
}

export function parseMaxChars(maxChars: unknown): number {
    if (maxChars === undefined) {
        return 30000;
    }

    if (typeof maxChars !== 'number' || !Number.isInteger(maxChars) || maxChars < 1000 || maxChars > 200000) {
        throw new Error('maxChars must be an integer between 1000 and 200000');
    }

    return maxChars;
}

export function parseBooleanFlag(value: unknown, name: string): boolean | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'boolean') {
        throw new Error(`${name} must be a boolean`);
    }
    return value;
}

export function createApiStatusPayload(
    runtime: OpenWebSearchRuntime,
    options: {
        version: string;
        baseUrl: string;
        deployment: 'local' | 'serverless';
        apiKeyRequired: boolean;
        playwrightAvailable?: boolean;
    }
): ApiStatusPayload {
    const playwrightAvailable = options.playwrightAvailable ?? (
        options.deployment === 'local'
        && (runtime.config.searchMode === 'playwright' || runtime.config.searchMode === 'auto')
    );

    return {
        daemon: 'running',
        runtime: 'ready',
        activation: 'active',
        version: options.version,
        capabilities: getApiCapabilities(),
        baseUrl: options.baseUrl,
        deployment: options.deployment,
        configSummary: {
            defaultSearchEngine: runtime.config.defaultSearchEngine,
            allowedSearchEngines: runtime.config.allowedSearchEngines,
            searchMode: options.deployment === 'serverless' ? 'request' : runtime.config.searchMode,
            useProxy: runtime.config.useProxy,
            fetchWebAllowInsecureTls: runtime.config.fetchWebAllowInsecureTls,
            playwrightAvailable,
            apiKeyRequired: options.apiKeyRequired
        }
    };
}

type RouteErrorEnvelope = ReturnType<typeof createErrorEnvelope>;

export async function handleSearchRequest(
    runtime: OpenWebSearchRuntime,
    body: Record<string, unknown>,
    options: { forceRequestMode?: boolean } = {}
): Promise<{ status: number; body: unknown }> {
    try {
        const query = typeof body.query === 'string' ? body.query.trim() : '';
        if (!query) {
            return {
                status: 400,
                body: createErrorEnvelope(
                    'invalid_request',
                    'query must be a non-empty string',
                    { hint: 'Provide a search query and optionally limit and engines.' }
                ) satisfies RouteErrorEnvelope
            };
        }

        const limit = parseLimit(body.limit);
        const engines = parseRequestedEngines(runtime, body.engines);
        const requestedSearchMode = parseSearchMode(body.searchMode);
        const searchMode = options.forceRequestMode ? 'request' : requestedSearchMode;
        const result = await runtime.services.search.execute({
            query,
            limit,
            engines,
            searchMode
        });

        return {
            status: 200,
            body: createSuccessEnvelope(result)
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const statusCode = message.includes('must') || message.includes('empty') ? 400 : 500;
        return {
            status: statusCode,
            body: createErrorEnvelope(
                statusCode === 400 ? 'invalid_request' : 'engine_error',
                message,
                {
                    hint: statusCode === 400
                        ? 'Use a non-empty query, a limit between 1 and 50, valid engine names, and an optional searchMode of request/auto/playwright.'
                        : 'Retry with a different engine or inspect runtime configuration.'
                }
            ) satisfies RouteErrorEnvelope
        };
    }
}

export async function handleFetchWebRequest(
    runtime: OpenWebSearchRuntime,
    body: Record<string, unknown>
): Promise<{ status: number; body: unknown }> {
    try {
        const url = parseUrl(body.url);
        const maxChars = parseMaxChars(body.maxChars);
        const readability = parseBooleanFlag(body.readability, 'readability');
        const includeLinks = parseBooleanFlag(body.includeLinks, 'includeLinks');
        const result = await runtime.services.fetchWeb.execute({ url, maxChars, readability, includeLinks });
        return {
            status: 200,
            body: createSuccessEnvelope(result)
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            status: 400,
            body: createErrorEnvelope('validation_failed', message, {
                hint: 'Use a public HTTP(S) URL, keep maxChars within the supported range, and pass readability/includeLinks only as booleans.'
            }) satisfies RouteErrorEnvelope
        };
    }
}

export async function handleFetchGithubReadmeRequest(
    runtime: OpenWebSearchRuntime,
    body: Record<string, unknown>
): Promise<{ status: number; body: unknown }> {
    try {
        const url = parseUrl(body.url);
        const result = await runtime.services.fetchGithubReadme.execute({ url });

        if (!result) {
            return {
                status: 404,
                body: createErrorEnvelope('not_found', 'README not found or repository does not exist', {
                    hint: 'Verify the repository URL and default branch contents.'
                }) satisfies RouteErrorEnvelope
            };
        }

        return {
            status: 200,
            body: createSuccessEnvelope({ url, content: result })
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            status: 400,
            body: createErrorEnvelope('validation_failed', message, {
                hint: 'Use a valid GitHub repository URL in HTTPS or SSH form.'
            }) satisfies RouteErrorEnvelope
        };
    }
}

export async function handleFetchCsdnRequest(
    runtime: OpenWebSearchRuntime,
    body: Record<string, unknown>
): Promise<{ status: number; body: unknown }> {
    try {
        const url = parseUrl(body.url);
        const result = await runtime.services.fetchCsdnArticle.execute({ url });
        return {
            status: 200,
            body: createSuccessEnvelope({ url, content: result.content })
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            status: 400,
            body: createErrorEnvelope('validation_failed', message, {
                hint: 'Use a valid blog.csdn.net article URL.'
            }) satisfies RouteErrorEnvelope
        };
    }
}

export async function handleFetchJuejinRequest(
    runtime: OpenWebSearchRuntime,
    body: Record<string, unknown>
): Promise<{ status: number; body: unknown }> {
    try {
        const url = parseUrl(body.url);
        const result = await runtime.services.fetchJuejinArticle.execute({ url });
        return {
            status: 200,
            body: createSuccessEnvelope({ url, content: result.content })
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            status: 400,
            body: createErrorEnvelope('validation_failed', message, {
                hint: 'Use a valid juejin.cn post URL.'
            }) satisfies RouteErrorEnvelope
        };
    }
}

export async function handleFetchLinuxDoRequest(
    runtime: OpenWebSearchRuntime,
    body: Record<string, unknown>
): Promise<{ status: number; body: unknown }> {
    try {
        const url = parseUrl(body.url);
        const result = await runtime.services.fetchLinuxDoArticle.execute({ url });
        return {
            status: 200,
            body: createSuccessEnvelope({ url, content: result.content })
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            status: 400,
            body: createErrorEnvelope('validation_failed', message, {
                hint: 'Use a valid linux.do topic JSON URL.'
            }) satisfies RouteErrorEnvelope
        };
    }
}
