// Internal
import * as config from '../config/global.config';
import { errorMessage } from '../utils/async';
import { getJson, JsonResponse } from './http-client';
import type { RdapResult } from './schemas';

/** IANA's bootstrap registry mapping TLDs to RDAP servers (RFC 9224). */
export const RDAP_BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
const BOOTSTRAP_TTL_MS = 24 * 60 * 60 * 1000;
const BOOTSTRAP_RETRY_MS = 5 * 60 * 1000;
const RDAP_ACCEPT = 'application/rdap+json, application/json';

export type FetchJson = (url: string) => Promise<JsonResponse>;

const defaultFetch: FetchJson = url => getJson(url, {
    timeoutMs: config.rdapTimeoutMs,
    maxBytes: config.maxRdapResponseBytes,
    accept: RDAP_ACCEPT
});

/** TLD -> HTTPS RDAP base URL. */
export type RdapBootstrap = Map<string, string>;

/** Builds the TLD map from IANA's bootstrap file, keeping only HTTPS servers. */
export function parseBootstrap(body: unknown): RdapBootstrap {
    const services = (body as { services?: unknown })?.services;
    if (!Array.isArray(services)) {
        throw new Error('invalid RDAP bootstrap file');
    }
    const map: RdapBootstrap = new Map();
    for (const service of services) {
        if (!Array.isArray(service) || !Array.isArray(service[0]) || !Array.isArray(service[1])) {
            continue;
        }
        const base = (service[1] as unknown[]).find((url): url is string => typeof url === 'string' && url.startsWith('https://'));
        if (!base) {
            continue;
        }
        for (const tld of service[0] as unknown[]) {
            if (typeof tld === 'string') {
                map.set(tld.toLowerCase(), base.endsWith('/') ? base : `${base}/`);
            }
        }
    }
    return map;
}

/** Finds the RDAP base URL for a domain by its longest matching suffix. */
export function findRdapBase(domain: string, bootstrap: RdapBootstrap): string | undefined {
    for (let suffix = domain; suffix; suffix = suffix.replace(/^[^.]*\.?/, '')) {
        const base = bootstrap.get(suffix);
        if (base) {
            return base;
        }
    }
    return undefined;
}

interface RdapEntity {
    roles?: unknown;
    vcardArray?: unknown;
    publicIds?: Array<{ type?: unknown, identifier?: unknown }>;
}

function vcardName(entity: RdapEntity): string | undefined {
    const properties = Array.isArray(entity.vcardArray) ? entity.vcardArray[1] : undefined;
    if (!Array.isArray(properties)) {
        return undefined;
    }
    const fn = properties.find(property => Array.isArray(property) && property[0] === 'fn');
    return typeof fn?.[3] === 'string' ? fn[3] : undefined;
}

/** Extracts the fields NameInsight reports from an RDAP domain object. Unknown shapes yield empty fields. */
export function parseRdapDomain(body: unknown): Omit<RdapResult, 'registered' | 'server'> {
    const domain = (body ?? {}) as {
        status?: unknown, events?: unknown, entities?: unknown, nameservers?: unknown, secureDNS?: { delegationSigned?: unknown }
    };
    const result: Omit<RdapResult, 'registered' | 'server'> = {};

    if (Array.isArray(domain.status)) {
        result.status = domain.status.filter((status): status is string => typeof status === 'string');
    }
    if (Array.isArray(domain.events)) {
        const eventDate = (action: string) => {
            const event = (domain.events as Array<{ eventAction?: unknown, eventDate?: unknown }>)
                .find(item => item?.eventAction === action);
            return typeof event?.eventDate === 'string' ? event.eventDate : undefined;
        };
        result.created = eventDate('registration');
        result.expires = eventDate('expiration');
        result.updated = eventDate('last changed');
    }
    if (Array.isArray(domain.entities)) {
        const registrar = (domain.entities as RdapEntity[])
            .find(entity => Array.isArray(entity?.roles) && entity.roles.includes('registrar'));
        if (registrar) {
            result.registrar = vcardName(registrar);
            const ianaId = registrar.publicIds?.find(id => typeof id?.identifier === 'string');
            result.registrarIanaId = ianaId?.identifier as string | undefined;
        }
    }
    if (Array.isArray(domain.nameservers)) {
        result.nameservers = (domain.nameservers as Array<{ ldhName?: unknown }>)
            .map(nameserver => nameserver?.ldhName)
            .filter((name): name is string => typeof name === 'string')
            .map(name => name.toLowerCase());
    }
    if (typeof domain.secureDNS?.delegationSigned === 'boolean') {
        result.dnssec = domain.secureDNS.delegationSigned;
    }

    // drop keys whose value is undefined so responses stay compact
    return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined));
}

/**
 * RDAP client with a cached IANA bootstrap. Never throws for lookup failures; they are reported in `error`.
 */
export class RdapClient {
    private bootstrap?: { map: RdapBootstrap, expires: number };
    private bootstrapFailedUntil = 0;
    private bootstrapLoading?: Promise<RdapBootstrap>;

    constructor(private readonly fetchJson: FetchJson = defaultFetch, private readonly now: () => number = Date.now) { }

    private async loadBootstrap(): Promise<RdapBootstrap> {
        if (this.bootstrap && this.bootstrap.expires > this.now()) {
            return this.bootstrap.map;
        }
        if (this.bootstrapFailedUntil > this.now()) {
            throw new Error('RDAP bootstrap recently failed');
        }
        // share one in-flight download between concurrent lookups
        this.bootstrapLoading ??= (async () => {
            try {
                const response = await this.fetchJson(RDAP_BOOTSTRAP_URL);
                if (response.status !== 200) {
                    throw new Error(`RDAP bootstrap returned HTTP ${response.status}`);
                }
                const map = parseBootstrap(response.body);
                this.bootstrap = { map, expires: this.now() + BOOTSTRAP_TTL_MS };
                return map;
            } catch (error) {
                this.bootstrapFailedUntil = this.now() + BOOTSTRAP_RETRY_MS;
                throw error;
            } finally {
                this.bootstrapLoading = undefined;
            }
        })();
        return this.bootstrapLoading;
    }

    async lookup(domain: string): Promise<RdapResult> {
        let base: string | undefined;
        try {
            base = findRdapBase(domain, await this.loadBootstrap());
        } catch (error) {
            console.warn(`RdapClient.lookup :: Bootstrap unavailable: ${errorMessage(error)}`);
            return { registered: null, error: 'RDAP lookup failed' };
        }
        if (!base) {
            return { registered: null, error: 'RDAP not available for this TLD' };
        }

        const server = new URL(base).hostname;
        try {
            const response = await this.fetchJson(`${base}domain/${encodeURIComponent(domain)}`);
            if (response.status === 404) {
                return { registered: false, server };
            }
            if (response.status === 200 && response.body && typeof response.body === 'object') {
                return { registered: true, server, ...parseRdapDomain(response.body) };
            }
            console.warn(`RdapClient.lookup :: Unexpected RDAP response for [${domain}]: HTTP ${response.status}`);
            return { registered: null, server, error: 'RDAP lookup failed' };
        } catch (error) {
            const message = errorMessage(error);
            console.warn(`RdapClient.lookup :: RDAP failed for [${domain}]: ${message}`);
            return { registered: null, server, error: /timed out/i.test(message) ? 'RDAP lookup timed out' : 'RDAP lookup failed' };
        }
    }
}

/** Shared client so the bootstrap is cached process-wide. */
export const rdapClient = new RdapClient();
