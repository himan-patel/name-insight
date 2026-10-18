import { execFileSync } from 'child_process';
import { createHash, randomBytes } from 'crypto';
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

// Keys are generated per test run; no key material is stored in the repository.
const keyA = `test_${randomBytes(24).toString('hex')}`;
const keyB = `test_${randomBytes(24).toString('hex')}`;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

type CreateApp = typeof import('../app/http/app').createApp;

/** Loads a fresh app with the given environment (config is read at import time). */
function appWith(env: Record<string, string>) {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    let createApp!: CreateApp;
    jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- isolateModules needs a synchronous require
        ({ createApp } = require('../app/http/app'));
    });
    process.env = saved;
    return createApp();
}

const API = '/api/v1/domains/info';

describe('API key authentication (API_KEYS_SHA256 set)', () => {
    const app = appWith({ API_KEYS_SHA256: `${sha256(keyA)},${sha256(keyB).toUpperCase()}` });

    it('rejects requests without a key with 401 and WWW-Authenticate', async () => {
        const res = await request(app).get(`${API}/example.com`).expect(401);
        expect(res.body).toEqual({ error: 'Missing or invalid API key' });
        expect(res.headers['www-authenticate']).toBe('Bearer realm="NameInsight"');
    });

    it('rejects a wrong key', async () => {
        await request(app).get(`${API}/example.com`).set('Authorization', 'Bearer not-a-valid-key').expect(401);
    });

    it('accepts a valid key as a Bearer token', async () => {
        await request(app).get(`${API}/example.com`).set('Authorization', `Bearer ${keyA}`).expect(200);
    });

    it('accepts a valid key in X-API-Key, and any configured key (digests are case-insensitive)', async () => {
        await request(app).get(`${API}/example.com`).set('X-API-Key', keyB).expect(200);
    });

    it('protects bulk endpoints too', async () => {
        await request(app).post(`${API}/_payload`).send({ domains: ['example.com'] }).expect(401);
        await request(app).post(`${API}/_payload`).set('X-API-Key', keyA).send({ domains: ['example.com'] }).expect(200);
    });

    it('checks the key before validating input or charging budgets', async () => {
        await request(app).get(`${API}/127.0.0.1`).expect(401);
    });

    it('leaves health and docs open', async () => {
        await request(app).get('/healthz').expect(200);
        await request(app).get('/api-docs.json').expect(200);
    });

    it('never echoes the key back', async () => {
        const res = await request(app).get(`${API}/example.com`).set('Authorization', `Bearer ${keyA}x`);
        expect(JSON.stringify(res.body) + JSON.stringify(res.headers)).not.toContain(keyA);
    });

    it('documents the security schemes and 401 in the spec', async () => {
        const spec = (await request(app).get('/api-docs.json')).body;
        expect(Object.keys(spec.components.securitySchemes)).toEqual(['bearerAuth', 'apiKeyHeader']);
        expect(spec.paths[`${API}/{domain}`].get.security).toEqual([{ bearerAuth: [] }, { apiKeyHeader: [] }]);
        expect(spec.paths[`${API}/{domain}`].get.responses['401']).toBeDefined();
    });
});

describe('without API_KEYS_SHA256', () => {
    const app = appWith({ API_KEYS_SHA256: '' });

    it('allows requests without a key', async () => {
        await request(app).get(`${API}/example.com`).expect(200);
    });

    it('does not mark operations as secured in the spec', async () => {
        const spec = (await request(app).get('/api-docs.json')).body;
        expect(spec.paths[`${API}/{domain}`].get.security).toBeUndefined();
    });
});

describe('API_KEYS_SHA256 validation', () => {
    it('refuses to start with a malformed digest', () => {
        expect(() => appWith({ API_KEYS_SHA256: 'not-a-digest' })).toThrow('Invalid value in API_KEYS_SHA256');
    });

    it('does not include the bad value in the error message', () => {
        try {
            appWith({ API_KEYS_SHA256: 'raw-key-pasted-by-mistake' });
        } catch (error) {
            expect((error as Error).message).not.toContain('raw-key-pasted-by-mistake');
        }
    });
});

describe('lookup budget (domains per window, per client)', () => {
    it('charges one unit per domain and returns 429 with Retry-After when exceeded', async () => {
        const app = appWith({ API_KEYS_SHA256: '', LOOKUP_BUDGET_MAX: '5' });
        await request(app).post(`${API}/_payload`).send({ domains: ['a.com', 'b.com', 'c.com', 'd.com'] }).expect(200);

        const res = await request(app).post(`${API}/_payload`).send({ domains: ['e.com', 'f.com'] }).expect(429);
        expect(res.body.error).toBe('Lookup budget exceeded: 2 requested, 1 of 5 remaining in this 60s window');
        expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);

        await request(app).get(`${API}/e.com`).expect(200);
        await request(app).get(`${API}/f.com`).expect(429);
    });

    it('does not charge invalid requests', async () => {
        const app = appWith({ API_KEYS_SHA256: '', LOOKUP_BUDGET_MAX: '1' });
        await request(app).post(`${API}/_payload`).send({ domains: ['a.com', '10.0.0.1'] }).expect(400);
        await request(app).get(`${API}/a.com`).expect(200);
    });

    it('tracks budgets per API key', async () => {
        const app = appWith({ API_KEYS_SHA256: `${sha256(keyA)},${sha256(keyB)}`, LOOKUP_BUDGET_MAX: '1' });
        await request(app).get(`${API}/a.com`).set('X-API-Key', keyA).expect(200);
        await request(app).get(`${API}/b.com`).set('X-API-Key', keyA).expect(429);
        await request(app).get(`${API}/b.com`).set('X-API-Key', keyB).expect(200);
    });
});

describe('npm run generate-api-key', () => {
    it('prints a random key and its matching SHA-256 digest', () => {
        const output = execFileSync(process.execPath, ['scripts/generate-api-key.mjs'], { encoding: 'utf8' });
        const key = output.match(/^\s+(ni_[A-Za-z0-9_-]{43})$/m)?.[1];
        const digest = output.match(/API_KEYS_SHA256=([0-9a-f]{64})/)?.[1];
        expect(key).toBeDefined();
        expect(digest).toBe(sha256(key as string));

        const second = execFileSync(process.execPath, ['scripts/generate-api-key.mjs'], { encoding: 'utf8' });
        expect(second).not.toContain(key as string);
    });
});
