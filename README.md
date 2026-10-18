# NameInsight

[![CI](https://github.com/himan-patel/name-insight/actions/workflows/ci.yml/badge.svg)](https://github.com/himan-patel/name-insight/actions/workflows/ci.yml)

**NameInsight** looks up domain names and estimates whether they are available to register. It's a small
Express + TypeScript REST service.

For each domain it:

1. **Resolves** its A and AAAA records in DNS.
2. Queries the registry over **RDAP** (registration status, dates, registrar, nameservers, DNSSEC), using IANA's
   bootstrap registry to find the right server.
3. Runs a **WHOIS** lookup (fallback for TLDs without RDAP, such as `.io` and `.de`).
4. **Pings** its first public IPv4 address (via the [`ping`](https://www.npmjs.com/package/ping) package).

Each result looks like this:

```json
{
  "domain": "example.com",
  "status": "registered",
  "confidence": "high",
  "registration": { "source": "rdap", "registered": true, "created": "1995-08-14T04:00:00Z", "expires": "2027-08-13T04:00:00Z", "ageDays": 11387, "daysUntilExpiry": 299, "registrar": "…" },
  "reasons": ["Registry (RDAP) reports the domain is registered (registrar: …)"],
  "available": false,
  "probe": { "host": "example.com", "alive": true, "time": 38.9, "numeric_host": "104.20.23.154", "...": "..." },
  "dns": { "addresses": ["104.20.23.154", "2606:4700:10::6814:179a"] },
  "rdap": { "registered": true, "registrar": "…", "created": "1995-08-14T04:00:00Z", "expires": "2027-08-13T04:00:00Z", "…": "…" },
  "whois": "Domain Name: EXAMPLE.COM\n...",
  "…": "…"
}
```

**`status`** is one of `available`, `registered`, `parked` (nameservers at a parking or for-sale marketplace),
`expiring` (expires within 30 days, or the registry is deleting it) or `unknown`. **`confidence`** says how sure it is:

| Confidence | Meaning |
|---|---|
| `high` | The registry answered: RDAP, or WHOIS text that clearly says registered / not registered |
| `medium` | No registry data, but the domain has DNS records (so it is registered) |
| `low` | No registry data and no DNS records or ping replies: an estimate |

`reasons` explains the decision in plain English, and `available` is shorthand for `status === "available"`.

## Prerequisites

- Node.js 22 or newer (`engines` in package.json) and npm
- Outbound network access for DNS, HTTPS (RDAP), ICMP ping and WHOIS (TCP port 43)

## Getting started

```bash
npm install
npm run start:tsnode
```

The service starts on **http://127.0.0.1:8080** (loopback only by default).

| Script | What it does |
|---|---|
| `npm start` | Compile TypeScript, then run the compiled app (`dist/app/index.js`) |
| `npm run start:dist` | Run the already-compiled app without rebuilding |
| `npm run start:mcp` | Run the compiled MCP server over stdio (see [MCP server](#mcp-server)) |
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
| `API_HOST` | `127.0.0.1` | Address the server binds to. Set `0.0.0.0` to serve other machines (e.g. in a container) |
| `APP_NAME` | `NameInsight` | API title shown in Swagger UI |
| `LOG_REQUESTS` | `true` | Set to `false` to turn off the per-request access log |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | On SIGTERM/SIGINT, how long in-flight requests may finish before connections are force-closed |
| `CORS_ORIGINS` | _(empty)_ | Comma-separated origins allowed to call the API from a browser, e.g. `https://app.example.com`. Empty means no cross-origin access |
| `TRUST_PROXY_HOPS` | `0` | Number of reverse proxies in front of the service. Set this behind a load balancer so rate limiting uses the real client IP |
| `RATE_LIMIT_MAX` | `30` | Requests allowed per client IP per window on `/api/*` |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window in milliseconds |
| `LOOKUP_BUDGET_MAX` | `200` | Domains each client IP may look up per window (a bulk request costs one per domain) |
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
| `RDAP_TIMEOUT_MS` | `5000` | Hard deadline per RDAP request |
| `MAX_RDAP_RESPONSE_BYTES` | `262144` | Larger RDAP responses are discarded |
| `WEB_CHECK_TIMEOUT_MS` | `5000` | Hard deadline for the `insights` HTTPS check |
| `ANTHROPIC_API_KEY` | _(empty)_ | **Secret.** Enables REST AI suggestions (and the MCP fallback). Set only in the environment; never commit |
| `AI_MODEL` | `claude-opus-5-5` | Claude model used for suggestions |
| `AI_EFFORT` | `medium` | Effort level for suggestions (`low`, `medium`, `high`) |
| `SUGGEST_RATE_LIMIT_MAX` | `5` | Suggestion requests per client IP per rate-limit window |

Numeric values must be non-negative integers; the app refuses to start otherwise.

For example: `API_PORT=3000 npm run start:tsnode`

## AI name suggestions

NameInsight can brainstorm brandable names for a business and then **verify every one** across TLDs with real registry
lookups, ranking them by availability (.com weighted highest). The model only proposes names; every status comes from
NameInsight's own lookups.

- **REST:** `POST /api/v1/domains/suggest` with `{ "description": "...", "count": 8, "tlds": ["com","io"], "style": "brandable" }`
  (`style`: `any`, `brandable`, `descriptive`, `short`, `compound`). Uses the Claude API (`claude-opus-5-5` by default) and
  is enabled **only when `ANTHROPIC_API_KEY` is set in the server's environment**; otherwise it returns `503`. It is limited
  to `SUGGEST_RATE_LIMIT_MAX` requests per client IP per window, and its lookups count toward the lookup budget.
- **MCP:** the `suggest_domains` tool uses **your own AI client's model through MCP sampling** (no key needed on the
  server). If the client doesn't support sampling, it falls back to the server's Claude API key if one is configured.

> **API keys are secrets.** Set `ANTHROPIC_API_KEY` only in the runtime environment or an untracked `.env` file. Never
> commit it. NameInsight never logs, stores or returns it.

The business description is treated as untrusted data: it is length-limited, clearly delimited in the prompt, and
the model can only return names, which are cleaned, validated and checked before anyone sees them.

## MCP server

NameInsight is also an [MCP](https://modelcontextprotocol.io) server, so AI assistants such as Claude can check
domains directly. It runs locally over stdio:

```bash
npm install && npm run build
npm run start:mcp          # or: node dist/app/mcp/stdio.js
```

**Claude Code:**

```bash
claude mcp add nameinsight -- node /absolute/path/to/name-insight/dist/app/mcp/stdio.js
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "nameinsight": {
      "command": "node",
      "args": ["/absolute/path/to/name-insight/dist/app/mcp/stdio.js"]
    }
  }
}
```

| Tool | What it does |
|---|---|
| `check_domain` | One domain: status, confidence, reasons, registration (dates, registrar), DNS and ping. `insights: true` adds nameservers, email setup and HTTPS/TLS; `include_raw_whois: true` adds the raw WHOIS text |
| `check_domains` | Up to 50 domains at once |
| `check_name_across_tlds` | One name across TLDs (default `.com .net .org .io .ai .dev .app .co`, or your own list), listing which are available |
| `suggest_domains` | Brainstorms names for a description (via MCP sampling, or the server's Claude API key), checks them across TLDs and ranks by availability |

All tools are read-only. Results are compact (no raw WHOIS or ping output unless asked) and come with a typed
`structuredContent` payload plus a one-line summary per domain. Invalid input returns a readable tool error. Logs go to
stderr so they never interfere with the protocol on stdout.

Try asking: *"Is nameinsight available as a .com or .io?"* or *"Check these five names and tell me which ones expire
soon."*

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

Add **`?insights=true`** to any lookup endpoint for extra signals (slower): DNS nameservers, email setup (MX,
whether it accepts mail, SPF, DMARC policy) and an HTTPS check of `https://<domain>/` (status, redirect target, TLS
certificate validity, issuer and days remaining). Nameservers found this way also feed parking detection.

On `SIGTERM`/`SIGINT` the server stops accepting connections, lets in-flight lookups finish (up to
`SHUTDOWN_TIMEOUT_MS`), then exits. A second signal exits immediately.

### Input rules and errors

- Subdomains are accepted: registry data and `status` refer to the **registrable domain** (Public Suffix List), e.g.
  `news.bbc.co.uk` is looked up as `bbc.co.uk` (returned as `registrableDomain`), while DNS and web checks use the full
  name. Public suffixes themselves (`co.uk`, `com.au`) are rejected.
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
- RDAP requests use HTTPS only (certificates validated), connect only to public IPv4 addresses, never follow
  redirects or links, and are size- and time-limited.
- The `insights` website check connects only to public IPv4 addresses, sends a `HEAD` request (headers only), never
  follows redirects, and accepts invalid certificates only so it can report them (nothing sensitive is sent).
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
│   ├── rdap.ts                 # RDAP client with cached IANA bootstrap
│   ├── whois-parse.ts          # Registration facts from raw WHOIS text
│   ├── availability.ts         # status / confidence / reasons from all signals
│   ├── insights.ts             # optional NS, MX/SPF/DMARC and HTTPS/TLS checks
│   ├── suggestions.ts          # AI name suggestions: prompt, validation, verification, ranking
│   ├── claude-generator.ts     # Claude API name generator (structured output)
│   ├── http-client.ts          # HTTPS JSON client: public-address pinning, size cap, deadline
│   ├── schemas.ts              # zod data contract: types, OpenAPI schemas, MCP inputs
│   └── errors.ts               # ValidationError (mapped to 400 by the HTTP layer)
├── mcp/                        # MCP server (tools) and stdio entry point
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

- **Public by design.** There is no authentication; abuse is limited by per-IP rate limits and lookup budgets,
  request size/time limits, and the private-network protections. Set `TRUST_PROXY_HOPS` behind a load balancer so
  limits apply to real client IPs.
- **Rate limits and lookup budgets are per process and in memory.** They reset on restart, and N instances allow
  N times the limits.
  The lookup budget (`LOOKUP_BUDGET_MAX`) additionally caps domains per client per window.
- **WHOIS servers rate-limit heavy use.** Large or frequent bulk requests may start getting `whoisError` results.
- **`available` is an estimate** (see the note at the top).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for the branch naming convention and PR workflow. Report
vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 Himan Patel
