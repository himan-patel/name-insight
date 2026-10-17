// Public
import { isIP } from 'net';

function intFromEnv(name: string, defaultValue: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === '') {
        return defaultValue;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`Invalid value for ${name}: expected a non-negative integer, got "${raw}"`);
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
export const host = process.env.API_HOST || '0.0.0.0';
export const port = intFromEnv('API_PORT', 8080);

/** Origins allowed to call the API from a browser. Empty means cross-origin requests are not allowed. */
export const corsOrigins = listFromEnv('CORS_ORIGINS');

/** Number of reverse proxies in front of the service, so rate limiting sees the real client IP. 0 = none. */
export const trustProxyHops = intFromEnv('TRUST_PROXY_HOPS', 0);

/** Requests allowed per client IP per window on the domain endpoints. */
export const rateLimitWindowMs = intFromEnv('RATE_LIMIT_WINDOW_MS', 60_000);
export const rateLimitMax = intFromEnv('RATE_LIMIT_MAX', 30);

/** Maximum domains accepted in a single bulk request (payload or file). */
export const maxDomainsPerRequest = intFromEnv('MAX_DOMAINS_PER_REQUEST', 50);

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
