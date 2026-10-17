# NameInsight

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

Git hooks are managed by [husky](https://typicode.github.io/husky/) and installed by `npm install` (the
`prepare` script). The `pre-push` hook (`.husky/pre-push`) runs `npm version patch`, which bumps the patch
version and creates a version commit and tag locally; push again to publish them.

TypeScript and ts-node are development dependencies. For a production install (`npm ci --omit=dev`), build
first (e.g. in CI or a Docker build stage) and run `npm run start:dist`.

### Configuration

All settings are optional environment variables (see `app/config/global.config.ts`):

| Variable | Default | Description |
|---|---|---|
| `API_PORT` | `8080` | Port the server listens on |
| `API_HOST` | `0.0.0.0` | Address the server binds to. Use `127.0.0.1` to accept local connections only |
| `APP_NAME` | `NameInsight` | API title shown in Swagger UI |
| `CORS_ORIGINS` | _(empty)_ | Comma-separated origins allowed to call the API from a browser, e.g. `https://app.example.com`. Empty means no cross-origin access |
| `TRUST_PROXY_HOPS` | `0` | Number of reverse proxies in front of the service. Set this behind a load balancer so rate limiting uses the real client IP |
| `RATE_LIMIT_MAX` | `30` | Requests allowed per client IP per window on `/api/*` |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window in milliseconds |
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

## API documentation (Swagger)

With the server running, open:

- **Swagger UI:** http://localhost:8080/api-docs
- **Raw OpenAPI 3.0 spec (JSON):** http://localhost:8080/api-docs.json

Swagger UI lists every endpoint, with sample request bodies, example responses and the response schemas.
Use **Try it out** to send real requests to your local server.

The spec is written by hand in `app/docs/openapi.ts`. When you add or change an endpoint in
`app/routes/domain.api.ts`, update the spec to match.

## Endpoints

| Method | Path | Input |
|---|---|---|
| `GET` | `/api/v1/domains/info/:domain` | A single domain in the URL |
| `POST` | `/api/v1/domains/info/_payload` | JSON body: `{ "domains": ["a.com", "b.com"] }` |
| `POST` | `/api/v1/domains/info/_file` | `multipart/form-data` with a `file` field: a `text/plain` file, one domain per line |

The bulk endpoints return an array with one result per unique domain, in input order.

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
- Errors are JSON: `{ "error": "message", "details": { ... } }`. Too many requests returns `429`.

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
├── index.ts                    # Express server setup, middleware, Swagger mount
├── config/global.config.ts     # Environment-based configuration
├── docs/openapi.ts             # OpenAPI spec served at /api-docs
├── models/
│   ├── enums/                  # Shared enums
│   └── http-error.ts           # Error type carrying an HTTP status
├── routes/
│   ├── index.ts                # Route registration
│   └── domain.api.ts           # Domain endpoints and file upload handling
├── services/
│   ├── domain.service.ts       # DNS, ping and WHOIS per domain; text-file parsing
│   ├── domain-validation.ts    # Domain name validation and public-IP checks
│   ├── dns-resolver.ts         # DNS resolver with timeout and optional DNS_SERVERS
│   └── whois.client.ts         # WHOIS client: referral checks, size cap, hard deadline
└── utils/async.ts              # Timeout, concurrency and semaphore helpers
```

## Testing

There are no automated tests yet (`npm test` is a placeholder that exits with an error). For now, test by
hand with Swagger UI or the curl commands above.

## Known limitations

- **No authentication.** Anyone who can reach the service can use it, up to the rate limit. Put it behind
  authentication (or a private network) before exposing it publicly.
- **The rate limit is per process and in memory.** It resets on restart and isn't shared between instances.
  It counts requests, not domains, so one client can trigger up to 50 lookups per request.
- **WHOIS servers rate-limit heavy use.** Large or frequent bulk requests may start getting `whoisError` results.
- **`available` is an estimate** (see the note at the top).
