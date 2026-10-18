// Public
import { z } from 'zod';

// Internal
import * as config from '../config/global.config';

/**
 * The NameInsight data contract. These schemas are the single source of truth for request/response shapes:
 * TypeScript types are inferred from them, the OpenAPI spec is generated from them, and MCP tools use them
 * for input validation. Semantic checks (punycode, reserved names, private IPs) live in `validation.ts`.
 */

export const DomainNameSchema = z.string().min(1).max(253)
    .describe('Public domain name, e.g. example.com. IP addresses and internal names are rejected.');

export const DomainsPayloadSchema = z.object({
    domains: z.array(DomainNameSchema).min(1).max(config.maxDomainsPerRequest).describe('Public domain names')
});

export const PROBE_SKIP_REASONS = ['not-resolved', 'no-ipv4-address', 'non-public-address', 'ping-failed'] as const;
export const WHOIS_ERRORS = ['WHOIS lookup timed out', 'WHOIS lookup failed'] as const;

export const DnsResultSchema = z.object({
    addresses: z.array(z.string())
        .describe('Resolved public IPv4 and IPv6 addresses. Private and reserved addresses are never listed.'),
    nonPublic: z.boolean().optional()
        .describe('Present (true) when the domain also resolved to private or reserved addresses, which are omitted'),
    error: z.string().optional()
        .describe('Present when DNS could not be queried (e.g. timeout). `available` is then false.')
});

export const PingProbeSchema = z.object({
    host: z.string().describe('The domain'),
    alive: z.boolean(),
    output: z.string().optional().describe('Raw ping command output'),
    time: z.union([z.number(), z.literal('unknown')]).optional().describe('Round-trip time in ms, or "unknown"'),
    times: z.array(z.number()).optional(),
    min: z.string().optional(),
    max: z.string().optional(),
    avg: z.string().optional(),
    stddev: z.string().optional(),
    packetLoss: z.string().optional(),
    inputHost: z.string().optional().describe('Address passed to ping'),
    numeric_host: z.string().optional().describe('IPv4 address that was pinged (present only when a ping was sent)'),
    skipped: z.enum(PROBE_SKIP_REASONS).optional()
        .describe('Why no ping result is available (present only when no ping was sent or it failed)')
}).describe('Ping result. Fields are "unknown" when no reply was received or no ping was sent.');

export const DomainInfoSchema = z.object({
    probe: PingProbeSchema,
    dns: DnsResultSchema,
    whois: z.string().nullable()
        .describe("Raw WHOIS text: the registrar's response, or the registry's if the registrar lookup failed. Truncated at " +
            `${config.maxWhoisResponseBytes / 1024} KB. null if WHOIS failed.`),
    whoisError: z.enum(WHOIS_ERRORS).optional().describe('Present only when `whois` is null'),
    available: z.boolean()
        .describe('true when DNS has no A/AAAA records and nothing answers the ping (an estimate; see the API description)'),
    domain: z.string().describe('Normalized domain (lowercase, punycode)')
});

export const ErrorResponseSchema = z.object({
    error: z.string().describe('Human-readable message'),
    details: z.unknown().optional().describe('Extra context, e.g. the list of invalid domains')
});

export type DomainsPayload = z.infer<typeof DomainsPayloadSchema>;
export type DnsResult = z.infer<typeof DnsResultSchema>;
export type PingProbe = z.infer<typeof PingProbeSchema>;
export type ProbeSkipReason = typeof PROBE_SKIP_REASONS[number];
export type DomainInfo = z.infer<typeof DomainInfoSchema>;
