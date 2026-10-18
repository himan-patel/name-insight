import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { fakeResolver, FakeRecords } from './helpers/fake-dns';

let records: FakeRecords = {};
jest.mock('../app/core/dns', () => ({ createResolver: () => fakeResolver(records) }));
jest.mock('../app/core/whois', () => ({
    whoisLookup: jest.fn(async (domain: string) =>
        domain.startsWith('free') ? `No match for domain "${domain.toUpperCase()}".` : `Domain Name: ${domain.toUpperCase()}\nRegistrar: Example Registrar\nRegistry Expiry Date: 2030-01-01T00:00:00Z`)
}));
jest.mock('ping', () => ({ promise: { probe: jest.fn(async (host: string) => ({ host, alive: true, time: 12, output: 'PING raw output' })) } }));

import * as pkg from '../package.json';
import { createMcpServer, DEFAULT_TLDS, McpDomainResultSchema } from '../app/mcp/server';
import { version } from '../app/mcp/version';

async function connect() {
    const server = createMcpServer();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return { client, server };
}

const text = (result: CallToolResult) => (result.content[0] as { type: 'text', text: string }).text;

let client: Client;
let close: () => Promise<void>;

beforeEach(async () => {
    records = { 'example.com': { a: ['93.184.216.34'] } };
    const connection = await connect();
    client = connection.client;
    close = () => connection.client.close();
});
afterEach(() => close());

describe('MCP server', () => {
    it('identifies itself and reports the package version', async () => {
        expect(client.getServerVersion()).toMatchObject({ name: 'nameinsight', version: pkg.version });
        expect(version).toBe(pkg.version);
        expect(client.getInstructions()).toMatch(/check_name_across_tlds/);
    });

    it('lists three read-only tools with input and output schemas', async () => {
        const { tools } = await client.listTools();
        expect(tools.map(tool => tool.name).sort()).toEqual(['check_domain', 'check_domains', 'check_name_across_tlds']);
        for (const tool of tools) {
            expect(tool.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, openWorldHint: true });
            expect(tool.inputSchema.type).toBe('object');
            expect(tool.outputSchema?.type).toBe('object');
        }
    });

    describe('check_domain', () => {
        it('returns a summary and a compact structured result (no raw WHOIS or ping output)', async () => {
            const result = await client.callTool({ name: 'check_domain', arguments: { domain: 'Example.COM' } }) as CallToolResult;
            expect(result.isError).toBeFalsy();
            expect(text(result)).toMatch(/^example\.com: registered \(high confidence\)/);

            const structured = McpDomainResultSchema.parse(result.structuredContent);
            expect(structured).toMatchObject({ domain: 'example.com', status: 'registered', available: false, ping: { alive: true, timeMs: 12 } });
            expect(structured.registration).toMatchObject({ source: 'whois', registrar: 'Example Registrar' });
            expect(structured.whois).toBeUndefined();
            expect(JSON.stringify(result)).not.toContain('PING raw output');
        });

        it('includes raw WHOIS text only on request', async () => {
            const result = await client.callTool({ name: 'check_domain', arguments: { domain: 'example.com', include_raw_whois: true } }) as CallToolResult;
            expect((result.structuredContent as { whois: string }).whois).toContain('Domain Name: EXAMPLE.COM');
        });

        it.each([
            ['an IP address', '10.0.0.1', 'IP addresses are not accepted'],
            ['an internal name', 'db.internal', 'Reserved or internal domain names are not accepted'],
            ['a public suffix', 'co.uk', 'public suffix']
        ])('returns a readable tool error for %s', async (_, domain, message) => {
            const result = await client.callTool({ name: 'check_domain', arguments: { domain } }) as CallToolResult;
            expect(result.isError).toBe(true);
            expect(text(result)).toContain(message);
        });

        it('rejects arguments that break the input schema', async () => {
            const result = await client.callTool({ name: 'check_domain', arguments: { domain: 42 } }) as CallToolResult;
            expect(result.isError).toBe(true);
        });
    });

    describe('check_domains', () => {
        it('checks each unique domain in order', async () => {
            const result = await client.callTool({ name: 'check_domains', arguments: { domains: ['example.com', 'free-one.com', 'EXAMPLE.com'] } }) as CallToolResult;
            const { results } = result.structuredContent as { results: Array<{ domain: string, status: string }> };
            expect(results.map(r => [r.domain, r.status])).toEqual([['example.com', 'registered'], ['free-one.com', 'available']]);
            expect(text(result).split('\n')).toHaveLength(2);
        });

        it('reports every invalid entry', async () => {
            const result = await client.callTool({ name: 'check_domains', arguments: { domains: ['example.com', '127.0.0.1'] } }) as CallToolResult;
            expect(result.isError).toBe(true);
            expect(text(result)).toContain('One or more domains are invalid');
        });
    });

    describe('check_name_across_tlds', () => {
        it('checks the default TLDs and lists the available ones', async () => {
            const result = await client.callTool({ name: 'check_name_across_tlds', arguments: { name: 'freebrand' } }) as CallToolResult;
            const structured = result.structuredContent as { name: string, available: string[], results: Array<{ domain: string }> };
            expect(structured.results.map(r => r.domain)).toEqual(DEFAULT_TLDS.map(tld => `freebrand.${tld}`));
            expect(structured.available).toHaveLength(DEFAULT_TLDS.length);
            expect(text(result)).toMatch(/^freebrand: available as freebrand\.com/);
        });

        it('accepts custom TLDs, with or without a leading dot, including multi-label suffixes', async () => {
            const result = await client.callTool({ name: 'check_name_across_tlds', arguments: { name: 'Example', tlds: ['.com', 'co.uk', 'com'] } }) as CallToolResult;
            const structured = result.structuredContent as { results: Array<{ domain: string, status: string, expires?: string }> };
            expect(structured.results.map(r => r.domain)).toEqual(['example.com', 'example.co.uk']);
            expect(structured.results[0]).toMatchObject({ status: 'registered', expires: '2030-01-01T00:00:00.000Z' });
        });

        it('rejects a name that already includes a TLD', async () => {
            const result = await client.callTool({ name: 'check_name_across_tlds', arguments: { name: 'brand.com' } }) as CallToolResult;
            expect(result.isError).toBe(true);
            expect(text(result)).toContain('without a TLD');
        });

        it('rejects names that produce invalid domains', async () => {
            const result = await client.callTool({ name: 'check_name_across_tlds', arguments: { name: '-bad' } }) as CallToolResult;
            expect(result.isError).toBe(true);
        });
    });
});
