# Serverless Deployment

Deploy the full open-websearch MCP server and REST API to serverless platforms such as Vercel, Netlify, and Cloudflare Workers.

Security uses **real end-to-end encryption** (X25519 ECDH + AES-256-GCM), not API keys.

## What you get

| Endpoint | Method | Encryption | Description |
|----------|--------|------------|-------------|
| `/health` | GET | Public | Liveness check |
| `/.well-known/open-websearch-e2e` | GET | Public | Server X25519 public key discovery |
| `/status` | GET | E2E | Deployment status and capabilities |
| `/search` | POST | E2E | Web search |
| `/fetch-web` | POST | E2E | Fetch public page content |
| `/fetch-github-readme` | POST | E2E | Fetch GitHub README |
| `/fetch-csdn` | POST | E2E | Fetch CSDN article |
| `/fetch-juejin` | POST | E2E | Fetch Juejin article |
| `/fetch-linuxdo` | POST | E2E | Fetch Linux.do topic JSON |
| `/mcp` | GET/POST/DELETE | E2E | MCP Streamable HTTP (stateless) |

## End-to-end encryption model

Based on the [X25519 + AES-256-GCM API pattern](https://blog.vitalvas.com/post/2025/07/27/e2e-encryption-api-x25519-aes/):

1. Client fetches the server public key from `/.well-known/open-websearch-e2e`
2. Client generates an ephemeral X25519 keypair per request
3. Both sides derive the same AES-256-GCM session key via ECDH + HKDF
4. Request and response bodies travel as encrypted JSON envelopes over HTTPS

Algorithm: `X25519-AES-256-GCM`

Headers:

```http
X-E2E-Client-Public-Key: <base64 SPKI ephemeral public key>
X-E2E-Encrypted: 1
Content-Type: application/open-websearch+e2e
```

Encrypted envelope:

```json
{
  "v": 1,
  "alg": "X25519-AES-256-GCM",
  "payload": "<base64 iv + authTag + ciphertext>"
}
```

HTTPS is required in production. Plaintext request bodies are allowed by default; set `REQUIRE_E2E_ENCRYPTION=true` to reject unencrypted payloads.

## Generate server keys

```bash
npm run build
open-websearch e2e-keygen
```

Set the printed private key in your deployment environment:

```bash
OPEN_WEBSEARCH_E2E_PRIVATE_KEY=<pkcs8-base64-private-key>
DEPLOYMENT_MODE=serverless
# Optional: REQUIRE_E2E_ENCRYPTION=true
```

Never commit the private key to git.

## Deploy to Vercel

1. Set `OPEN_WEBSEARCH_E2E_PRIVATE_KEY` in Vercel project settings
2. Deploy:

```bash
npm run build
npx vercel deploy --prod
```

### Encrypted REST example

```bash
npm run build
node --input-type=module -e "
import { e2eJsonRequest } from './build/adapters/http/e2eClient.js';
const result = await e2eJsonRequest('https://your-project.vercel.app', '/search', {
  body: { query: 'open web search', limit: 3, engines: ['duckduckgo'] }
});
console.log(result);
"
```

### MCP over E2E

MCP clients must send encrypted JSON-RPC bodies to `/mcp` with the E2E headers above. For clients that only support local stdio, proxy through `mcp-remote` and terminate TLS at the platform edge.

## Deploy to Netlify

1. Set `OPEN_WEBSEARCH_E2E_PRIVATE_KEY` in site environment settings
2. Deploy:

```bash
npm run build
npx netlify deploy --prod
```

MCP endpoint:

```text
https://your-site.netlify.app/mcp
```

## Deploy to Cloudflare Workers

```bash
npm run build
npx wrangler secret put OPEN_WEBSEARCH_E2E_PRIVATE_KEY
npx wrangler deploy
```

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPEN_WEBSEARCH_E2E_PRIVATE_KEY` | Yes (production) | empty | Server X25519 PKCS8 private key (base64) |
| `DEPLOYMENT_MODE` | Recommended | `serverless` in templates | Enables serverless defaults |
| `REQUIRE_E2E_ENCRYPTION` | No | `false` | Set to `true` to reject plaintext payloads |
| `ENABLE_CORS` | No | `true` in templates | Add CORS headers |
| `CORS_ORIGIN` | No | `*` | Allowed origin for CORS |
| `DEFAULT_SEARCH_ENGINE` | No | `bing` | Default engine |
| `ALLOWED_SEARCH_ENGINES` | No | all | Comma-separated engine allowlist |
| `USE_PROXY` | No | `false` | Enable outbound HTTP proxy |
| `PROXY_URL` | No | `http://127.0.0.1:7890` | Proxy URL when `USE_PROXY=true` |
| `SEARCH_MODE` | No | `request` in templates | Forced to `request` in serverless handlers |

Legacy API key variables (`OPEN_WEBSEARCH_API_KEY`, `REQUIRE_API_KEY`) are no longer used by the serverless adapter.

## Serverless constraints

- Playwright/browser fallback is disabled; search runs in `request` mode only
- MCP runs in stateless mode (no in-memory sessions across invocations)
- Subject to platform function timeout limits

## Local serverless smoke test

```bash
npm run build
OPEN_WEBSEARCH_E2E_PRIVATE_KEY="$(node -e "import { generateE2EKeyMaterial } from './build/adapters/http/e2eEncryption.js'; console.log(generateE2EKeyMaterial().privateKeyBase64)")" \
DEPLOYMENT_MODE=serverless \
node --input-type=module -e "
import { createServerlessFetchHandler } from './build/adapters/http/serverlessApp.js';
import { createE2EClientSession } from './build/adapters/http/e2eClient.js';
import { buildEncryptedRequestInit, parseEncryptedResponse } from './build/adapters/http/e2eClient.js';
import { readE2ESecurityOptionsFromEnv } from './build/adapters/http/e2eEncryption.js';

const handler = createServerlessFetchHandler({ e2e: readE2ESecurityOptionsFromEnv() });
const wellKnown = await handler(new Request('http://localhost/.well-known/open-websearch-e2e'));
const { data } = await wellKnown.json();
const session = createE2EClientSession(data.serverPublicKey);
const response = await handler(new Request('http://localhost/status', buildEncryptedRequestInit(session, 'GET')));
console.log(await parseEncryptedResponse(session, response));
"
```

Run automated tests:

```bash
npm run test:serverless
```

## Architecture

```text
Client                          Serverless edge (HTTPS)
  |                                      |
  |-- GET /.well-known/open-websearch-e2e -> server public key
  |-- ephemeral X25519 keypair             |
  |-- ECDH + AES-256-GCM request ---------> decrypt -> MCP/REST core
  |<--------- encrypted response ---------- encrypt
```

The serverless adapter uses:

- MCP SDK `WebStandardStreamableHTTPServerTransport` for `/mcp`
- Native Node.js `crypto` X25519 + AES-256-GCM for payload encryption
