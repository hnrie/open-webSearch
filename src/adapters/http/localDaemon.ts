import express from 'express';
import http from 'node:http';
import { OpenWebSearchRuntime } from '../../runtime/runtimeTypes.js';
import { createSuccessEnvelope } from '../../cli/protocol.js';
import { shutdownLocalPlaywrightBrowserSessions } from '../../utils/playwrightClient.js';
import {
    createApiStatusPayload,
    handleFetchCsdnRequest,
    handleFetchGithubReadmeRequest,
    handleFetchJuejinRequest,
    handleFetchLinuxDoRequest,
    handleFetchWebRequest,
    handleSearchRequest
} from './apiRouteHandlers.js';

export type LocalDaemonOptions = {
    host?: string;
    port?: number;
    version?: string;
};

export type LocalDaemonStatus = ReturnType<typeof createApiStatusPayload>;

export type LocalDaemonHandle = {
    host: string;
    port: number;
    baseUrl: string;
    server: http.Server;
    getStatus: () => LocalDaemonStatus;
    close: () => Promise<void>;
};

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3210;

async function sendJsonRouteResult(res: express.Response, result: { status: number; body: unknown }): Promise<void> {
    res.status(result.status).json(result.body);
}

export async function startLocalDaemon(
    runtime: OpenWebSearchRuntime,
    options: LocalDaemonOptions = {}
): Promise<LocalDaemonHandle> {
    const host = options.host ?? DEFAULT_HOST;
    const requestedPort = options.port ?? Number(process.env.OPEN_WEBSEARCH_DAEMON_PORT || DEFAULT_PORT);
    const version = options.version ?? 'unknown';

    const app = express();
    app.use(express.json());

    let baseUrl = '';

    const getStatus = (): LocalDaemonStatus => createApiStatusPayload(runtime, {
        version,
        baseUrl,
        deployment: 'local',
        apiKeyRequired: false
    });

    app.get('/health', (_req, res) => {
        res.json(createSuccessEnvelope({
            daemon: 'running'
        }));
    });

    app.get('/status', (_req, res) => {
        res.json(createSuccessEnvelope(getStatus()));
    });

    app.post('/search', async (req, res) => {
        await sendJsonRouteResult(res, await handleSearchRequest(runtime, req.body ?? {}));
    });

    app.post('/fetch-web', async (req, res) => {
        await sendJsonRouteResult(res, await handleFetchWebRequest(runtime, req.body ?? {}));
    });

    app.post('/fetch-github-readme', async (req, res) => {
        await sendJsonRouteResult(res, await handleFetchGithubReadmeRequest(runtime, req.body ?? {}));
    });

    app.post('/fetch-csdn', async (req, res) => {
        await sendJsonRouteResult(res, await handleFetchCsdnRequest(runtime, req.body ?? {}));
    });

    app.post('/fetch-juejin', async (req, res) => {
        await sendJsonRouteResult(res, await handleFetchJuejinRequest(runtime, req.body ?? {}));
    });

    app.post('/fetch-linuxdo', async (req, res) => {
        await sendJsonRouteResult(res, await handleFetchLinuxDoRequest(runtime, req.body ?? {}));
    });

    const server = await new Promise<http.Server>((resolve, reject) => {
        const startedServer = app.listen(requestedPort, host, () => resolve(startedServer));
        startedServer.on('error', reject);
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Failed to resolve local daemon address');
    }

    baseUrl = `http://${host}:${address.port}`;

    return {
        host,
        port: address.port,
        baseUrl,
        server,
        getStatus,
        close: async () => {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            });

            try {
                await shutdownLocalPlaywrightBrowserSessions();
            } catch (error) {
                console.warn('Local daemon closed, but failed to shut down Playwright browser sessions:', error);
            }
        }
    };
}
