# Serverless Deployment

Deploy the full open-websearch MCP server and REST API to serverless platforms such as Vercel, Netlify, and Cloudflare Workers.

## What you get

Each deployment exposes:

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | Public | Liveness check |
| `/status` | GET | API key | Deployment status and capabilities |
| `/search` | POST | API key | Web search |
| `/fetch-web` | POST | API key | Fetch public page content |
| `/fetch-github-readme` | POST | API key | Fetch GitHub README |
| `/fetch-csdn` | POST | API key | Fetch CSDN article |
| `/fetch-juejin` | POST | API key | Fetch Juejin article |
| `/fetch-linuxdo` | POST | API key | Fetch Linux.do topic JSON |
| `/mcp` | GET/POST/DELETE | API key | MCP Streamable HTTP (stateless) |

The REST routes reuse the same response envelope as the local daemon (`status`, `data`, `error`, `hint`).

## Security

Set a strong API key in your platform environment:

```bash
OPEN_WEBSEARCH_API_KEY=replace-with-a-long-random-secret
DEPLOYMENT_MODE=serverless
```

Clients must send the key using either header:

```http
Authorization: Bearer <OPEN_WEBSEARCH_API_KEY>
```

or

```http
X-API-Key: <OPEN_WEBSEARCH_API_KEY>
```

`GET /health` stays public so load balancers can probe liveness without credentials.

To disable API key enforcement for local experiments only:

```bash
REQUIRE_API_KEY=false
```

Do not use `REQUIRE_API_KEY=false` on public production deployments.

## Serverless constraints

- **Playwright is disabled.** Serverless runtimes cannot launch local browsers. `SEARCH_MODE` is forced to `request`.
- **Stateless MCP.** Each MCP request creates a fresh server instance. Use Streamable HTTP clients that support stateless POST requests.
- **Timeouts.** Search and fetch latency depends on the target engine and your platform function timeout (for example, 10–60 seconds on Vercel depending on plan).
- **CORS is enabled** by default through `ENABLE_CORS=true` in the deployment templates.

## Deploy to Vercel

1. Install the Vercel CLI or connect the repository in the Vercel dashboard.
2. Set environment variables in the project settings:
   - `OPEN_WEBSEARCH_API_KEY`
   - Optional: `DEFAULT_SEARCH_ENGINE`, `USE_PROXY`, `PROXY_URL`, `ALLOWED_SEARCH_ENGINES`
3. Deploy. The included `vercel.json` builds the project and routes all paths to the serverless handler.

```bash
npm run build
npx vercel deploy --prod
```

### MCP client configuration (Vercel)

```json
{
  "mcpServers": {
    "web-search": {
      "url": "https://your-project.vercel.app/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

### REST example (Vercel)

```bash
curl -X POST https://your-project.vercel.app/search \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"open web search","limit":3,"engines":["duckduckgo"]}'
```

## Deploy to Netlify

1. Connect the repository in Netlify or use the Netlify CLI.
2. Set `OPEN_WEBSEARCH_API_KEY` and any optional runtime variables in site environment settings.
3. Deploy. `netlify.toml` builds the project and routes all paths to `/.netlify/functions/handler`.

```bash
npm run build
npx netlify deploy --prod
```

MCP clients should point to:

```text
https://your-site.netlify.app/mcp
```

For clients that only support local stdio transports, proxy through `mcp-remote`:

```json
{
  "mcpServers": {
    "web-search": {
      "command": "npx",
      "args": [
        "mcp-remote@next",
        "https://your-site.netlify.app/mcp",
        "--header",
        "Authorization: Bearer YOUR_API_KEY"
      ]
    }
  }
}
```

## Deploy to Cloudflare Workers

1. Install Wrangler: `npm install -g wrangler`
2. Build the project: `npm run build`
3. Set secrets:

```bash
wrangler secret put OPEN_WEBSEARCH_API_KEY
```

4. Deploy:

```bash
npx wrangler deploy
```

The worker entrypoint is `build/serverless/cloudflare.js` (configured in `wrangler.toml`).

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPEN_WEBSEARCH_API_KEY` | Yes (production) | empty | Shared secret for API and MCP access |
| `DEPLOYMENT_MODE` | Recommended | `serverless` in templates | Enables serverless defaults |
| `REQUIRE_API_KEY` | No | `true` when `DEPLOYMENT_MODE=serverless` | Enforce API key auth |
| `ENABLE_CORS` | No | `true` in templates | Add CORS headers |
| `CORS_ORIGIN` | No | `*` | Allowed origin for CORS |
| `DEFAULT_SEARCH_ENGINE` | No | `bing` | Default engine |
| `ALLOWED_SEARCH_ENGINES` | No | all | Comma-separated engine allowlist |
| `USE_PROXY` | No | `false` | Enable outbound HTTP proxy |
| `PROXY_URL` | No | `http://127.0.0.1:7890` | Proxy URL when `USE_PROXY=true` |
| `SEARCH_MODE` | No | `request` in templates | Forced to `request` in serverless handlers |
| `FETCH_WEB_INSECURE_TLS` | No | `false` | Disable TLS verification for fetch-web only |

All other variables from the main README still apply where relevant, except Playwright-related settings which are ignored in serverless mode.

## Local serverless smoke test

After building, you can exercise the fetch handler directly:

```bash
npm run build
OPEN_WEBSEARCH_API_KEY=test-key DEPLOYMENT_MODE=serverless node -e "
import { createServerlessFetchHandler } from './build/adapters/http/serverlessApp.js';
const handler = createServerlessFetchHandler();
const response = await handler(new Request('http://localhost/health'));
console.log(response.status, await response.text());
"
```

Run the automated serverless tests:

```bash
npm run test:serverless
```

## Architecture

```text
                 +----------------------+
                 | Core search/fetch    |
                 +----------+-----------+
                            |
                 +----------v-----------+
                 | Shared runtime       |
                 +-----+-----------+----+
                       |           |
           +-----------v--+   +----v----------------+
           | MCP stateless|   | REST API routes     |
           | /mcp         |   | /search /fetch-*    |
           +-----------+--+   +----+----------------+
                       |           |
                       +-----+-----+
                             |
                    +--------v--------+
                    | API key auth    |
                    | CORS middleware |
                    +--------+--------+
                             |
              +--------------+--------------+
              | Vercel | Netlify | Workers  |
              +--------+---------+----------+
```

The serverless adapter uses the MCP SDK `WebStandardStreamableHTTPServerTransport`, which works on any runtime that supports the Web Fetch API.
