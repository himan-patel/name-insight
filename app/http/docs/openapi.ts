// Internal
import * as config from '../../config/global.config';

/**
 * OpenAPI 3.0 spec for the NameInsight API, served by Swagger UI at /api-docs.
 * Keep this in sync with app/http/routes/domain.api.ts when endpoints change.
 */

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
        numeric_host: '104.20.23.154'
    },
    dns: { addresses: ['104.20.23.154', '172.66.147.243', '2606:4700:10::6814:179a'] },
    whois: 'Domain Name: EXAMPLE.COM\r\nRegistry Domain ID: 2336799_DOMAIN_COM-VRSN\r\n...',
    available: false,
    domain: 'example.com'
};

const errorResponse = (description: string, example: object) => ({
    description,
    content: {
        'application/json': {
            schema: { $ref: '#/components/schemas/Error' },
            example
        }
    }
});

const serverError = errorResponse(
    'Unexpected failure. Details are in the server logs.',
    { error: 'Encountered unknown error. See server logs for details.' }
);

const rateLimited = errorResponse(
    `Rate limit exceeded (${config.rateLimitMax} requests per ${config.rateLimitWindowMs / 1000}s per client IP). ` +
    'See the `RateLimit` and `RateLimit-Policy` response headers.',
    { error: 'Too many requests, please try again later.' }
);

const bulkInvalid = errorResponse('The list is empty, too long, or contains invalid domains. Nothing is looked up.', {
    error: 'One or more domains are invalid',
    details: {
        invalid: [
            { domain: '127.0.0.1', reason: 'IP addresses are not accepted; provide a domain name' },
            { domain: 'printer.local', reason: 'Reserved or internal domain names are not accepted' }
        ]
    }
});

const bulkSuccess = {
    description: 'One result per unique domain, in input order. Duplicates (after normalization) are removed.',
    content: {
        'application/json': {
            schema: { type: 'array', items: { $ref: '#/components/schemas/DomainInfo' } },
            example: [takenExample, availableExample]
        }
    }
};

export const openApiSpec = {
    openapi: '3.0.3',
    info: {
        title: config.appName,
        version: '1.0.0',
        description: [
            'Fetches domain information and estimates availability.',
            '',
            'Each domain is resolved in **DNS**, **pinged** (first public IPv4 address only) and looked up via **WHOIS**.',
            '`available` is `true` only when DNS has no A/AAAA records **and** nothing answers the ping.',
            'This is still an estimate: a registered domain with no address records looks available, so check the `whois` text to confirm.',
            '',
            '**Input rules:** public domain names only. IP addresses, `localhost`, internal suffixes (`.local`, `.internal`, `.lan`, ...)',
            'and malformed names are rejected with `400`. Internationalized names are converted to punycode.',
            'Domains that resolve to private or reserved addresses are never pinged (`probe.skipped = "non-public-address"`).',
            '',
            `**Limits:** up to ${config.maxDomainsPerRequest} domains per bulk request, ${config.lookupConcurrency} looked up at a time; ` +
            `${config.rateLimitMax} requests per ${config.rateLimitWindowMs / 1000}s per client IP.`
        ].join('\n')
    },
    servers: [{ url: '/', description: 'This server' }],
    tags: [
        { name: 'Domains', description: 'Domain lookup and availability' },
        { name: 'Operations', description: 'Health and operational endpoints' }
    ],
    paths: {
        '/healthz': {
            get: {
                tags: ['Operations'],
                summary: 'Health check',
                description: 'Returns 200 while the service is running and 503 once graceful shutdown has started. Not rate limited.',
                operationId: 'getHealth',
                responses: {
                    200: { description: 'Running', content: { 'application/json': { example: { status: 'ok' } } } },
                    503: { description: 'Shutting down', content: { 'application/json': { example: { status: 'shutting-down' } } } }
                }
            }
        },
        '/api/v1/domains/info/{domain}': {
            get: {
                tags: ['Domains'],
                summary: 'Look up a single domain',
                operationId: 'getDomainInfo',
                parameters: [{
                    name: 'domain',
                    in: 'path',
                    required: true,
                    description: 'Public domain name (not an IP address)',
                    schema: { type: 'string', maxLength: 253 },
                    example: 'example.com'
                }],
                responses: {
                    200: {
                        description: 'DNS, ping and WHOIS result for the domain',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/DomainInfo' },
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
                    429: rateLimited,
                    500: serverError
                }
            }
        },
        '/api/v1/domains/info/_payload': {
            post: {
                tags: ['Domains'],
                summary: 'Look up multiple domains from a JSON body',
                operationId: 'getDomainInfoBulkPayload',
                requestBody: {
                    required: true,
                    description: `JSON body, at most ${config.maxBodyBytes / 1024} KB`,
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/DomainsPayload' },
                            example: { domains: ['example.com', 'zzqx-unregistered-test-98123.com'] }
                        }
                    }
                },
                responses: {
                    200: bulkSuccess,
                    400: bulkInvalid,
                    413: errorResponse('Request body too large', { error: 'request entity too large' }),
                    429: rateLimited,
                    500: serverError
                }
            }
        },
        '/api/v1/domains/info/_file': {
            post: {
                tags: ['Domains'],
                summary: 'Look up multiple domains from an uploaded text file',
                description: [
                    `Upload a \`text/plain\` file (max ${config.maxUploadBytes / 1024} KB) with one domain per line.`,
                    `Blank lines and lines starting with \`#\` are ignored. At most ${config.maxDomainsPerRequest} domains.`,
                    'The file is processed in memory and never stored. No other form fields are accepted.'
                ].join(' '),
                operationId: 'getDomainInfoBulkFile',
                requestBody: {
                    required: true,
                    content: {
                        'multipart/form-data': {
                            schema: {
                                type: 'object',
                                required: ['file'],
                                properties: {
                                    file: {
                                        type: 'string',
                                        format: 'binary',
                                        description: 'Plain-text file (.txt), one domain per line'
                                    }
                                }
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
                    429: rateLimited,
                    500: serverError
                }
            }
        }
    },
    components: {
        schemas: {
            DomainsPayload: {
                type: 'object',
                required: ['domains'],
                properties: {
                    domains: {
                        type: 'array',
                        minItems: 1,
                        maxItems: config.maxDomainsPerRequest,
                        items: { type: 'string', maxLength: 253 },
                        description: 'Public domain names'
                    }
                }
            },
            DomainInfo: {
                type: 'object',
                required: ['probe', 'dns', 'whois', 'available', 'domain'],
                properties: {
                    probe: { $ref: '#/components/schemas/PingProbe' },
                    dns: { $ref: '#/components/schemas/DnsResult' },
                    whois: {
                        type: 'string',
                        nullable: true,
                        description: "Raw WHOIS text: the registrar's response, or the registry's if the registrar lookup failed. " +
                            `Truncated at ${config.maxWhoisResponseBytes / 1024} KB. null if WHOIS failed.`
                    },
                    whoisError: {
                        type: 'string',
                        enum: ['WHOIS lookup timed out', 'WHOIS lookup failed'],
                        description: 'Present only when `whois` is null'
                    },
                    available: {
                        type: 'boolean',
                        description: 'true when DNS has no A/AAAA records and nothing answers the ping (estimate, see API description)'
                    },
                    domain: { type: 'string', description: 'Normalized domain (lowercase, punycode)' }
                }
            },
            DnsResult: {
                type: 'object',
                required: ['addresses'],
                properties: {
                    addresses: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Resolved public IPv4 and IPv6 addresses. Private and reserved addresses are never listed.'
                    },
                    nonPublic: {
                        type: 'boolean',
                        description: 'Present (true) when the domain also resolved to private or reserved addresses, which are omitted'
                    },
                    error: {
                        type: 'string',
                        description: 'Present when DNS could not be queried (e.g. timeout). `available` is then false.'
                    }
                }
            },
            PingProbe: {
                type: 'object',
                description: 'Ping result from the `ping` package. Fields are `"unknown"` when no reply was received or no ping was sent.',
                properties: {
                    host: { type: 'string', description: 'The domain' },
                    alive: { type: 'boolean' },
                    output: { type: 'string', description: 'Raw ping command output' },
                    time: { oneOf: [{ type: 'number' }, { type: 'string' }], description: 'Round-trip time in ms, or "unknown"' },
                    times: { type: 'array', items: { type: 'number' } },
                    min: { type: 'string' },
                    max: { type: 'string' },
                    avg: { type: 'string' },
                    stddev: { type: 'string' },
                    packetLoss: { type: 'string' },
                    numeric_host: { type: 'string', description: 'IPv4 address that was pinged (present only when a ping was sent)' },
                    skipped: {
                        type: 'string',
                        enum: ['not-resolved', 'no-ipv4-address', 'non-public-address', 'ping-failed'],
                        description: 'Why no ping result is available (present only when no ping was sent or it failed)'
                    }
                }
            },
            Error: {
                type: 'object',
                required: ['error'],
                properties: {
                    error: { type: 'string', description: 'Human-readable message' },
                    details: { type: 'object', description: 'Extra context, e.g. the list of invalid domains' }
                }
            }
        }
    }
};
