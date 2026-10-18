# NameInsight

[![CI](https://github.com/himan-patel/name-insight/actions/workflows/ci.yml/badge.svg)](https://github.com/himan-patel/name-insight/actions/workflows/ci.yml)

**NameInsight** looks up domain names and estimates whether they are available to register. It's a small
Express + TypeScript REST service.

For each domain it:

1. **Resolves** its A and AAAA records in DNS.
2. **Pings** its first public IPv4 address (via the [`ping`](https://www.npmjs.com/package/ping) package, which runs the system `ping` command).
3. Runs a **WHOIS** lookup (via the [`whois`](https://www.npmjs.com/package/whois) package).

Each result looks like this:

```json
{
  "probe": { "host": "example.com", "alive": true, "time": 38.9, "numeric_host": "104.20.23.154", "...": "..." },
  "dns": { "addresses": ["104.20.23.154", "2606:4700:10::6814:179a"] },
  "whois": "Domain Name: EXAMPLE.COM\n...",
  "available": false,
  "domain": "example.com"
}
```

> **Note:** `available` is `true` only when DNS has no address records **and** the ping gets no reply. It's still
> an estimate: a registered domain with no DNS records looks available. To confirm, check the `whois` text
> (e.g. `No match for domain ...`).

## Prerequisites

- Node.js 22 or newer (`engines` in package.json) and npm
- Outbound network access for DNS, ICMP ping and WHOIS (TCP port 43)

## Getting started

```bash
npm install
npm run start:tsnode
```

The service starts on **http://localhost:8080**.

| Script | What it does |
|---|---|
| `npm start` | Compile TypeScript, then run the compiled app (`dist/app/index.js`) |
| `npm run start:dist` | Run the already-compiled app without rebuilding |
| `npm run start:tsnode` | Run the app from source with ts-node |
| `npm run start-watch:tsnode` | Run from source and restart when a file changes (Node's built-in `--watch`) |
| `npm run inspect:tsnode` | Run with the Node inspector attached, for debugging |
| `npm run build` | Delete `dist/`, then compile TypeScript into it |
| `npm run clean` | Delete `dist/` |
| `npm run lint` | Lint `app/` with ESLint and typescript-eslint (`eslint.config.mjs`) |
| `npm run typecheck` | Type-check without emitting files |
| `npm test` | Run the test suite (`npm run test:coverage` for coverage) |
| `npm run secrets` | Scan the project for committed secrets (API keys, tokens, private keys) with secretlint |

Git hooks are managed by [husky](https://typicode.github.io/husky/) and installed by `npm install` (the
`prepare` script):

- **pre-commit** blocks commits containing secrets. It runs `npm run secrets`, plus
  [gitleaks](https://github.com/gitleaks/gitleaks) on the staged changes if gitleaks is installed
  (`brew install gitleaks`).
- **pre-push** runs `npm run lint` and `npm run typecheck`.

TypeScript and ts-node are development dependencies. For a production install (`npm ci --omit=dev`), build
first (e.g. in CI or a Docker build stage) and run `npm run start:dist`.

### Configuration

All settings are optional environment variables (see `app/config/global.config.ts`). `.env.example` lists them
all; copy it to `.env` (gitignored) and run with `node --env-file=.env ./dist/app/index.js`.

> **Never commit secrets.** API keys and tokens belong only in environment variables or an untracked `.env`
> file. `.env*` (except `.env.example`), `.npmrc` and key/certificate files are gitignored, and commits are
> scanned for secrets.

| Variable | Default | Description |
|---|---|---|
| `API_PORT` | `8080` | Port the server listens on |
| `API_HOST` | `0.0.0.0` | Address the server binds to. Use `127.0.0.1` to accept local connections only |
| `APP_NAME` | `NameInsight` | API title shown in Swagger UI |
| `LOG_REQUESTS` | `true` | Set to `false` to turn off the per-request access log |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | On SIGTERM/SIGINT, how long in-flight requests may finish before connections are force-closed |
| `CORS_ORIGINS` | _(empty)_ | Comma-separated origins allowed to call the API from a browser, e.g. `https://app.example.com`. Empty means no cross-origin access |
| `TRUST_PROXY_HOPS` | `0` | Number of reverse proxies in front of the service. Set this behind a load balancer so rate limiting uses the real client IP |
| `API_KEYS_SHA256` | _(empty)_ | Comma-separated SHA-256 digests of valid API keys. When set, `/api/*` requires a key (see [Authentication](#authentication)) |
| `RATE_LIMIT_MAX` | `30` | Requests allowed per client (API key, or IP) per window on `/api/*` |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window in milliseconds |
| `LOOKUP_BUDGET_MAX` | `200` | Domains each client may look up per window (a bulk request costs one per domain) |
| `LOOKUP_BUDGET_WINDOW_MS` | `60000` | Lookup-budget window in milliseconds |
| `MAX_DOMAINS_PER_REQUEST` | `50` | Maximum domains in one bulk request |
| `LOOKUP_CONCURRENCY` | `5` | Domains looked up at the same time within one request |
| `MAX_CONCURRENT_LOOKUPS` | `20` | Domains looked up at the same time across all requests |
| `DNS_SERVERS` | _(system resolvers)_ | Comma-separated DNS server IPs, e.g. `1.1.1.1,8.8.8.8`. Set this when the host's resolver also answers for internal zones |
| `MAX_BODY_BYTES` | `16384` | Maximum JSON / form body size |
| `MAX_UPLOAD_BYTES` | `65536` | Maximum uploaded file size |
| `DNS_TIMEOUT_MS` | `5000` | DNS query timeout |
| `PING_TIMEOUT_SECONDS` | `2` | Ping reply timeout |
| `WHOIS_TIMEOUT_MS` | `10000` | Hard deadline per WHOIS server (a lookup can follow up to 2 referrals) |
| `MAX_WHOIS_RESPONSE_BYTES` | `131072` | WHOIS responses longer than this are truncated |

Numeric values must be non-negative integers; the app refuses to start otherwise.

For example: `API_PORT=3000 npm run start:tsnode`

## Authentication

API keys are optional for local use and **required for any public deployment**.

```bash
npm run generate-api-key
```

This prints a new random key (give it to the client; it is shown once) and its SHA-256 digest. Configure only the
digest on the server, comma-separated for several keys:

```bash
API_KEYS_SHA256=<digest>[,<digest>...]
```

Clients send the key as `Authorization: Bearer <key>` or `X-API-Key: <key>`. The server stores and compares only
digests (in constant time), never logs keys, and returns `401` for a missing or wrong key. `/healthz` and the docs stay
open. Without `API_KEYS_SHA256` the API is open, and the server logs a warning at startup if it is reachable beyond
localhost.

> Keep keys in a secret or password manager. Never commit them or put them in issues or PRs.

## API documentation (Swagger)

With the server running, open:

- **Swagger UI:** http://localhost:8080/api-docs
- **Raw OpenAPI 3.0 spec (JSON):** http://localhost:8080/api-docs.json

Swagger UI lists every endpoint, with sample request bodies, example responses and the response schemas.
Use **Try it out** to send real requests to your local server.

Request and response schemas are generated from the zod contract in `app/core/schemas.ts` (also the source of the
TypeScript types and, later, the MCP tool inputs), so they can't drift from the code. Paths, descriptions and examples
live in `app/http/docs/openapi.ts`; contract tests check real responses and the documented examples against the
schemas.

## Endpoints

| Method | Path | Input |
|---|---|---|
| `GET` | `/api/v1/domains/info/:domain` | A single domain in the URL |
| `POST` | `/api/v1/domains/info/_payload` | JSON body: `{ "domains": ["a.com", "b.com"] }` |
| `POST` | `/api/v1/domains/info/_file` | `multipart/form-data` with a `file` field: a `text/plain` file, one domain per line |
| `GET` | `/healthz` | Health check: `200 {"status":"ok"}`, or `503` once shutdown has started |

The bulk endpoints return an array with one result per unique domain, in input order.

On `SIGTERM`/`SIGINT` the server stops accepting connections, lets in-flight lookups finish (up to
`SHUTDOWN_TIMEOUT_MS`), then exits. A second signal exits immediately.

### Input rules and errors

- Only **public domain names** are accepted. IP addresses, `localhost`, internal suffixes (`.local`, `.internal`,
  `.lan`, `.test`, ...) and malformed names are rejected with `400`. Internationalized names (e.g. `münchen.de`)
  are converted to punycode.
- Bulk requests accept at most 50 domains (`MAX_DOMAINS_PER_REQUEST`). If any domain is invalid, the whole request
  is rejected with `400` and `details.invalid` lists each bad entry.
- Uploaded files must be `text/plain` and at most 64 KB. Blank lines and lines starting with `#` are ignored.
  Files are processed in memory and never written to disk.
- Domains that resolve to private or reserved addresses (e.g. `10.x`, `127.x`, `169.254.x`) are never pinged;
  their `probe.skipped` is `"non-public-address"`. Private addresses are left out of `dns.addresses`, and
  `dns.nonPublic` is set to `true` instead.
- WHOIS referrals (the registry pointing to the registrar's WHOIS server) are only followed to public addresses on
  port 43. If the registrar's server fails, the registry's response is returned.
- A WHOIS failure doesn't fail the request: that domain gets `whois: null` and a `whoisError` message.
- Errors are JSON: `{ "error": "message", "details": { ... } }`. Too many requests, or more domains than the
  client's lookup budget allows, returns `429` (the budget response includes `Retry-After`).

### Quick test with curl

```bash
# Single domain
curl http://localhost:8080/api/v1/domains/info/example.com

# Several domains in a JSON body
curl -X POST http://localhost:8080/api/v1/domains/info/_payload \
  -H 'Content-Type: application/json' \
  -d '{"domains": ["example.com", "some-unregistered-name-xyz.com"]}'

# File upload
printf "example.com\ngoogle.com\n" > domains.txt
curl -F "file=@domains.txt;type=text/plain" http://localhost:8080/api/v1/domains/info/_file
```

## Project structure

```text
app/
├── index.ts                    # Entry point: starts the HTTP server
├── config/global.config.ts     # Environment-based configuration
├── core/                       # Transport-independent logic, shared by REST and MCP
│   ├── index.ts                # Public core API
│   ├── domain-service.ts       # DNS, ping and WHOIS per domain; text-file parsing
│   ├── validation.ts           # Domain name validation and public-IP checks
│   ├── dns.ts                  # DNS resolver with timeout and optional DNS_SERVERS
│   ├── whois.ts                # WHOIS client: referral checks, size cap, hard deadline
│   ├── schemas.ts              # zod data contract: types, OpenAPI schemas, MCP inputs
│   └── errors.ts               # ValidationError (mapped to 400 by the HTTP layer)
├── http/                       # REST API (Express)
│   ├── app.ts                  # createApp(): middleware, Swagger mount, routes, error handling
│   ├── http-error.ts           # Error type carrying an HTTP status
│   ├── docs/openapi.ts         # OpenAPI spec (generated from core schemas) served at /api-docs
│   └── routes/                 # Route registration, domain endpoints, file uploads
├── types/                      # Type declarations for untyped packages
└── utils/async.ts              # Timeout, concurrency, semaphore and error helpers
```

## Testing

```bash
npm test               # Jest unit + HTTP tests (no network access needed)
npm run test:coverage  # with a coverage report
```

CI (`.github/workflows/ci.yml`) runs lint, typecheck, tests, build, `npm audit` and a secret scan (gitleaks on the
full git history plus secretlint) on every pull request. Dependabot opens weekly dependency update PRs.

Tests live in `test/`. DNS, ping and WHOIS are mocked or served by local fake servers, so the suite is fast and
deterministic. HTTP behavior is tested with [supertest](https://github.com/ladjs/supertest) against
`createApp()` (`app/http/app.ts`), which builds the Express app without listening on a port.

## Known limitations

- **Authentication is opt-in.** Set `API_KEYS_SHA256` before exposing the service publicly.
- **The rate limit is per process and in memory.** It resets on restart and isn't shared between instances.
  The lookup budget (`LOOKUP_BUDGET_MAX`) additionally caps domains per client per window.
- **WHOIS servers rate-limit heavy use.** Large or frequent bulk requests may start getting `whoisError` results.
- **`available` is an estimate** (see the note at the top).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for the branch naming convention and PR workflow. Report
vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 Himan Patel
