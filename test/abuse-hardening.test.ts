import request from 'supertest';

import { AbortedError, mapWithConcurrency, QueueFullError, Semaphore } from '../app/utils/async';
import { toLabel } from '../app/core/suggestions';

jest.mock('../app/core/dns', () => ({
    createResolver: () => ({
        resolve4: () => Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })),
        resolve6: () => Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })),
        setServers: () => undefined
    })
}));
const whoisLookup = jest.fn(async (d: string) => `No match for domain "${d}".`);
jest.mock('../app/core/whois', () => ({ whoisLookup: (d: string) => whoisLookup(d) }));
jest.mock('ping', () => ({ promise: { probe: jest.fn() } }));

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
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('Semaphore: bounded queue and cancellation', () => {
    it('rejects new waiters once the queue is full', async () => {
        const semaphore = new Semaphore(1, 1);
        const running = semaphore.run(() => delay(30));
        const queued = semaphore.run(async () => 'queued');
        await expect(semaphore.run(async () => 'overflow')).rejects.toBeInstanceOf(QueueFullError);
        await running;
        await expect(queued).resolves.toBe('queued');
    });

    it('drops a waiting call when its signal aborts, without running it', async () => {
        const semaphore = new Semaphore(1);
        const ran = jest.fn();
        const controller = new AbortController();
        const running = semaphore.run(() => delay(30));
        const waiting = semaphore.run(async () => ran(), controller.signal);
        controller.abort();
        await expect(waiting).rejects.toBeInstanceOf(AbortedError);
        await running;
        expect(ran).not.toHaveBeenCalled();
        await expect(semaphore.run(async () => 'free')).resolves.toBe('free');
    });

    it('refuses to start when the signal already aborted', async () => {
        await expect(new Semaphore(1).run(async () => 1, AbortSignal.abort())).rejects.toBeInstanceOf(AbortedError);
    });

    it('stops mapping when the signal aborts', async () => {
        const controller = new AbortController();
        const seen: number[] = [];
        const result = mapWithConcurrency([1, 2, 3, 4], 1, async item => {
            seen.push(item);
            if (item === 2) {
                controller.abort();
            }
            return item;
        }, controller.signal);
        await expect(result).rejects.toBeInstanceOf(AbortedError);
        expect(seen).toEqual([1, 2]);
    });
});

describe('lookups are skipped when the caller goes away', () => {
    it('does no lookups for an aborted bulk request', async () => {
        const { DomainService } = load<typeof import('../app/core/domain-service')>({}, '../app/core/domain-service');
        whoisLookup.mockClear();
        await expect(new DomainService().getDomainInfoBulk(['a.com', 'b.com'], { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortedError' });
        expect(whoisLookup).not.toHaveBeenCalled();
    });
});

describe('cross-site request protection', () => {
    it.each(['/api/v1/domains/info/_payload', '/api/v1/domains/suggest'])('rejects form-encoded posts to %s with 415', async path => {
        const res = await request(appWith({})).post(path).type('form').send('domains[]=a.com&description=x').expect(415);
        expect(res.body).toEqual({ error: 'Send a JSON body with Content-Type: application/json' });
    });

    it('still accepts JSON', async () => {
        await request(appWith({})).post('/api/v1/domains/info/_payload').send({ domains: ['a.com'] }).expect(200);
    });
});

describe('per-client concurrent request cap', () => {
    it('returns 429 when a client has too many requests in flight', async () => {
        whoisLookup.mockImplementation(async (d: string) => {
            await delay(150);
            return `No match for domain "${d}".`;
        });
        try {
            const app = appWith({ MAX_CONCURRENT_REQUESTS_PER_CLIENT: '1' });
            const slow = request(app).get('/api/v1/domains/info/slow.com');
            const slowDone = slow.then(res => res.status);
            await delay(30);
            const blocked = await request(app).get('/api/v1/domains/info/other.com');
            expect(blocked.status).toBe(429);
            expect(blocked.body.error).toMatch(/Too many concurrent requests/);
            expect(await slowDone).toBe(200);
            // capacity is released once the first request finishes
            await request(app).get('/api/v1/domains/info/after.com').expect(200);
        } finally {
            whoisLookup.mockImplementation(async (d: string) => `No match for domain "${d}".`);
        }
    });
});

describe('model output bounds', () => {
    it('cleans very long names quickly (no regex backtracking)', () => {
        const start = Date.now();
        expect(toLabel(`brand${'.a'.repeat(50_000)}`)).toBe('brand');
        expect(Date.now() - start).toBeLessThan(100);
    });
});

describe('Claude API spend caps', () => {
    it('enforces a process-wide hourly cap on Claude calls', async () => {
        const { createClaudeGenerator } = load<typeof import('../app/core/claude-generator')>(
            { GLOBAL_SUGGEST_MAX_PER_HOUR: '1' }, '../app/core/claude-generator');
        const parse = jest.fn(async () => ({ stop_reason: 'end_turn', parsed_output: { names: [{ name: 'brewly', rationale: 'r' }] } }));
        const generate = createClaudeGenerator({ beta: { messages: { parse } } } as never);
        const req = { description: 'coffee', count: 1, tlds: ['com'], style: 'any' as const };
        await expect(generate(req)).resolves.toHaveLength(1);
        await expect(generate(req)).rejects.toMatchObject({ status: 502, message: expect.stringContaining('hourly limit') });
        expect(parse).toHaveBeenCalledTimes(1);
    });
});
