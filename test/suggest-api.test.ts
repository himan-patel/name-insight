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
const generate = jest.fn();
jest.mock('../app/core/claude-generator', () => ({ createClaudeGenerator: () => generate }));

/** Fresh app with the given env. The "key" is an obvious placeholder: the generator is mocked, nothing is sent anywhere. */
function load(env: Record<string, string>) {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
        let createApp!: typeof import('../app/http/app').createApp;
        let suggestions!: typeof import('../app/core/suggestions');
        jest.isolateModules(() => {
            /* eslint-disable @typescript-eslint/no-require-imports -- isolateModules needs synchronous requires */
            ({ createApp } = require('../app/http/app'));
            suggestions = require('../app/core/suggestions');
            /* eslint-enable @typescript-eslint/no-require-imports */
        });
        return { app: createApp(), suggestions };
    } finally {
        process.env = saved;
    }
}
const appWith = (env: Record<string, string>) => load(env).app;
const PLACEHOLDER = { ANTHROPIC_API_KEY: 'placeholder-for-tests' };
const SUGGEST = '/api/v1/domains/suggest';

beforeEach(() => {
    generate.mockReset();
    generate.mockResolvedValue([{ name: 'brewly', rationale: 'playful' }, { name: 'mugsy', rationale: 'friendly' }]);
});

describe('POST /api/v1/domains/suggest', () => {
    it('returns 503 when no Claude API key is configured', async () => {
        const res = await request(appWith({ ANTHROPIC_API_KEY: '' })).post(SUGGEST).send({ description: 'coffee' }).expect(503);
        expect(res.body).toEqual({ error: 'AI suggestions are not configured on this server' });
        expect(generate).not.toHaveBeenCalled();
    });

    it('validates input before calling the model', async () => {
        const res = await request(appWith(PLACEHOLDER)).post(SUGGEST).send({ description: 'x'.repeat(501) }).expect(400);
        expect(res.body.error).toBe('Invalid suggestion request');
        expect(generate).not.toHaveBeenCalled();
    });

    it('returns ranked, verified suggestions', async () => {
        const res = await request(appWith(PLACEHOLDER)).post(SUGGEST).send({ description: 'coffee subscription', count: 2, tlds: ['com', 'io'] }).expect(200);
        expect(res.body.generatedBy).toBe('claude-api');
        expect(res.body.suggestions.map((s: { name: string }) => s.name)).toEqual(['brewly', 'mugsy']);
        expect(res.body.suggestions[0].available).toEqual(['brewly.com', 'brewly.io']);
    });

    it.each([
        [422, 'The model declined to suggest names for this description'],
        [502, 'The AI service failed to respond; please try again']
    ])('maps generator failures to %s', async (status, message) => {
        // the error class must come from the same (isolated) module instance the app uses
        const { app, suggestions } = load(PLACEHOLDER);
        generate.mockRejectedValue(new suggestions.SuggestionsFailedError(message, status as 422 | 502));
        const res = await request(app).post(SUGGEST).send({ description: 'coffee' }).expect(status);
        expect(res.body).toEqual({ error: message });
    });

    it('applies the stricter per-IP suggestion limit', async () => {
        const app = appWith({ ...PLACEHOLDER, SUGGEST_RATE_LIMIT_MAX: '2' });
        await request(app).post(SUGGEST).send({ description: 'a' }).expect(200);
        await request(app).post(SUGGEST).send({ description: 'b' }).expect(200);
        const res = await request(app).post(SUGGEST).send({ description: 'c' }).expect(429);
        expect(res.body).toEqual({ error: 'Too many suggestion requests, please try again later.' });
        // lookups are unaffected by the suggestion limit
        await request(app).get('/api/v1/domains/info/example.com').expect(200);
    });
});
