import request from 'supertest';

jest.mock('../app/core/dns', () => ({
    createResolver: () => ({
        resolve4: () => Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })),
        resolve6: () => Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })),
        setServers: () => undefined
    })
}));
jest.mock('../app/core/whois', () => ({ whoisLookup: jest.fn(async () => 'No match') }));
jest.mock('ping', () => ({ promise: { probe: jest.fn() } }));

/** Loads a fresh copy of a module with the given environment (config is read at import time). */
function load<T>(env: Record<string, string>, modulePath: string): T {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
        let loaded!: T;
        jest.isolateModules(() => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports -- isolateModules needs a synchronous require
            loaded = require(modulePath);
        });
        return loaded;
    } finally {
        process.env = saved;
    }
}
const appWith = (env: Record<string, string>) => load<typeof import('../app/http/app')>(env, '../app/http/app').createApp();
const loadConfig = (env: Record<string, string>) => load<typeof import('../app/config/global.config')>(env, '../app/config/global.config');
const API = '/api/v1/domains/info';

describe('public access (no authentication)', () => {
    const app = appWith({});

    it('serves lookups without any credentials', async () => {
        await request(app).get(`${API}/example.com`).expect(200);
        await request(app).post(`${API}/_payload`).send({ domains: ['example.com'] }).expect(200);
    });

    it('does not advertise security schemes in the spec', async () => {
        const spec = (await request(app).get('/api-docs.json')).body;
        expect(spec.components.securitySchemes).toBeUndefined();
        expect(spec.paths[`${API}/{domain}`].get.security).toBeUndefined();
        expect(spec.paths[`${API}/{domain}`].get.responses['401']).toBeUndefined();
    });
});

describe('config', () => {
    it('defaults the bind address to loopback', () => {
        expect(loadConfig({ API_HOST: '' }).host).toBe('127.0.0.1');
    });

    it('rejects a lookup budget smaller than the bulk limit', () => {
        expect(() => loadConfig({ LOOKUP_BUDGET_MAX: '10', MAX_DOMAINS_PER_REQUEST: '50' }))
            .toThrow('LOOKUP_BUDGET_MAX (10) must be at least MAX_DOMAINS_PER_REQUEST (50)');
    });

    it.each(['RATE_LIMIT_WINDOW_MS', 'LOOKUP_BUDGET_WINDOW_MS', 'RATE_LIMIT_MAX'])('rejects %s=0', name => {
        expect(() => loadConfig({ [name]: '0' })).toThrow(`Invalid value for ${name}: expected an integer of at least 1`);
    });
});

describe('lookup budget (domains per window, per client IP)', () => {
    it('charges one unit per domain and returns 429 with Retry-After when exceeded', async () => {
        const app = appWith({ LOOKUP_BUDGET_MAX: '5', MAX_DOMAINS_PER_REQUEST: '5' });
        await request(app).post(`${API}/_payload`).send({ domains: ['a.com', 'b.com', 'c.com', 'd.com'] }).expect(200);

        const res = await request(app).post(`${API}/_payload`).send({ domains: ['e.com', 'f.com'] }).expect(429);
        expect(res.body.error).toBe('Lookup budget exceeded: 2 requested, 1 of 5 remaining in this 60s window');
        expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);

        await request(app).get(`${API}/e.com`).expect(200);
        await request(app).get(`${API}/f.com`).expect(429);
    });

    it('does not charge invalid requests', async () => {
        const app = appWith({ LOOKUP_BUDGET_MAX: '2', MAX_DOMAINS_PER_REQUEST: '2' });
        await request(app).post(`${API}/_payload`).send({ domains: ['a.com', '10.0.0.1'] }).expect(400);
        await request(app).get(`${API}/a.com`).expect(200);
        await request(app).get(`${API}/b.com`).expect(200);
        await request(app).get(`${API}/c.com`).expect(429);
    });

    it('ignores spoofed X-Forwarded-For when TRUST_PROXY_HOPS is 0', async () => {
        const app = appWith({ LOOKUP_BUDGET_MAX: '1', MAX_DOMAINS_PER_REQUEST: '1' });
        await request(app).get(`${API}/a.com`).set('X-Forwarded-For', '203.0.113.1').expect(200);
        await request(app).get(`${API}/b.com`).set('X-Forwarded-For', '203.0.113.2').expect(429);
    });
});
