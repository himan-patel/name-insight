// Public
import { isIP } from 'net';

function intFromEnv(name: string, defaultValue: number, min = 0): number {
    const raw = process.env[name];
    if (raw === undefined || raw === '') {
        return defaultValue;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min) {
        throw new Error(`Invalid value for ${name}: expected an integer of at least ${min}, got "${raw}"`);
    }
    return value;
}

function listFromEnv(name: string): string[] {
    return (process.env[name] || '')
        .split(',')
        .map(item => item.trim())
        .filter(item => item.length > 0);
}

export const appName = process.env.APP_NAME || 'NameInsight';
/** Bind address. Defaults to loopback; set API_HOST=0.0.0.0 (with API_KEYS_SHA256) to serve other machines. */
export const host = process.env.API_HOST || '127.0.0.1';
export const port = intFromEnv('API_PORT', 8080);

/** Set LOG_REQUESTS=false to turn off the per-request access log (e.g. in tests). */
export const logRequests = process.env.LOG_REQUESTS !== 'false';

/** On SIGTERM/SIGINT, how long in-flight requests may run before connections are forced closed. */
export const shutdownTimeoutMs = intFromEnv('SHUTDOWN_TIMEOUT_MS', 10_000);

/** Origins allowed to call the API from a browser. Empty means cross-origin requests are not allowed. */
export const corsOrigins = listFromEnv('CORS_ORIGINS');

/** Number of reverse proxies in front of the service, so rate limiting sees the real client IP. 0 = none. */
export const trustProxyHops = intFromEnv('TRUST_PROXY_HOPS', 0);

/**
 * SHA-256 hex digests of valid API keys (comma-separated). When set, /api/* requires a key; raw keys are
 * never stored. Generate a key and its digest with `npm run generate-api-key`.
 */
export const apiKeyHashes = listFromEnv('API_KEYS_SHA256').map(hash => hash.toLowerCase());
const invalidApiKeyHash = apiKeyHashes.find(hash => !/^[0-9a-f]{64}$/.test(hash));
if (invalidApiKeyHash !== undefined) {
    throw new Error('Invalid value in API_KEYS_SHA256: each entry must be a 64-character SHA-256 hex digest');
}

/** Domains each client may look up per window across all requests (bulk requests cost one per domain). */
export const lookupBudgetMax = intFromEnv('LOOKUP_BUDGET_MAX', 200, 1);
export const lookupBudgetWindowMs = intFromEnv('LOOKUP_BUDGET_WINDOW_MS', 60_000, 1);

/**
 * Set AUTH_DISABLED=true to deliberately serve a non-loopback address without API keys (e.g. behind a private
 * network or an authenticating proxy). Without it, the server refuses to start in that configuration.
 */
export const authDisabled = process.env.AUTH_DISABLED === 'true';

/** Requests allowed per client (API key, or IP when unauthenticated) per window on the domain endpoints. */
export const rateLimitWindowMs = intFromEnv('RATE_LIMIT_WINDOW_MS', 60_000, 1);
export const rateLimitMax = intFromEnv('RATE_LIMIT_MAX', 30, 1);

/** Maximum domains accepted in a single bulk request (payload or file). */
export const maxDomainsPerRequest = intFromEnv('MAX_DOMAINS_PER_REQUEST', 50, 1);
if (lookupBudgetMax < maxDomainsPerRequest) {
    throw new Error(`LOOKUP_BUDGET_MAX (${lookupBudgetMax}) must be at least MAX_DOMAINS_PER_REQUEST (${maxDomainsPerRequest}), ` +
        'or the largest bulk requests could never succeed');
}

/** Number of domains looked up at the same time within one request. */
export const lookupConcurrency = Math.max(1, intFromEnv('LOOKUP_CONCURRENCY', 5));

/** Number of domains looked up at the same time across all requests (caps child processes and sockets). */
export const maxConcurrentLookups = Math.max(1, intFromEnv('MAX_CONCURRENT_LOOKUPS', 20));

/**
 * DNS servers used for domain and WHOIS-server lookups, e.g. "1.1.1.1,8.8.8.8". Empty uses the system resolvers.
 * Set this in deployments whose system resolver also answers for internal zones.
 */
export const dnsServers = listFromEnv('DNS_SERVERS');
const invalidDnsServer = dnsServers.find(server => !isIP(server));
if (invalidDnsServer) {
    throw new Error(`Invalid value for DNS_SERVERS: "${invalidDnsServer}" is not an IP address`);
}

export const maxBodyBytes = intFromEnv('MAX_BODY_BYTES', 16 * 1024);
export const maxUploadBytes = intFromEnv('MAX_UPLOAD_BYTES', 64 * 1024);

export const dnsTimeoutMs = intFromEnv('DNS_TIMEOUT_MS', 5_000);
export const pingTimeoutSeconds = Math.max(1, intFromEnv('PING_TIMEOUT_SECONDS', 2));
export const whoisTimeoutMs = intFromEnv('WHOIS_TIMEOUT_MS', 10_000);
export const maxWhoisResponseBytes = Math.max(1, intFromEnv('MAX_WHOIS_RESPONSE_BYTES', 128 * 1024));
export const rdapTimeoutMs = intFromEnv('RDAP_TIMEOUT_MS', 5_000);
export const maxRdapResponseBytes = Math.max(1, intFromEnv('MAX_RDAP_RESPONSE_BYTES', 256 * 1024));
