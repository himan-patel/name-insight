import { createHash, randomBytes } from 'crypto';
import request from 'supertest';

import { checkExposure, isLoopbackHost } from '../app/http/auth';

jest.mock('../app/core/dns', () => ({
    createResolver: () => ({
        resolve4: () => Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })),
        resolve6: () => Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })),
        setServers: () => undefined
    })
}));
jest.mock('../app/core/whois', () => ({ whoisLookup: jest.fn(async () => 'No match') }));
jest.mock('ping', () => ({ promise: { probe: jest.fn() } }));

const key = `test_${randomBytes(24).toString('hex')}`;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

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
const appWith = (env: Record<string, string>) =>
    load<typeof import('../app/http/app')>(env, '../app/http/app').createApp();

describe('secure-by-default exposure check', () => {
    it.each(['127.0.0.1', '127.1.2.3', '::1', 'localhost'])('treats %s as loopback', host => {
        expect(isLoopbackHost(host)).toBe(true);
    });

    it.each(['0.0.0.0', '::', '192.168.1.10', '10.0.0.5', 'example.com'])('treats %s as reachable from other machines', host => {
        expect(isLoopbackHost(host)).toBe(false);
    });

    it('allows loopback without keys', () => {
        expect(checkExposure({ host: '127.0.0.1', keyCount: 0, authDisabled: false })).toBeUndefined();
    });

    it('allows any host with keys', () => {
        expect(checkExposure({ host: '0.0.0.0', keyCount: 1, authDisabled: false })).toBeUndefined();
    });

    it('refuses a public bind without keys', () => {
        expect(() => checkExposure({ host: '0.0.0.0', keyCount: 0, authDisabled: false })).toThrow('Refusing to serve 0.0.0.0 without API keys');
    });

    it('allows it with an explicit AUTH_DISABLED, returning a warning', () => {
        expect(checkExposure({ host: '0.0.0.0', keyCount: 0, authDisabled: true })).toMatch(/AUTH_DISABLED=true/);
    });

    it('defaults the bind address to loopback', () => {
        const config = load<typeof import('../app/config/global.config')>({ API_HOST: '' }, '../app/config/global.config');
        expect(config.host).toBe('127.0.0.1');
    });
});

describe('config validation', () => {
    const loadConfig = (env: Record<string, string>) => load(env, '../app/config/global.config');

    it('rejects a lookup budget smaller than the bulk limit', () => {
        expect(() => loadConfig({ LOOKUP_BUDGET_MAX: '10', MAX_DOMAINS_PER_REQUEST: '50' }))
            .toThrow('LOOKUP_BUDGET_MAX (10) must be at least MAX_DOMAINS_PER_REQUEST (50)');
    });

    it.each(['RATE_LIMIT_WINDOW_MS', 'LOOKUP_BUDGET_WINDOW_MS', 'RATE_LIMIT_MAX'])('rejects %s=0', name => {
        expect(() => loadConfig({ [name]: '0' })).toThrow(`Invalid value for ${name}: expected an integer of at least 1`);
    });
});

describe('pre-auth per-IP limit', () => {
    it('limits requests with missing or wrong keys (10x RATE_LIMIT_MAX per IP)', async () => {
        const app = appWith({ API_KEYS_SHA256: sha256(key), RATE_LIMIT_MAX: '2' });
        const statuses: number[] = [];
        for (let i = 0; i < 22; i++) {
            statuses.push((await request(app).get('/api/v1/domains/info/example.com').set('X-API-Key', `wrong-${i}`)).status);
        }
        expect(statuses.slice(0, 20).every(status => status === 401)).toBe(true);
        expect(statuses.slice(20)).toEqual([429, 429]);
    });

    it('applies auth regardless of path casing', async () => {
        const app = appWith({ API_KEYS_SHA256: sha256(key) });
        await request(app).get('/API/V1/domains/info/example.com').expect(401);
        await request(app).head('/api/v1/domains/info/example.com').expect(401);
    });
});

describe('access log', () => {
    it('records a non-secret client id for authenticated requests, never the key', async () => {
        const app = appWith({ API_KEYS_SHA256: sha256(key), LOG_REQUESTS: 'true' });
        const writes: string[] = [];
        const spy = jest.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
            writes.push(String(chunk));
            return true;
        }) as typeof process.stdout.write);
        try {
            await request(app).get('/api/v1/domains/info/example.com').set('Authorization', `Bearer ${key}`).expect(200);
            await new Promise(resolve => setImmediate(resolve));
        } finally {
            spy.mockRestore();
        }
        const line = writes.join('');
        expect(line).toContain(`key:${sha256(key).slice(0, 16)}`);
        expect(line).not.toContain(key);
    });
});
