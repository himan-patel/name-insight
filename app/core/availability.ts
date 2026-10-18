// Internal
import type { ParsedWhois } from './whois-parse';
import type { Assessment, DnsResult, PingProbe, RdapResult, Registration } from './schemas';

/** Expiring within this many days counts as "expiring". */
export const EXPIRING_SOON_DAYS = 30;

/**
 * Nameserver domains run by domain-parking and for-sale marketplaces. A match suggests the domain is parked and
 * possibly for sale; it's a heuristic, not proof.
 */
export const PARKING_NAMESERVER_DOMAINS = [
    'sedoparking.com', 'parkingcrew.net', 'bodis.com', 'above.com', 'parklogic.com', 'dan.com', 'afternic.com',
    'hugedomains.com', 'namebrightdns.com', 'uniregistrymarket.link', 'domainmarket.com', 'parkpage.foundationapi.com',
    'smartname.com', 'cashparking.com', 'voodoo.com', 'dsredirection.com', 'ztomy.com'
];

/** EPP statuses meaning the domain is being deleted and may soon be released. */
const DELETION_STATUSES = ['redemption period', 'pending delete', 'pending restore'];

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AssessmentInput {
    rdap: RdapResult;
    whois: ParsedWhois;
    dns: DnsResult;
    probe: PingProbe;
    now?: number;
}

function parkingProvider(nameservers: string[] | undefined): string | undefined {
    for (const nameserver of nameservers ?? []) {
        const provider = PARKING_NAMESERVER_DOMAINS.find(domain => nameserver === domain || nameserver.endsWith(`.${domain}`));
        if (provider) {
            return provider;
        }
    }
    return undefined;
}

function daysBetween(fromIso: string | undefined, toMs: number): number | undefined {
    if (!fromIso) {
        return undefined;
    }
    const time = Date.parse(fromIso);
    return Number.isNaN(time) ? undefined : Math.floor((toMs - time) / DAY_MS);
}

/** Combines registry data (RDAP, then WHOIS) and network signals into one registration record. */
export function buildRegistration(input: AssessmentInput, now: number): Registration {
    const { rdap, whois } = input;
    let registration: Registration;
    if (rdap.registered !== null) {
        registration = {
            source: 'rdap', registered: rdap.registered, created: rdap.created, expires: rdap.expires,
            registrar: rdap.registrar, status: rdap.status, nameservers: rdap.nameservers
        };
    } else if (whois.registered !== null) {
        registration = {
            source: 'whois', registered: whois.registered, created: whois.created, expires: whois.expires,
            registrar: whois.registrar, status: whois.status, nameservers: whois.nameservers
        };
    } else {
        registration = { source: 'none', registered: null };
    }

    const age = daysBetween(registration.created, now);
    const untilExpiry = registration.expires ? daysBetween(new Date(now).toISOString(), Date.parse(registration.expires)) : undefined;
    if (age !== undefined) {
        registration.ageDays = age;
    }
    if (untilExpiry !== undefined) {
        registration.daysUntilExpiry = untilExpiry;
    }
    return Object.fromEntries(Object.entries(registration).filter(([, value]) => value !== undefined)) as Registration;
}

/**
 * Decides a domain's status. Registry answers (RDAP, then parsed WHOIS) are authoritative ("high" confidence);
 * without them, DNS records imply registration ("medium") and silence implies availability ("low").
 */
export function assessAvailability(input: AssessmentInput): Assessment {
    const now = input.now ?? Date.now();
    const registration = buildRegistration(input, now);
    const reasons: string[] = [];
    const source = registration.source === 'rdap' ? 'Registry (RDAP)' : 'WHOIS';

    if (registration.registered === false) {
        reasons.push(`${source} reports the domain is not registered`);
        return { status: 'available', confidence: 'high', registration, reasons };
    }

    const hasNetworkPresence = input.dns.addresses.length > 0 || Boolean(input.dns.nonPublic) || input.probe.alive;

    if (registration.registered === true) {
        reasons.push(`${source} reports the domain is registered${registration.registrar ? ` (registrar: ${registration.registrar})` : ''}`);
    } else if (hasNetworkPresence) {
        reasons.push('No registry data, but the domain has DNS records, so it is registered');
    } else if (input.dns.error) {
        reasons.push('No registry data and DNS could not be queried');
        return { status: 'unknown', confidence: 'low', registration, reasons };
    } else {
        reasons.push('No registry data; DNS has no records and nothing answered ping (estimate)');
        return { status: 'available', confidence: 'low', registration, reasons };
    }

    const confidence = registration.registered === true ? 'high' : 'medium';
    const deletion = registration.status?.find(status => DELETION_STATUSES.includes(status));
    if (deletion) {
        reasons.push(`Registry status "${deletion}": the domain is being deleted and may be released soon`);
        return { status: 'expiring', confidence, registration, reasons };
    }
    if (registration.daysUntilExpiry !== undefined && registration.daysUntilExpiry <= EXPIRING_SOON_DAYS) {
        reasons.push(registration.daysUntilExpiry < 0
            ? `Expired ${-registration.daysUntilExpiry} days ago (may be in a grace period)`
            : `Expires in ${registration.daysUntilExpiry} days`);
        return { status: 'expiring', confidence, registration, reasons };
    }
    const provider = parkingProvider(registration.nameservers);
    if (provider) {
        reasons.push(`Nameservers point to a parking/marketplace service (${provider}); it may be for sale`);
        return { status: 'parked', confidence, registration, reasons };
    }
    return { status: 'registered', confidence, registration, reasons };
}
