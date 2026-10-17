// Public
import { BlockList, isIP } from 'net';
import { domainToASCII } from 'url';

// Internal
import { HttpError } from '../models/http-error';

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
 * @throws {HttpError} 400 when the input is not a valid public domain name
 */
export function normalizeDomain(input: unknown): string {
    if (typeof input !== 'string') {
        throw new HttpError(400, 'Domain must be a string');
    }

    const trimmed = input.trim().replace(/\.$/, '');
    if (trimmed.length === 0 || trimmed.length > 253) {
        throw new HttpError(400, 'Domain must be between 1 and 253 characters', { domain: input });
    }
    if (isIP(trimmed)) {
        throw new HttpError(400, 'IP addresses are not accepted; provide a domain name', { domain: input });
    }

    // Converts internationalized names to punycode; returns '' for invalid input
    const ascii = domainToASCII(trimmed.toLowerCase());
    if (!ascii || ascii.length > 253 || !DOMAIN_PATTERN.test(ascii)) {
        throw new HttpError(400, 'Invalid domain name', { domain: input });
    }

    const isReserved = RESERVED_SUFFIXES.some(suffix => ascii === suffix || ascii.endsWith(`.${suffix}`));
    if (isReserved) {
        throw new HttpError(400, 'Reserved or internal domain names are not accepted', { domain: input });
    }

    return ascii;
}

/**
 * Normalizes a list of domains, de-duplicating while keeping order.
 * @throws {HttpError} 400 listing every invalid entry, or when the list is empty or too long
 */
export function normalizeDomainList(input: unknown, maxDomains: number): string[] {
    if (!Array.isArray(input) || input.length === 0) {
        throw new HttpError(400, 'Provide a non-empty list of domains');
    }
    if (input.length > maxDomains) {
        throw new HttpError(400, `Too many domains: ${input.length} provided, maximum is ${maxDomains}`);
    }

    const domains: string[] = [];
    const invalid: { domain: unknown, reason: string }[] = [];
    for (const item of input) {
        try {
            domains.push(normalizeDomain(item));
        } catch (error) {
            invalid.push({ domain: item, reason: error instanceof HttpError ? error.message : 'Invalid domain name' });
        }
    }

    if (invalid.length) {
        throw new HttpError(400, 'One or more domains are invalid', { invalid });
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
