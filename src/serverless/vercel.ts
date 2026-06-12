import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleServerlessRequest } from './handler.js';

function nodeHeadersToWebHeaders(nodeHeaders: IncomingMessage['headers']): Headers {
    const headers = new Headers();
    for (const [key, value] of Object.entries(nodeHeaders)) {
        if (value === undefined) {
            continue;
        }

        if (Array.isArray(value)) {
            for (const entry of value) {
                headers.append(key, entry);
            }
            continue;
        }

        headers.set(key, value);
    }
    return headers;
}

async function readNodeBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

function toWebRequest(req: IncomingMessage): Promise<Request> {
    const protocol = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() || 'https';
    const host = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim()
        || req.headers.host
        || 'localhost';
    const url = `${protocol}://${host}${req.url || '/'}`;

    return readNodeBody(req).then((body) => new Request(url, {
        method: req.method,
        headers: nodeHeadersToWebHeaders(req.headers),
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body
    }));
}

async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
        res.setHeader(key, value);
    });

    if (response.body) {
        const buffer = Buffer.from(await response.arrayBuffer());
        res.end(buffer);
        return;
    }

    res.end();
}

export default async function vercelHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const request = await toWebRequest(req);
    const response = await handleServerlessRequest(request);
    await writeWebResponse(res, response);
}
