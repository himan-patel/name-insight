import request from 'supertest';

import { fakeResolver, FakeRecords } from './helpers/fake-dns';

let records: FakeRecords = {};
jest.mock('../app/core/dns', () => ({ createResolver: () => fakeResolver(records) }));
jest.mock('../app/core/whois', () => ({ whoisLookup: jest.fn(async (d: string) => `No match for domain "${d}".`) }));
jest.mock('ping', () => ({ promise: { probe: jest.fn() } }));

import { getInsights } from '../app/core/insights';
import { normalizeDomain } from '../app/core/validation';

const actual: typeof import('../app/core/http-client') = jest.requireActual('../app/core/http-client');

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

describe('ICANN TLDs only (M3)', () => {
    it.each(['foo.notarealtld', 'internal.zzzz', 'printer.corplan'])('rejects unknown TLD in %p', input => {
        expect(() => normalizeDomain(input)).toThrow('Unknown top-level domain');
    });

    it.each(['example.com', 'news.bbc.co.uk', 'x.dev', 'xn--mnchen-3ya.de'])('accepts %p', input => {
        expect(() => normalizeDomain(input)).not.toThrow();
    });
});

describe('insights for names resolving to private addresses (M3)', () => {
    it('reveals nothing else about them', async () => {
        records = { 'intranet.example.com': { a: ['10.0.0.9'], mx: [{ exchange: 'mail.corp.internal', priority: 1 }], ns: ['ns.corp.internal'] } };
        const insights = await getInsights('intranet.example.com', false, fakeResolver(records) as never, true);
        expect(insights).toEqual({
            email: { mx: [], acceptsMail: false, spf: false, dmarc: false },
            web: { reachable: false, error: 'no public address' },
            skipped: 'non-public-address'
        });
    });

    it('applies through the API', async () => {
        records = { 'intranet.example.com': { a: ['10.0.0.9'], mx: [{ exchange: 'mail.corp.internal', priority: 1 }] } };
        const res = await request(appWith({})).get('/api/v1/domains/info/intranet.example.com?insights=true').expect(200);
        expect(res.body.insights.skipped).toBe('non-public-address');
        expect(JSON.stringify(res.body)).not.toContain('corp.internal');
    });
});

describe('IP-literal URLs in the HTTPS client (L1)', () => {
    it.each(['https://127.0.0.1/rdap/', 'https://10.0.0.5/', 'https://[::1]/', 'https://169.254.169.254/latest'])('refuses %s before connecting', async url => {
        await expect(actual.getJson(url, { timeoutMs: 500, maxBytes: 100 })).rejects.toMatchObject({ code: 'ENOTPUBLIC' });
    });
});

describe('Host header allow-list (L4)', () => {
    it('accepts only localhost names when bound to loopback (default)', async () => {
        const app = appWith({ API_HOST: '127.0.0.1', ALLOWED_HOSTS: '', MCP_ALLOWED_HOSTS: '' });
        await request(app).get('/healthz').set('Host', 'localhost:8080').expect(200);
        await request(app).get('/healthz').set('Host', '[::1]:8080').expect(200);
        const rebound = await request(app).get('/healthz').set('Host', 'attacker.example').expect(403);
        expect(rebound.body).toEqual({ error: 'Host not allowed' });
        await request(app).post('/api/v1/domains/suggest').set('Host', 'attacker.example').send({ description: 'x' }).expect(403);
    });

    it('uses ALLOWED_HOSTS when set', async () => {
        const app = appWith({ API_HOST: '0.0.0.0', ALLOWED_HOSTS: 'nameinsight.example.com' });
        await request(app).get('/healthz').set('Host', 'nameinsight.example.com').expect(200);
        await request(app).get('/healthz').set('Host', 'other.example.com').expect(403);
    });

    it('accepts any host on a public bind without ALLOWED_HOSTS (with a startup warning)', async () => {
        const app = appWith({ API_HOST: '0.0.0.0', ALLOWED_HOSTS: '', MCP_ALLOWED_HOSTS: '' });
        await request(app).get('/healthz').set('Host', 'anything.example').expect(200);
    });
});
