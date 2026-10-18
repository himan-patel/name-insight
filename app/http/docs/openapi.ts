// Public
import { OpenApiGeneratorV3, OpenAPIRegistry, ResponseConfig } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

// Internal
import * as config from '../../config/global.config';
import { DomainInfoSchema, DomainNameSchema, DomainsPayloadSchema, ErrorResponseSchema } from '../../core';

/**
 * OpenAPI 3.0 spec for the NameInsight API, served by Swagger UI at /api-docs.
 * Request and response schemas are generated from the zod contract in app/core/schemas.ts; this file adds
 * paths, descriptions and examples. Keep paths in sync with app/http/routes when endpoints change.
 */

const registry = new OpenAPIRegistry();
// `.meta({ id })` names a schema so it is emitted once under components/schemas and referenced by $ref
const DomainInfo = DomainInfoSchema.meta({ id: 'DomainInfo' });
const ErrorResponse = ErrorResponseSchema.meta({ id: 'Error' });
const DomainsPayload = DomainsPayloadSchema.meta({ id: 'DomainsPayload' });

const availableExample = {
    probe: {
        host: 'zzqx-unregistered-test-98123.com',
        alive: false,
        output: '',
        time: 'unknown',
        times: [],
        min: 'unknown',
        max: 'unknown',
        avg: 'unknown',
        stddev: 'unknown',
        packetLoss: 'unknown',
        skipped: 'not-resolved'
    },
    dns: { addresses: [] },
    rdap: { registered: false, server: 'rdap.verisign.com' },
    whois: 'No match for domain "ZZQX-UNREGISTERED-TEST-98123.COM".\r\n>>> Last update of whois database: 2026-10-17T18:51:41Z <<<\r\n...',
    available: true,
    domain: 'zzqx-unregistered-test-98123.com'
};

const takenExample = {
    probe: {
        host: 'example.com',
        alive: true,
        output: 'PING 104.20.23.154 (104.20.23.154): 56 data bytes\n64 bytes from 104.20.23.154: icmp_seq=0 ttl=52 time=38.938 ms\n...',
        time: 38.938,
        times: [38.938],
        min: '38.938',
        max: '38.938',
        avg: '38.938',
        stddev: '0.000',
        packetLoss: '0.000',
        inputHost: '104.20.23.154',
        numeric_host: '104.20.23.154'
    },
    dns: { addresses: ['104.20.23.154', '172.66.147.243', '2606:4700:10::6814:179a'] },
    rdap: {
        registered: true,
        server: 'rdap.verisign.com',
        status: ['client delete prohibited', 'client transfer prohibited', 'client update prohibited'],
        created: '1995-08-14T04:00:00Z',
        expires: '2027-08-13T04:00:00Z',
        updated: '2026-08-14T08:01:43Z',
        registrar: 'RESERVED-Internet Assigned Numbers Authority',
        registrarIanaId: '376',
        nameservers: ['elliott.ns.cloudflare.com', 'hera.ns.cloudflare.com'],
        dnssec: true
    },
    whois: 'Domain Name: EXAMPLE.COM\r\nRegistry Domain ID: 2336799_DOMAIN_COM-VRSN\r\n...',
    available: false,
    domain: 'example.com'
};

/** The examples are checked against the schemas in the test suite. */
export const examples = { availableExample, takenExample };

/** Security requirements and 401 docs apply only when API keys are configured (API_KEYS_SHA256). */
const authEnabled = config.apiKeyHashes.length > 0;
registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    description: 'API key sent as `Authorization: Bearer <key>` (generate with `npm run generate-api-key`)'
});
registry.registerComponent('securitySchemes', 'apiKeyHeader', {
    type: 'apiKey',
    in: 'header',
    name: 'X-API-Key',
    description: 'API key sent in the X-API-Key header'
});
const security: Record<string, string[]>[] = [{ bearerAuth: [] }, { apiKeyHeader: [] }];
const secured = authEnabled ? { security } : {};

const errorResponse = (description: string, example: object): ResponseConfig => ({
    description,
    content: { 'application/json': { schema: ErrorResponse, example } }
});

const serverError = errorResponse(
    'Unexpected failure. Details are in the server logs.',
    { error: 'Encountered unknown error. See server logs for details.' }
);

const rateLimited = errorResponse(
    `Too many requests (${config.rateLimitMax} per ${config.rateLimitWindowMs / 1000}s per client; see the \`RateLimit\` ` +
    `headers), or lookup budget exceeded (${config.lookupBudgetMax} domains per ${config.lookupBudgetWindowMs / 1000}s per ` +
    'client; see `Retry-After`). Clients are identified by API key, or by IP when unauthenticated.',
    { error: 'Too many requests, please try again later.' }
);

const unauthorized = errorResponse('Missing or invalid API key', { error: 'Missing or invalid API key' });
const authResponses: Record<string, ResponseConfig> = authEnabled ? { 401: unauthorized } : {};

const bulkInvalid = errorResponse('The list is empty, too long, or contains invalid domains. Nothing is looked up.', {
    error: 'One or more domains are invalid',
    details: {
        invalid: [
            { domain: '127.0.0.1', reason: 'IP addresses are not accepted; provide a domain name' },
            { domain: 'printer.local', reason: 'Reserved or internal domain names are not accepted' }
        ]
    }
});

const bulkSuccess: ResponseConfig = {
    description: 'One result per unique domain, in input order. Duplicates (after normalization) are removed.',
    content: { 'application/json': { schema: z.array(DomainInfo), example: [takenExample, availableExample] } }
};

const HealthSchema = z.object({ status: z.enum(['ok', 'shutting-down']) });

registry.registerPath({
    method: 'get',
    path: '/healthz',
    tags: ['Operations'],
    summary: 'Health check',
    description: 'Returns 200 while the service is running and 503 once graceful shutdown has started. Not rate limited.',
    operationId: 'getHealth',
    responses: {
        200: { description: 'Running', content: { 'application/json': { schema: HealthSchema, example: { status: 'ok' } } } },
        503: { description: 'Shutting down', content: { 'application/json': { schema: HealthSchema, example: { status: 'shutting-down' } } } }
    }
});

registry.registerPath({
    method: 'get',
    path: '/api/v1/domains/info/{domain}',
    tags: ['Domains'],
    summary: 'Look up a single domain',
    operationId: 'getDomainInfo',
    ...secured,
    request: { params: z.object({ domain: DomainNameSchema.meta({ example: 'example.com' }) }) },
    responses: {
        200: {
            description: 'DNS, ping and WHOIS result for the domain',
            content: {
                'application/json': {
                    schema: DomainInfo,
                    examples: {
                        taken: { summary: 'Domain resolves and responds (taken)', value: takenExample },
                        available: { summary: 'No DNS records, no reply (likely available)', value: availableExample }
                    }
                }
            }
        },
        400: errorResponse('Invalid, reserved or IP-address input', {
            error: 'IP addresses are not accepted; provide a domain name',
            details: { domain: '10.0.0.1' }
        }),
        ...authResponses,
        429: rateLimited,
        500: serverError
    }
});

registry.registerPath({
    method: 'post',
    path: '/api/v1/domains/info/_payload',
    tags: ['Domains'],
    summary: 'Look up multiple domains from a JSON body',
    operationId: 'getDomainInfoBulkPayload',
    ...secured,
    request: {
        body: {
            required: true,
            description: `JSON body, at most ${config.maxBodyBytes / 1024} KB`,
            content: {
                'application/json': {
                    schema: DomainsPayload,
                    example: { domains: ['example.com', 'zzqx-unregistered-test-98123.com'] }
                }
            }
        }
    },
    responses: {
        200: bulkSuccess,
        400: bulkInvalid,
        413: errorResponse('Request body too large', { error: 'request entity too large' }),
        ...authResponses,
        429: rateLimited,
        500: serverError
    }
});

registry.registerPath({
    method: 'post',
    path: '/api/v1/domains/info/_file',
    tags: ['Domains'],
    summary: 'Look up multiple domains from an uploaded text file',
    description: [
        `Upload a \`text/plain\` file (max ${config.maxUploadBytes / 1024} KB) with one domain per line.`,
        `Blank lines and lines starting with \`#\` are ignored. At most ${config.maxDomainsPerRequest} domains.`,
        'The file is processed in memory and never stored. No other form fields are accepted.'
    ].join(' '),
    operationId: 'getDomainInfoBulkFile',
    ...secured,
    request: {
        body: {
            required: true,
            content: {
                'multipart/form-data': {
                    schema: z.object({
                        file: z.string().meta({ format: 'binary', description: 'Plain-text file (.txt), one domain per line' })
                    })
                }
            }
        }
    },
    responses: {
        200: bulkSuccess,
        400: errorResponse('Missing file, wrong file type, extra form fields, or invalid domains in the file', {
            error: 'Unsupported file type [application/pdf]; upload a text/plain file'
        }),
        413: errorResponse('File too large', { error: 'Invalid upload: File too large' }),
        ...authResponses,
        429: rateLimited,
        500: serverError
    }
});

export const openApiSpec = new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: '3.0.3',
    info: {
        title: config.appName,
        version: '1.0.0',
        description: [
            'Fetches domain information and estimates availability.',
            '',
            'Each domain is resolved in **DNS**, looked up over **RDAP** (registry data) and **WHOIS**, and **pinged** (first public IPv4 only).',
            '`available` is authoritative when the registry answers over RDAP. For TLDs without RDAP it is an estimate: `true` when DNS has',
            'no A/AAAA records **and** nothing answers the ping. Check the `whois` text to confirm in that case.',
            '',
            '**Input rules:** public domain names only. IP addresses, `localhost`, internal suffixes (`.local`, `.internal`, `.lan`, ...)',
            'and malformed names are rejected with `400`. Internationalized names are converted to punycode.',
            'Domains that resolve to private or reserved addresses are never pinged (`probe.skipped = "non-public-address"`).',
            '',
            `**Limits:** up to ${config.maxDomainsPerRequest} domains per bulk request, ${config.lookupConcurrency} looked up at a time; ` +
            `${config.rateLimitMax} requests and ${config.lookupBudgetMax} domain lookups per ${config.rateLimitWindowMs / 1000}s per client.`,
            '',
            authEnabled
                ? '**Authentication:** required. Send an API key as `Authorization: Bearer <key>` or `X-API-Key: <key>` (use **Authorize** above).'
                : '**Authentication:** not configured on this server (set `API_KEYS_SHA256` to require API keys).'
        ].join('\n')
    },
    servers: [{ url: '/', description: 'This server' }],
    tags: [
        { name: 'Operations', description: 'Health and operational endpoints' },
        { name: 'Domains', description: 'Domain lookup and availability' }
    ]
});
