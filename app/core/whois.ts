// Public
import * as net from 'net';
import { domainToUnicode } from 'url';
import whoisServers from 'whois/servers.json';

// Internal
import * as config from '../config/global.config';
import { createResolver } from './dns';
import { isPublicAddress } from './validation';
import { errorMessage } from '../utils/async';

interface WhoisServer {
    host: string;
    query?: string;
    punycode?: boolean;
}

/** TLD -> WHOIS server table maintained by the `whois` package. */
// null = TLD has no WHOIS server; the special "_" key holds a nested table for IP lookups (unused here)
const WHOIS_SERVERS: Record<string, string | WhoisServer | { ip: WhoisServer } | null> = whoisServers;

const WHOIS_PORT = 43;
const MAX_REFERRALS = 2;

/**
 * Referral to a registrar's WHOIS server. Anchored to the start of a line so values inside other fields
 * (e.g. a registrant name containing "refer: ...") are ignored, and only the standard port is accepted.
 */
const REFERRAL_PATTERN = /^[ \t]*(?:Registrar WHOIS Server|Whois Server|ReferralServer|refer):[ \t]*(?:whois:\/\/)?([a-z0-9.-]+)(?::43)?[ \t]*\r?$/im;

/** Extracts the referral server from a WHOIS response, if it names one. */
export function extractReferral(data: string): string | undefined {
    return data.match(REFERRAL_PATTERN)?.[1]?.toLowerCase();
}

/** Finds the WHOIS server for a domain by its longest matching suffix (e.g. co.uk before uk). */
function findServer(domain: string): WhoisServer | undefined {
    for (let suffix = domain; suffix; suffix = suffix.replace(/^[^.]*\.?/, '')) {
        const entry = WHOIS_SERVERS[suffix];
        if (typeof entry === 'string') {
            return { host: entry };
        }
        if (entry && 'host' in entry) {
            return entry;
        }
    }
    return undefined;
}

/** Resolves a WHOIS server to one IPv4 address, refusing servers that resolve to any non-public address. */
export async function resolvePublicHost(host: string): Promise<string> {
    const addresses = net.isIP(host) ? [host] : await createResolver().resolve4(host);
    if (!addresses.length || !addresses.every(isPublicAddress)) {
        throw new Error(`WHOIS server ${host} resolves to a non-public address`);
    }
    return addresses[0];
}

/**
 * Sends one WHOIS query. The socket is always destroyed by the deadline, and at most `maxBytes`
 * are kept (a longer response is truncated). `port` exists for tests; lookups always use port 43.
 */
export function queryServer(ip: string, query: string, port: number = WHOIS_PORT): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let received = 0;
        let settled = false;

        const socket = net.connect({ host: ip, port });
        const finish = (error?: Error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(deadline);
            socket.destroy();
            if (error) {
                reject(error);
            } else {
                resolve(Buffer.concat(chunks).toString('utf8'));
            }
        };
        const deadline = setTimeout(() => finish(new Error('WHOIS lookup timed out')), config.whoisTimeoutMs);

        socket.on('connect', () => socket.write(query));
        socket.on('data', (chunk: Buffer) => {
            const remaining = config.maxWhoisResponseBytes - received;
            chunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk);
            received += Math.min(chunk.length, remaining);
            if (received >= config.maxWhoisResponseBytes) {
                finish();
            }
        });
        socket.on('end', () => finish());
        socket.on('close', () => finish());
        socket.on('error', error => finish(error));
    });
}

/**
 * Looks up a validated domain over WHOIS, following up to two referrals. Every server, including referral
 * targets taken from responses, must resolve to a public address and is contacted on port 43 only.
 * @returns the last non-empty response (the registrar's when the referral succeeds, otherwise the registry's)
 */
export async function whoisLookup(domain: string): Promise<string> {
    const server = findServer(domain);
    if (!server) {
        throw new Error('no WHOIS server is known for this TLD');
    }

    const answers: string[] = [];
    let host = server.host.toLowerCase();
    let query = (server.query || '$addr\r\n').replace('$addr', server.punycode === false ? domainToUnicode(domain) : domain);

    for (let hop = 0; hop <= MAX_REFERRALS; hop++) {
        try {
            const data = await queryServer(await resolvePublicHost(host), query);
            if (data.trim()) {
                answers.push(data);
            }
            const referral = extractReferral(data);
            if (!referral || referral === host) {
                break;
            }
            host = referral;
            query = `${domain}\r\n`;
        } catch (error) {
            if (!answers.length) {
                throw error;
            }
            console.warn(`WhoisClient.whoisLookup :: Referral to [${host}] failed for [${domain}], using previous response: ${errorMessage(error)}`);
            break;
        }
    }

    if (!answers.length) {
        throw new Error('empty WHOIS response');
    }
    return answers[answers.length - 1];
}
