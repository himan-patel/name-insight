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

describe('rate limiting', () => {
    it('returns 429 after RATE_LIMIT_MAX requests, counting invalid requests too', async () => {
        process.env.RATE_LIMIT_MAX = '3';
        let createApp!: typeof import('../app/http/app').createApp;
        jest.isolateModules(() => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports -- isolateModules needs a synchronous require
            ({ createApp } = require('../app/http/app'));
        });
        const app = createApp();

        const statuses: number[] = [];
        for (let i = 0; i < 5; i++) {
            statuses.push((await request(app).get('/api/v1/domains/info/127.0.0.1')).status);
        }
        expect(statuses).toEqual([400, 400, 400, 429, 429]);

        const limited = await request(app).get('/API/v1/domains/info/example.com').expect(429);
        expect(limited.body).toEqual({ error: 'Too many requests, please try again later.' });

        // docs are not rate limited
        await request(app).get('/api-docs.json').expect(200);
    });
});
