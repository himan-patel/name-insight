// Public
import { BlockList, isIP } from 'net';
import { getDomain, parse } from 'tldts';
import { domainToASCII } from 'url';

// Internal
import { ValidationError } from './errors';

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const TLD = '(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})';
const DOMAIN_PATTERN = new RegExp(`^(?:${LABEL}\\.)+${TLD}$`);

/** Special-use and private names (RFC 6761, RFC 8375, common internal suffixes) that are never public domains. */
const RESERVED_SUFFIXES = [
    'localhost', 'local', 'localdomain', 'internal', 'intranet', 'lan', 'home', 'corp', 'private',
    'test', 'invalid', 'example', 'onion', 'arpa', 'home.arpa'
];

/**
 * Normalizes and validates a public domain name. IP addresses, special-use names and anything that
 * could be read as a command-line option are rejected.
 * @returns the lowercase ASCII (punycode) form of the domain
 * @throws {ValidationError} when the input is not a valid public domain name
 */
export function normalizeDomain(input: unknown): string {
    if (typeof input !== 'string') {
        throw new ValidationError('Domain must be a string');
    }

    const trimmed = input.trim().replace(/\.$/, '');
    if (trimmed.length === 0 || trimmed.length > 253) {
        throw new ValidationError('Domain must be between 1 and 253 characters', { domain: input });
    }
    // domainToASCII silently strips tabs/newlines (WHATWG URL rules), which would look up a different name
    // eslint-disable-next-line no-control-regex -- matching control characters is the point
    if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) {
        throw new ValidationError('Invalid domain name', { domain: input });
    }
    if (isIP(trimmed)) {
        throw new ValidationError('IP addresses are not accepted; provide a domain name', { domain: input });
    }

    // Converts internationalized names to punycode; returns '' for invalid input
    const ascii = domainToASCII(trimmed.toLowerCase());
    if (!ascii || ascii.length > 253 || !DOMAIN_PATTERN.test(ascii)) {
        throw new ValidationError('Invalid domain name', { domain: input });
    }

    const isReserved = RESERVED_SUFFIXES.some(suffix => ascii === suffix || ascii.endsWith(`.${suffix}`));
    if (isReserved) {
        throw new ValidationError('Reserved or internal domain names are not accepted', { domain: input });
    }

    const parsed = parse(ascii, { allowPrivateDomains: false });
    if (!parsed.isIcann) {
        throw new ValidationError('Unknown top-level domain', { domain: input });
    }
    if (!getDomain(ascii, { allowPrivateDomains: false })) {
        throw new ValidationError('This is a public suffix (like co.uk), not a registrable domain', { domain: input });
    }

    return ascii;
}

/**
 * The domain a registrant actually registers, per the Public Suffix List (ICANN section): news.bbc.co.uk -> bbc.co.uk.
 * Registry lookups (RDAP, WHOIS) must use this; DNS, ping and web checks use the full name.
 * @param domain a name already accepted by `normalizeDomain`
 */
export function registrableDomain(domain: string): string {
    return getDomain(domain, { allowPrivateDomains: false }) ?? domain;
}

/**
 * Normalizes a list of domains, de-duplicating while keeping order.
 * @throws {ValidationError} listing every invalid entry, or when the list is empty or too long
 */
export function normalizeDomainList(input: unknown, maxDomains: number): string[] {
    if (!Array.isArray(input) || input.length === 0) {
        throw new ValidationError('Provide a non-empty list of domains');
    }
    if (input.length > maxDomains) {
        throw new ValidationError(`Too many domains: ${input.length} provided, maximum is ${maxDomains}`);
    }

    const domains: string[] = [];
    const invalid: { domain: unknown, reason: string }[] = [];
    for (const item of input) {
        try {
            domains.push(normalizeDomain(item));
        } catch (error) {
            invalid.push({ domain: item, reason: error instanceof ValidationError ? error.message : 'Invalid domain name' });
        }
    }

    if (invalid.length) {
        throw new ValidationError('One or more domains are invalid', { invalid });
    }
    return Array.from(new Set(domains));
}

/** Address ranges that must never be probed: private, loopback, link-local, CGNAT, documentation, multicast, etc. */
const NON_PUBLIC = new BlockList();
[
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
    ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
].forEach(([address, prefix]) => NON_PUBLIC.addSubnet(address as string, prefix as number, 'ipv4'));
[
    // No ::ffff:0:0/96 rule: BlockList checks IPv4-mapped addresses against the IPv4 rules above,
    // and such a rule would also match every plain IPv4 address
    // ::/96 covers ::, ::1 and deprecated IPv4-compatible addresses (::a.b.c.d)
    ['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
    ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]
].forEach(([address, prefix]) => NON_PUBLIC.addSubnet(address as string, prefix as number, 'ipv6'));

/**
 * True when `address` is a globally routable unicast IP. IPv4-mapped IPv6 addresses are checked as IPv4.
 */
export function isPublicAddress(address: string): boolean {
    const family = isIP(address);
    if (family === 0) {
        return false;
    }
    return !NON_PUBLIC.check(address, family === 4 ? 'ipv4' : 'ipv6');
}
