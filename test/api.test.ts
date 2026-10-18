import request from 'supertest';

import { fakeResolver, FakeRecords } from './helpers/fake-dns';

let records: FakeRecords = {};
jest.mock('../app/core/dns', () => ({
    createResolver: () => fakeResolver(records)
}));
jest.mock('../app/core/whois', () => ({
    whoisLookup: jest.fn(async (domain: string) => `Domain Name: ${domain.toUpperCase()}`)
}));
jest.mock('ping', () => ({
    promise: { probe: jest.fn(async (host: string) => ({ host, alive: true, time: 10 })) }
}));

import { createApp } from '../app/http/app';

const app = createApp();
const API = '/api/v1/domains/info';

beforeEach(() => {
    records = { 'example.com': { a: ['93.184.216.34'] } };
});

describe('GET /api/v1/domains/info/:domain', () => {
    it('returns the lookup result', async () => {
        const res = await request(app).get(`${API}/example.com`).expect(200);
        expect(res.body).toMatchObject({
            domain: 'example.com',
            available: false,
            dns: { addresses: ['93.184.216.34'] },
            whois: 'Domain Name: EXAMPLE.COM',
            probe: { alive: true, numeric_host: '93.184.216.34' }
        });
    });

    it('normalizes the domain (case, trailing dot, IDN)', async () => {
        const res = await request(app).get(`${API}/M%C3%BCnchen.DE.`).expect(200);
        expect(res.body.domain).toBe('xn--mnchen-3ya.de');
    });

    it.each([
        ['IPv4', '127.0.0.1', 'IP addresses are not accepted; provide a domain name'],
        ['IPv6', '%3A%3A1', 'IP addresses are not accepted; provide a domain name'],
        ['ping option', '-c99999', 'Invalid domain name'],
        ['internal suffix', 'db.internal', 'Reserved or internal domain names are not accepted'],
        ['localhost', 'localhost', 'Invalid domain name']
    ])('rejects %s with 400', async (_, input, message) => {
        const res = await request(app).get(`${API}/${input}`).expect(400);
        expect(res.body.error).toBe(message);
    });

    it('returns 400 (not 500) for malformed percent-encoding', async () => {
        const res = await request(app).get(`${API}/%E0%A4%A`).expect(400);
        expect(res.body).toEqual({ error: 'Bad request' });
    });
});

describe('POST /api/v1/domains/info/_payload', () => {
    const post = (body: unknown) => request(app).post(`${API}/_payload`).send(body as object);

    it('looks up each unique domain in order', async () => {
        const res = await post({ domains: ['example.com', 'EXAMPLE.com', 'free-name.com'] }).expect(200);
        expect(res.body.map((r: { domain: string, available: boolean }) => [r.domain, r.available]))
            .toEqual([['example.com', false], ['free-name.com', true]]);
    });

    it('rejects the whole request and lists invalid entries', async () => {
        const res = await post({ domains: ['example.com', '127.0.0.1', 42] }).expect(400);
        expect(res.body).toEqual({
            error: 'One or more domains are invalid',
            details: {
                invalid: [
                    { domain: '127.0.0.1', reason: 'IP addresses are not accepted; provide a domain name' },
                    { domain: 42, reason: 'Domain must be a string' }
                ]
            }
        });
    });

    it.each([
        ['empty list', { domains: [] }],
        ['missing domains', {}],
        ['not an array', { domains: 'example.com' }]
    ])('rejects %s with 400', async (_, body) => {
        const res = await post(body).expect(400);
        expect(res.body.error).toBe('Provide a non-empty list of domains');
    });

    it('rejects more than MAX_DOMAINS_PER_REQUEST domains', async () => {
        const res = await post({ domains: Array.from({ length: 51 }, (_, i) => `d${i}.com`) }).expect(400);
        expect(res.body.error).toBe('Too many domains: 51 provided, maximum is 50');
    });

    it('rejects malformed JSON with 400', async () => {
        const res = await request(app).post(`${API}/_payload`).set('Content-Type', 'application/json').send('{"domains":[').expect(400);
        expect(res.body.error).toBeDefined();
    });

    it('rejects bodies over MAX_BODY_BYTES with 413', async () => {
        await post({ domains: ['x'.repeat(20000)] }).expect(413);
    });

    it('ignores __proto__ keys in the body', async () => {
        await post({ ['__proto__']: { polluted: true }, domains: ['example.com'] }).expect(200);
        expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    });
});

describe('POST /api/v1/domains/info/_file', () => {
    const upload = (content: string, type = 'text/plain', filename = 'domains.txt') =>
        request(app).post(`${API}/_file`).attach('file', Buffer.from(content), { filename, contentType: type });

    it('looks up domains from a text file, skipping comments and blank lines', async () => {
        const res = await upload('# list\nexample.com\r\n\n  free-name.com  \n').expect(200);
        expect(res.body.map((r: { domain: string }) => r.domain)).toEqual(['example.com', 'free-name.com']);
    });

    it('does not use the client-supplied filename for anything', async () => {
        await upload('example.com\n', 'text/plain', '../../evil.txt').expect(200);
    });

    it('rejects a missing file with 400', async () => {
        const res = await request(app).post(`${API}/_file`).expect(400);
        expect(res.body.error).toMatch(/Missing file/);
    });

    it('rejects non-text files with 400', async () => {
        const res = await upload('example.com', 'application/pdf').expect(400);
        expect(res.body.error).toBe('Unsupported file type [application/pdf]; upload a text/plain file');
    });

    it('rejects files over MAX_UPLOAD_BYTES with 413', async () => {
        const res = await upload('a'.repeat(70 * 1024)).expect(413);
        expect(res.body.error).toBe('Invalid upload: File too large');
    });

    it('rejects extra form fields with 400', async () => {
        const res = await request(app).post(`${API}/_file`)
            .field('extra', '1')
            .attach('file', Buffer.from('example.com'), { filename: 'd.txt', contentType: 'text/plain' })
            .expect(400);
        expect(res.body.error).toMatch(/Invalid upload/);
    });

    it('rejects a truncated multipart body with 400', async () => {
        const res = await request(app).post(`${API}/_file`)
            .set('Content-Type', 'multipart/form-data; boundary=XYZ')
            .send('--XYZ\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nexample.com\r\n')
            .expect(400);
        expect(res.body).toEqual({ error: 'Malformed multipart body' });
    });

    it('rejects files containing invalid domains', async () => {
        const res = await upload('example.com\n10.0.0.1\n').expect(400);
        expect(res.body.details.invalid).toEqual([{ domain: '10.0.0.1', reason: 'IP addresses are not accepted; provide a domain name' }]);
    });
});

describe('app-wide behavior', () => {
    it('returns JSON 404 for unknown routes', async () => {
        const res = await request(app).get('/nope').expect(404);
        expect(res.body).toEqual({ error: 'Not found' });
    });

    it('sets security headers and hides X-Powered-By', async () => {
        const res = await request(app).get(`${API}/example.com`);
        expect(res.headers['x-powered-by']).toBeUndefined();
        expect(res.headers['content-security-policy']).toContain("default-src 'self'");
        expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('does not allow cross-origin browser requests by default', async () => {
        const res = await request(app).get(`${API}/example.com`).set('Origin', 'https://evil.example');
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('sends rate-limit headers on API routes', async () => {
        const res = await request(app).get(`${API}/example.com`);
        expect(res.headers['ratelimit-policy']).toBeDefined();
    });

    it('serves Swagger UI and the OpenAPI spec', async () => {
        const ui = await request(app).get('/api-docs/').expect(200);
        expect(ui.text).toContain('<title>NameInsight API docs</title>');
        const spec = await request(app).get('/api-docs.json').expect(200);
        expect(spec.body.info.title).toBe('NameInsight');
        expect(Object.keys(spec.body.paths)).toEqual([
            '/healthz',
            '/api/v1/domains/info/{domain}',
            '/api/v1/domains/info/_payload',
            '/api/v1/domains/info/_file'
        ]);
    });
});
