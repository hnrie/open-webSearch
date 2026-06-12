export type ApiAuthResult =
    | { authorized: true }
    | { authorized: false; status: number; message: string };

export type ApiAuthOptions = {
    apiKey?: string;
    requireApiKey: boolean;
};

function extractBearerToken(authorizationHeader: string | null): string | undefined {
    if (!authorizationHeader) {
        return undefined;
    }

    const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
    return match?.[1]?.trim() || undefined;
}

export function extractApiKeyFromHeaders(headers: Headers): string | undefined {
    const headerKey = headers.get('x-api-key')?.trim();
    if (headerKey) {
        return headerKey;
    }

    return extractBearerToken(headers.get('authorization'));
}

export function authorizeRequest(headers: Headers, options: ApiAuthOptions): ApiAuthResult {
    if (!options.requireApiKey) {
        return { authorized: true };
    }

    const configuredKey = options.apiKey?.trim();
    if (!configuredKey) {
        return {
            authorized: false,
            status: 503,
            message: 'API key authentication is required but OPEN_WEBSEARCH_API_KEY is not configured'
        };
    }

    const providedKey = extractApiKeyFromHeaders(headers);
    if (!providedKey) {
        return {
            authorized: false,
            status: 401,
            message: 'Missing API key. Provide Authorization: Bearer <key> or X-API-Key: <key>'
        };
    }

    if (providedKey !== configuredKey) {
        return {
            authorized: false,
            status: 403,
            message: 'Invalid API key'
        };
    }

    return { authorized: true };
}

export function readApiAuthOptionsFromEnv(): ApiAuthOptions {
    const apiKey = process.env.OPEN_WEBSEARCH_API_KEY?.trim() || process.env.API_KEY?.trim() || undefined;
    const deploymentMode = process.env.DEPLOYMENT_MODE?.trim().toLowerCase();
    const isServerless = deploymentMode === 'serverless';
    const requireApiKey = process.env.REQUIRE_API_KEY === 'true'
        || (isServerless && process.env.REQUIRE_API_KEY !== 'false');

    return {
        apiKey,
        requireApiKey
    };
}
