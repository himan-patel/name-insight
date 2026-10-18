// Public
import { request } from 'https';
import type { TLSSocket } from 'tls';

// Internal
import * as config from '../config/global.config';
import { errorMessage } from '../utils/async';
import { createResolver } from './dns';
import { publicLookup } from './http-client';
import type { Insights, WebCheck } from './schemas';

const DAY_MS = 24 * 60 * 60 * 1000;

type Resolver = ReturnType<typeof createResolver>;

/** Runs a DNS query, mapping "no such records" to an empty list and other failures to undefined. */
async function query<T>(run: () => Promise<T[]>): Promise<T[] | undefined> {
    try {
        return await run();
    } catch (error) {
        const code = (error as { code?: string }).code;
        return code === 'ENOTFOUND' || code === 'ENODATA' ? [] : undefined;
    }
}

const joinTxt = (records: string[][] | undefined) => (records ?? []).map(chunks => chunks.join(''));

/** The parts of a TLS socket the web check reads (kept narrow so it can be tested with plain objects). */
export interface TlsInfo {
    authorized: boolean;
    authorizationError?: Error | string | null;
    getPeerCertificate?(detailed?: boolean): unknown;
}

/** Builds the web-check result from a response's status, Location header and TLS socket. */
export function describeResponse(status: number | undefined, location: string | string[] | undefined, socket: TlsInfo, now: number): WebCheck {
    const result: WebCheck = { reachable: true, status };
    if (typeof location === 'string' && status && status >= 300 && status < 400) {
        result.redirect = location.slice(0, 2048);
    }
    const certificate = socket.getPeerCertificate?.() as { valid_to?: string, issuer?: { O?: string, CN?: string } } | undefined;
    if (certificate && Object.keys(certificate).length) {
        const validTo = certificate.valid_to ? Date.parse(certificate.valid_to) : NaN;
        const issuer = certificate.issuer?.O ?? certificate.issuer?.CN;
        result.tls = {
            valid: socket.authorized,
            ...(socket.authorizationError ? { error: String(socket.authorizationError) } : {}),
            ...(typeof issuer === 'string' ? { issuer } : {}),
            ...(Number.isNaN(validTo) ? {} : {
                validTo: new Date(validTo).toISOString(),
                daysRemaining: Math.floor((validTo - now) / DAY_MS)
            })
        };
    }
    return result;
}

/**
 * HEAD request to https://<domain>/ that reports the status, redirect target and TLS certificate. Connects only to a
 * public IPv4 address (pinned lookup), reads headers only, follows no redirects, and has a hard deadline.
 * Certificate verification is disabled so invalid certificates can be *reported*; nothing sensitive is sent.
 */
export function checkWebsite(domain: string, now = Date.now()): Promise<WebCheck> {
    return new Promise(resolve => {
        let settled = false;
        const finish = (result: WebCheck) => {
            if (!settled) {
                settled = true;
                clearTimeout(deadline);
                resolve(result);
            }
        };

        const req = request({
            host: domain,
            servername: domain,
            port: 443,
            method: 'HEAD',
            path: '/',
            lookup: publicLookup,
            rejectUnauthorized: false,
            headers: { 'user-agent': 'NameInsight' },
            timeout: config.webCheckTimeoutMs
        }, res => {
            const result = describeResponse(res.statusCode, res.headers.location, res.socket as TLSSocket, now);
            res.destroy();
            finish(result);
        });
        const deadline = setTimeout(() => req.destroy(new Error('timed out')), config.webCheckTimeoutMs);
        req.on('timeout', () => req.destroy(new Error('timed out')));
        req.on('error', error => {
            const message = errorMessage(error);
            finish({ reachable: false, error: /timed out/i.test(message) ? 'timed out' : (error as { code?: string }).code === 'ENOTPUBLIC' ? 'not a public address' : 'connection failed' });
        });
        req.end();
    });
}

/**
 * Optional extra signals for a domain: nameservers, email setup (MX, SPF, DMARC) and an HTTPS/TLS check.
 * Never throws; checks that fail are left out or reported in their own fields.
 */
export async function getInsights(domain: string, resolvesPublicly: boolean, resolver: Resolver = createResolver()): Promise<Insights> {
    const [ns, mx, txt, dmarcTxt, web] = await Promise.all([
        query(() => resolver.resolveNs(domain)),
        query(() => resolver.resolveMx(domain)),
        query(() => resolver.resolveTxt(domain)),
        query(() => resolver.resolveTxt(`_dmarc.${domain}`)),
        resolvesPublicly ? checkWebsite(domain) : Promise.resolve<WebCheck>({ reachable: false, error: 'no public address' })
    ]);

    const spf = joinTxt(txt).find(record => /^v=spf1(\s|$)/i.test(record));
    const dmarc = joinTxt(dmarcTxt).find(record => /^v=DMARC1(;|\s|$)/i.test(record));
    const dmarcPolicy = dmarc?.match(/(?:^|;)\s*p\s*=\s*(none|quarantine|reject)\b/i)?.[1]?.toLowerCase();

    // A "null MX" (exchange "" or ".", RFC 7505) means the domain explicitly accepts no mail
    const exchanges = (mx ?? []).sort((a, b) => a.priority - b.priority).map(record => record.exchange.toLowerCase().replace(/\.$/, ''));
    const mailServers = exchanges.filter(exchange => exchange.length > 0);
    const nullMx = exchanges.length > 0 && mailServers.length === 0;

    return {
        ...(ns ? { nameservers: ns.map(name => name.toLowerCase()).sort() } : {}),
        email: {
            mx: mailServers,
            acceptsMail: mailServers.length > 0 && !nullMx,
            spf: Boolean(spf),
            dmarc: Boolean(dmarc),
            ...(dmarcPolicy ? { dmarcPolicy: dmarcPolicy as 'none' | 'quarantine' | 'reject' } : {})
        },
        web
    };
}
