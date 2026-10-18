// Public
import type { LookupAddress, LookupOptions } from 'dns';
import { get } from 'https';
import type { IncomingMessage } from 'http';
import { isIP } from 'net';

// Internal
import { createResolver } from './dns';
import { isPublicAddress } from './validation';

export interface JsonResponse {
    status: number;
    /** Parsed JSON body, or undefined when the body is empty or not JSON. */
    body: unknown;
}

export interface GetJsonOptions {
    timeoutMs: number;
    maxBytes: number;
    accept?: string;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * DNS lookup for outbound HTTPS that only ever returns public IPv4 addresses (via our resolver, not the hosts
 * file). The connection uses exactly the address checked here, so DNS rebinding can't redirect it inward.
 */
export function publicLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
    const literal = isIP(hostname) ? Promise.resolve([hostname]) : createResolver().resolve4(hostname);
    literal.then(addresses => {
        const ipv4 = addresses.filter(address => isIP(address) === 4);
        if (!ipv4.length || !addresses.every(isPublicAddress)) {
            const error: NodeJS.ErrnoException = new Error(`${hostname} does not resolve to a public IPv4 address`);
            error.code = 'ENOTPUBLIC';
            return callback(error, '');
        }
        if (options.all) {
            return callback(null, ipv4.map(address => ({ address, family: 4 })));
        }
        callback(null, ipv4[0], 4);
    }, (error: NodeJS.ErrnoException) => callback(error, ''));
}

/** Reads a response body, destroying the stream (and resolving with what was read) once maxBytes is reached. */
export function readCapped(stream: IncomingMessage, maxBytes: number): Promise<{ data: string, truncated: boolean }> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let received = 0;
        stream.on('data', (chunk: Buffer) => {
            const remaining = maxBytes - received;
            chunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk);
            received += Math.min(chunk.length, remaining);
            if (received >= maxBytes) {
                stream.destroy();
                resolve({ data: Buffer.concat(chunks).toString('utf8'), truncated: true });
            }
        });
        stream.on('end', () => resolve({ data: Buffer.concat(chunks).toString('utf8'), truncated: false }));
        stream.on('error', reject);
    });
}

/**
 * GETs a JSON document over HTTPS only, with certificate validation, public-address pinning, a size cap and
 * a hard deadline. Redirects are not followed.
 */
export function getJson(url: string, options: GetJsonOptions): Promise<JsonResponse> {
    const target = new URL(url);
    if (target.protocol !== 'https:') {
        return Promise.reject(new Error(`Refusing non-HTTPS URL: ${target.protocol}`));
    }
    // Node skips the custom lookup for IP-literal hosts, so check those here
    const literal = target.hostname.replace(/^\[|\]$/g, '');
    if (isIP(literal) && !isPublicAddress(literal)) {
        const error: NodeJS.ErrnoException = new Error(`${literal} is not a public address`);
        error.code = 'ENOTPUBLIC';
        return Promise.reject(error);
    }

    return new Promise((resolve, reject) => {
        const request = get(target, {
            lookup: publicLookup,
            headers: { accept: options.accept ?? 'application/json', 'user-agent': 'NameInsight' },
            timeout: options.timeoutMs
        }, response => {
            readCapped(response, options.maxBytes).then(({ data, truncated }) => {
                clearTimeout(deadline);
                let body: unknown;
                if (!truncated && data.trim()) {
                    try {
                        body = JSON.parse(data);
                    } catch {
                        body = undefined;
                    }
                }
                resolve({ status: response.statusCode ?? 0, body });
            }, error => {
                clearTimeout(deadline);
                reject(error);
            });
        });
        // `timeout` above is an idle timeout; this is a hard deadline for the whole exchange
        const deadline = setTimeout(() => request.destroy(new Error('request timed out')), options.timeoutMs);
        request.on('timeout', () => request.destroy(new Error('request timed out')));
        request.on('error', error => {
            clearTimeout(deadline);
            reject(error);
        });
    });
}
