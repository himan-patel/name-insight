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

export const RDAP_ERRORS = ['RDAP not available for this TLD', 'RDAP lookup timed out', 'RDAP lookup failed'] as const;

export const RdapResultSchema = z.object({
    registered: z.boolean().nullable()
        .describe('true: the registry has the domain. false: the registry says it is not registered. null: unknown (see `error`).'),
    registrar: z.string().optional(),
    registrarIanaId: z.string().optional(),
    status: z.array(z.string()).optional().describe('EPP status values, e.g. "client transfer prohibited", "redemption period"'),
    created: z.string().optional().describe('Registration date (ISO 8601)'),
    expires: z.string().optional().describe('Expiration date (ISO 8601)'),
    updated: z.string().optional().describe('Last changed (ISO 8601)'),
    nameservers: z.array(z.string()).optional(),
    dnssec: z.boolean().optional().describe('Whether the delegation is DNSSEC-signed'),
    server: z.string().optional().describe('RDAP server that answered'),
    error: z.enum(RDAP_ERRORS).optional()
}).describe('Registration data from the registry over RDAP (the structured successor to WHOIS)');

export const WebCheckSchema = z.object({
    reachable: z.boolean().describe('Whether https://<domain>/ answered'),
    status: z.number().int().optional().describe('HTTP status of a HEAD request'),
    redirect: z.string().optional().describe('Redirect target (Location header), not followed'),
    tls: z.object({
        valid: z.boolean().describe('Certificate chain and hostname are valid'),
        error: z.string().optional().describe('Why the certificate is invalid, e.g. CERT_HAS_EXPIRED'),
        issuer: z.string().optional(),
        validTo: z.string().optional(),
        daysRemaining: z.number().int().optional()
    }).optional(),
    error: z.enum(['timed out', 'connection failed', 'not a public address', 'no public address']).optional()
});

export const InsightsSchema = z.object({
    nameservers: z.array(z.string()).optional().describe('NS records from DNS'),
    email: z.object({
        mx: z.array(z.string()).describe('Mail servers, by priority'),
        acceptsMail: z.boolean().describe('Has mail servers (false when there are none or a null MX says it accepts no mail)'),
        spf: z.boolean().describe('An SPF (v=spf1) TXT record exists'),
        dmarc: z.boolean().describe('A DMARC record exists at _dmarc.<domain>'),
        dmarcPolicy: z.enum(['none', 'quarantine', 'reject']).optional()
    }),
    web: WebCheckSchema
}).describe('Optional extra signals (request with insights=true)');

export const DOMAIN_STATUSES = ['available', 'registered', 'parked', 'expiring', 'unknown'] as const;
export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;

export const RegistrationSchema = z.object({
    source: z.enum(['rdap', 'whois', 'none']).describe('Where the registration facts came from'),
    registered: z.boolean().nullable(),
    created: z.string().optional().describe('Registration date (ISO 8601)'),
    expires: z.string().optional().describe('Expiration date (ISO 8601)'),
    registrar: z.string().optional(),
    status: z.array(z.string()).optional().describe('EPP status values'),
    nameservers: z.array(z.string()).optional(),
    ageDays: z.number().int().optional().describe('Days since registration'),
    daysUntilExpiry: z.number().int().optional().describe('Days until expiration (negative if past)')
}).describe('Consolidated registration facts: RDAP when available, otherwise parsed WHOIS');

export const AssessmentSchema = z.object({
    status: z.enum(DOMAIN_STATUSES).describe('available | registered | parked (nameservers at a parking/for-sale service) | ' +
        `expiring (expires within 30 days or is being deleted) | unknown`),
    confidence: z.enum(CONFIDENCE_LEVELS).describe('high: registry answer. medium: DNS records without registry data. ' +
        'low: estimate from the absence of DNS records and ping replies.'),
    registration: RegistrationSchema,
    reasons: z.array(z.string()).describe('Human-readable explanation of the status')
});

export const DomainInfoSchema = z.object({
    probe: PingProbeSchema,
    dns: DnsResultSchema,
    rdap: RdapResultSchema,
    whois: z.string().nullable()
        .describe("Raw WHOIS text: the registrar's response, or the registry's if the registrar lookup failed. Truncated at " +
            `${config.maxWhoisResponseBytes / 1024} KB. null if WHOIS failed.`),
    whoisError: z.enum(WHOIS_ERRORS).optional().describe('Present only when `whois` is null'),
    available: z.boolean().describe('Shorthand for status === "available" (see `confidence` for how sure it is)'),
    domain: z.string().describe('Normalized domain (lowercase, punycode)'),
    registrableDomain: z.string()
        .describe('The registered domain this name belongs to (Public Suffix List), e.g. bbc.co.uk for news.bbc.co.uk. ' +
            'Registry data and status refer to it.'),
    insights: InsightsSchema.optional(),
    ...AssessmentSchema.shape
});

export const ErrorResponseSchema = z.object({
    error: z.string().describe('Human-readable message'),
    details: z.unknown().optional().describe('Extra context, e.g. the list of invalid domains')
});

export type DomainsPayload = z.infer<typeof DomainsPayloadSchema>;
export type DnsResult = z.infer<typeof DnsResultSchema>;
export type PingProbe = z.infer<typeof PingProbeSchema>;
export type ProbeSkipReason = typeof PROBE_SKIP_REASONS[number];
export type RdapResult = z.infer<typeof RdapResultSchema>;
export type WebCheck = z.infer<typeof WebCheckSchema>;
export type Insights = z.infer<typeof InsightsSchema>;
export type DomainStatus = typeof DOMAIN_STATUSES[number];
export type Registration = z.infer<typeof RegistrationSchema>;
export type Assessment = z.infer<typeof AssessmentSchema>;
export type DomainInfo = z.infer<typeof DomainInfoSchema>;
