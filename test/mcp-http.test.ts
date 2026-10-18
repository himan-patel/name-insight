import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Server } from 'http';
import { AddressInfo } from 'net';
import request from 'supertest';

jest.mock('../app/core/dns', () => ({
    createResolver: () => ({
        resolve4: () => Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })),
        resolve6: () => Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })),
        setServers: () => undefined
    })
}));
jest.mock('../app/core/whois', () => ({ whoisLookup: jest.fn(async (d: string) => `No match for domain "${d}".`) }));
jest.mock('ping', () => ({ promise: { probe: jest.fn() } }));

/** Fresh app (and fresh budgets) with the given env. */
function appWith(env: Record<string, string>) {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
        let createApp!: typeof import('../app/http/app').createApp;
        jest.isolateModules(() => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports -- isolateModules needs a synchronous require
            ({ createApp } = require('../app/http/app'));
        });
        return createApp();
    } finally {
        process.env = saved;
    }
}

const servers: Server[] = [];
async function connect(env: Record<string, string> = {}) {
    const app = appWith({ ANTHROPIC_API_KEY: '', ...env });
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise(resolve => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const client = new Client({ name: 'http-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    return { client, app };
}
const text = (result: CallToolResult) => (result.content[0] as { text: string }).text;

afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

describe('hosted MCP endpoint (Streamable HTTP, stateless, public)', () => {
    it('serves the same tools to a real MCP client without credentials', async () => {
        const { client } = await connect();
        expect(client.getServerVersion()?.name).toBe('nameinsight');
        expect((await client.listTools()).tools.map(t => t.name).sort())
            .toEqual(['check_domain', 'check_domains', 'check_name_across_tlds', 'suggest_domains']);

        const result = await client.callTool({ name: 'check_domain', arguments: { domain: 'free-name.com' } }) as CallToolResult;
        expect(result.structuredContent).toMatchObject({ domain: 'free-name.com', status: 'available' });
        await client.close();
    });

    it('charges tool calls to the shared per-IP lookup budget', async () => {
        const { client } = await connect({ LOOKUP_BUDGET_MAX: '3', MAX_DOMAINS_PER_REQUEST: '3' });
        const first = await client.callTool({ name: 'check_domains', arguments: { domains: ['a.com', 'b.com'] } }) as CallToolResult;
        expect(first.isError).toBeFalsy();
        const second = await client.callTool({ name: 'check_domains', arguments: { domains: ['c.com', 'd.com'] } }) as CallToolResult;
        expect(second.isError).toBe(true);
        expect(text(second)).toMatch(/^Lookup budget exceeded: 2 requested, 1 of 3 remaining .*\(retry in \d+s\)$/);
        await client.close();
    });

    it('explains that hosted suggestions need a server key (stateless requests cannot sample)', async () => {
        const { client } = await connect();
        const result = await client.callTool({ name: 'suggest_domains', arguments: { description: 'coffee' } }) as CallToolResult;
        expect(result.isError).toBe(true);
        expect(text(result)).toContain('does not support sampling');
        await client.close();
    });

    it('limits suggestion calls per IP', async () => {
        const { client } = await connect({ SUGGEST_RATE_LIMIT_MAX: '1' });
        await client.callTool({ name: 'suggest_domains', arguments: { description: 'coffee' } });
        const result = await client.callTool({ name: 'suggest_domains', arguments: { description: 'tea' } }) as CallToolResult;
        expect(text(result)).toMatch(/^Too many suggestion requests/);
        await client.close();
    });

    it('rejects GET and DELETE with 405 (stateless, POST only)', async () => {
        const app = appWith({});
        const get = await request(app).get('/mcp').expect(405);
        expect(get.headers.allow).toBe('POST');
        expect(get.body.error.message).toMatch(/only accepts POST/);
        await request(app).delete('/mcp').expect(405);
    });

    it('shares one per-IP request limit between /api and /mcp', async () => {
        const app = appWith({ RATE_LIMIT_MAX: '2' });
        await request(app).get('/api/v1/domains/info/a.com').expect(200);
        await request(app).get('/api/v1/domains/info/b.com').expect(200);
        const limited = await request(app).post('/mcp').set('Accept', 'application/json, text/event-stream')
            .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' }).expect(429);
        expect(limited.body).toEqual({ jsonrpc: '2.0', error: { code: -32000, message: 'Too many requests, please try again later.' }, id: null });
    });

    it('enforces allowed Host headers when MCP_ALLOWED_HOSTS is set (DNS-rebinding protection)', async () => {
        const app = appWith({ MCP_ALLOWED_HOSTS: 'mcp.nameinsight.example' });
        const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
        const blocked = await request(app).post('/mcp').set('Host', 'evil.example').set('Accept', 'application/json, text/event-stream').send(init);
        expect(blocked.status).toBe(403);
        const allowed = await request(app).post('/mcp').set('Host', 'mcp.nameinsight.example').set('Accept', 'application/json, text/event-stream').send(init);
        expect(allowed.status).toBe(200);
    });
});
