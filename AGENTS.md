# AGENTS.md

## Cursor Cloud specific instructions

`open-websearch` is a TypeScript project that ships three runtime surfaces from a single entrypoint (`build/index.js`):

- **MCP server** — `npm start` / `node build/index.js`. `MODE` env var picks the transport: `both` (default, HTTP+STDIO), `http`, or `stdio`. Default port `3000`. The MCP HTTP routes are `/mcp` and `/sse`; `GET /` returns `404`, which is expected (not an error).
- **Local daemon** — `npm run serve` / `node build/index.js serve [--port 3210]`. A long-lived local HTTP service bound to `127.0.0.1` exposing `GET /health`, `GET /status`, and `POST /search`, `POST /fetch-web`, `POST /fetch-github-readme`, `POST /fetch-csdn`, `POST /fetch-juejin`, `POST /fetch-linuxdo`. See `docs/http-api.md`.
- **One-shot CLI** — `npm run search:cli -- "<query>" [--json]` / `node build/index.js search ...`. Action commands try the local daemon first if it is running, otherwise execute directly.

### Build / lint / test / run

- The update script runs `npm install` only. Build is intentionally not part of it. You must build before running the daemon/MCP/CLI directly, because `start`, `serve`, and `search:cli` execute `build/index.js` without compiling first: run `npm run build`.
- There is no ESLint config. `npm run build` (`tsc`) is the type-check / lint gate.
- `npm run dev` and `npm test` auto-compile via `tsc` first, so they do not need a separate build.
- `npm test` compiles, then runs every `build/test/*.js` in parallel. Live/network tests (e.g. Bing/CSDN) that fail with network errors are automatically **EXCUSED** and do not fail the suite; only non-network failures fail it. Expect a small number of excused tests depending on outbound connectivity.
- Runs on Node 22 (current VM) as well as the Node 20 used by the `Dockerfile`.

### Network / proxy notes

- Live search and fetch require outbound internet. DuckDuckGo, Brave, Startpage, Baidu, etc. generally work; Bing and some article hosts (CSDN) may return 301/521 without a proxy.
- When curling the local daemon, bypass shell proxy settings: `curl --noproxy '*' http://127.0.0.1:3210/health`.
- Browser-enhanced Bing fallback (Playwright) is opt-in and not installed by default; request-only paths work without it.
- **Serverless deployment** — Vercel (`vercel.json` + `api/index.js`), Netlify (`netlify.toml` + `netlify/functions/handler.ts`), and Cloudflare Workers (`wrangler.toml`) route to `build/serverless/*`. Use E2E encryption: `open-websearch e2e-keygen`, set `OPEN_WEBSEARCH_E2E_PRIVATE_KEY`, `DEPLOYMENT_MODE=serverless`. See `docs/serverless-deployment.md`.
