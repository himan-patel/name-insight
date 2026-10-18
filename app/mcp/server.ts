// Public
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

// Internal
import * as config from '../config/global.config';
import {
    DnsResultSchema, DomainInfo, DomainNameSchema, DomainService, InsightsSchema, normalizeDomain, normalizeDomainList,
    RegistrationSchema, ValidationError, DOMAIN_STATUSES, CONFIDENCE_LEVELS
} from '../core';
import { errorMessage } from '../utils/async';
import { version } from './version';

/** TLDs checked by check_name_across_tlds when none are given. */
export const DEFAULT_TLDS = ['com', 'net', 'org', 'io', 'ai', 'dev', 'app', 'co'];
const MAX_TLDS = 20;

/** A compact, model-friendly result: no raw WHOIS text or ping output unless asked for. */
export const McpDomainResultSchema = z.object({
    domain: z.string(),
    registrableDomain: z.string(),
    status: z.enum(DOMAIN_STATUSES),
    confidence: z.enum(CONFIDENCE_LEVELS),
    available: z.boolean(),
    reasons: z.array(z.string()),
    registration: RegistrationSchema,
    dns: DnsResultSchema,
    ping: z.object({ alive: z.boolean(), timeMs: z.number().optional(), skipped: z.string().optional() }),
    insights: InsightsSchema.optional(),
    whois: z.string().nullable().optional().describe('Raw WHOIS text (only when include_raw_whois is true)')
});
export type McpDomainResult = z.infer<typeof McpDomainResultSchema>;

const TldSweepRowSchema = McpDomainResultSchema.pick({ domain: true, status: true, confidence: true, available: true }).extend({
    expires: z.string().optional(),
    reason: z.string().optional()
});

function compact(info: DomainInfo, includeRawWhois: boolean): McpDomainResult {
    return {
        domain: info.domain,
        registrableDomain: info.registrableDomain,
        status: info.status,
        confidence: info.confidence,
        available: info.available,
        reasons: info.reasons,
        registration: info.registration,
        dns: info.dns,
        ping: {
            alive: info.probe.alive,
            ...(typeof info.probe.time === 'number' ? { timeMs: info.probe.time } : {}),
            ...(info.probe.skipped ? { skipped: info.probe.skipped } : {})
        },
        ...(info.insights ? { insights: info.insights } : {}),
        ...(includeRawWhois ? { whois: info.whois } : {})
    };
}

function summaryLine(result: { domain: string, status: string, confidence: string, reasons?: string[], reason?: string }): string {
    const reason = result.reasons?.[result.reasons.length - 1] ?? result.reason;
    return `${result.domain}: ${result.status} (${result.confidence} confidence)${reason ? `. ${reason}` : ''}`;
}

/** Tool result carrying both a readable summary and the structured payload. */
function ok<T extends Record<string, unknown>>(summary: string, structured: T): CallToolResult & { structuredContent: T } {
    return { content: [{ type: 'text', text: summary }], structuredContent: structured };
}

/** Invalid input comes back as a tool error the model can read and correct, not a protocol error. */
function toolError(error: unknown): CallToolResult {
    if (error instanceof ValidationError) {
        const details = error.details ? ` ${JSON.stringify(error.details)}` : '';
        return { isError: true, content: [{ type: 'text', text: `${error.message}${details}` }] };
    }
    console.error('McpServer :: Unexpected tool error', errorMessage(error));
    return { isError: true, content: [{ type: 'text', text: 'Lookup failed unexpectedly. Please try again.' }] };
}

const readOnlyAnnotations = { readOnlyHint: true, idempotentHint: true, openWorldHint: true } as const;

/**
 * Builds the NameInsight MCP server. Transport-agnostic: connect it to stdio (local clients) or Streamable HTTP.
 */
export function createMcpServer(service: DomainService = new DomainService()): McpServer {
    const server = new McpServer(
        { name: 'nameinsight', title: config.appName, version },
        {
            instructions: 'NameInsight checks whether domain names are available to register and explains why. ' +
                'Use check_name_across_tlds to compare one name across extensions, check_domains for a list, and ' +
                'check_domain (with insights=true) for details such as email setup and TLS. Each result has a status ' +
                '(available, registered, parked, expiring, unknown) and a confidence level; prefer high-confidence results.'
        }
    );

    server.registerTool('check_domain', {
        title: 'Check a domain',
        description: 'Checks one domain name: registration status (from the registry via RDAP or WHOIS), expiry, registrar, ' +
            'DNS and reachability. Set insights=true for nameservers, email setup (MX/SPF/DMARC) and an HTTPS/TLS check.',
        inputSchema: {
            domain: DomainNameSchema,
            insights: z.boolean().default(false).describe('Include nameservers, email setup and HTTPS/TLS details (slower)'),
            include_raw_whois: z.boolean().default(false).describe('Include the raw WHOIS text (can be long)')
        },
        outputSchema: McpDomainResultSchema,
        annotations: readOnlyAnnotations
    }, async ({ domain, insights, include_raw_whois }) => {
        try {
            const info = await service.getDomainInfo(normalizeDomain(domain), { insights });
            const result = compact(info, include_raw_whois);
            return ok(summaryLine(result), result);
        } catch (error) {
            return toolError(error);
        }
    });

    server.registerTool('check_domains', {
        title: 'Check several domains',
        description: `Checks up to ${config.maxDomainsPerRequest} domain names at once and returns one result per unique name, in order.`,
        inputSchema: {
            domains: z.array(DomainNameSchema).min(1).max(config.maxDomainsPerRequest),
            insights: z.boolean().default(false).describe('Include nameservers, email setup and HTTPS/TLS details (slower)')
        },
        outputSchema: { results: z.array(McpDomainResultSchema) },
        annotations: readOnlyAnnotations
    }, async ({ domains, insights }) => {
        try {
            const infos = await service.getDomainInfoBulk(normalizeDomainList(domains, config.maxDomainsPerRequest), { insights });
            const results = infos.map(info => compact(info, false));
            return ok(results.map(summaryLine).join('\n'), { results });
        } catch (error) {
            return toolError(error);
        }
    });

    server.registerTool('check_name_across_tlds', {
        title: 'Check a name across TLDs',
        description: 'Checks one name (without extension, e.g. "nameinsight") across several TLDs and lists which are available. ' +
            `Defaults to ${DEFAULT_TLDS.map(tld => `.${tld}`).join(', ')}.`,
        inputSchema: {
            name: z.string().min(1).max(63).describe('The name without a TLD, e.g. "nameinsight"'),
            tlds: z.array(z.string().min(2).max(63)).min(1).max(MAX_TLDS).optional()
                .describe('TLDs to check, without the dot, e.g. ["com", "io", "co.uk"]')
        },
        outputSchema: {
            name: z.string(),
            available: z.array(z.string()).describe('Domains reported available'),
            results: z.array(TldSweepRowSchema)
        },
        annotations: readOnlyAnnotations
    }, async ({ name, tlds }) => {
        try {
            const label = name.trim().toLowerCase();
            if (label.includes('.')) {
                throw new ValidationError('Give the name without a TLD, e.g. "nameinsight" rather than "nameinsight.com"', { name });
            }
            const suffixes = [...new Set((tlds ?? DEFAULT_TLDS).map(tld => tld.trim().toLowerCase().replace(/^\./, '')))];
            const domains = normalizeDomainList(suffixes.map(tld => `${label}.${tld}`), MAX_TLDS);
            const infos = await service.getDomainInfoBulk(domains);
            const results = infos.map(info => ({
                domain: info.domain,
                status: info.status,
                confidence: info.confidence,
                available: info.available,
                ...(info.registration.expires ? { expires: info.registration.expires } : {}),
                reason: info.reasons[info.reasons.length - 1]
            }));
            const available = results.filter(result => result.available).map(result => result.domain);
            const summary = `${label}: ${available.length ? `available as ${available.join(', ')}` : 'not available on the checked TLDs'}\n` +
                results.map(summaryLine).join('\n');
            return ok(summary, { name: label, available, results });
        } catch (error) {
            return toolError(error);
        }
    });

    return server;
}
