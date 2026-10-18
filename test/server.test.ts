import express from 'express';
import * as http from 'http';
import { AddressInfo } from 'net';
import request from 'supertest';

jest.mock('../app/core/dns', () => ({ createResolver: () => ({}) }));
jest.mock('../app/core/whois', () => ({ whoisLookup: jest.fn() }));
jest.mock('ping', () => ({ promise: { probe: jest.fn() } }));

import { createApp } from '../app/http/app';
import { lifecycle } from '../app/http/lifecycle';
import { startServer } from '../app/http/server';

afterEach(() => lifecycle.reset());

/** An app with a route that takes `ms` to respond, standing in for a slow lookup. */
function slowApp() {
    const app = express();
    app.get('/slow/:ms', (req, res) => {
        setTimeout(() => res.json({ done: true }), Number(req.params.ms));
    });
    return app;
}

function get(port: number, path: string, agent?: http.Agent): Promise<{ status: number, body: string }> {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path, agent }, res => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        }).on('error', reject);
    });
}

describe('graceful shutdown', () => {
    it('lets in-flight requests finish, refuses new connections, then resolves', async () => {
        const { server, shutdown } = await startServer(slowApp(), { port: 0, host: '127.0.0.1', shutdownTimeoutMs: 5000 });
        const { port } = server.address() as AddressInfo;

        const inFlight = get(port, '/slow/200');
        await new Promise(resolve => setTimeout(resolve, 50));
        const stopped = shutdown();

        await expect(get(port, '/slow/1')).rejects.toThrow(/ECONNREFUSED|ECONNRESET/);
        await expect(inFlight).resolves.toEqual({ status: 200, body: '{"done":true}' });
        await expect(stopped).resolves.toBeUndefined();
        expect(lifecycle.isShuttingDown()).toBe(true);
    });

    it('does not wait for idle keep-alive connections', async () => {
        const { server, shutdown } = await startServer(slowApp(), { port: 0, host: '127.0.0.1', shutdownTimeoutMs: 5000 });
        const { port } = server.address() as AddressInfo;
        const agent = new http.Agent({ keepAlive: true });

        await get(port, '/slow/1', agent);
        const start = Date.now();
        await shutdown();
        expect(Date.now() - start).toBeLessThan(1000);
        agent.destroy();
    });

    it('force-closes requests that outlive the shutdown timeout', async () => {
        const { server, shutdown } = await startServer(slowApp(), { port: 0, host: '127.0.0.1', shutdownTimeoutMs: 100 });
        const { port } = server.address() as AddressInfo;

        const hanging = get(port, '/slow/10000');
        await new Promise(resolve => setTimeout(resolve, 50));
        const start = Date.now();
        await shutdown();

        expect(Date.now() - start).toBeLessThan(1000);
        await expect(hanging).rejects.toThrow(/socket hang up|ECONNRESET/);
    });

    it('returns the same promise when shutdown is called twice', async () => {
        const { shutdown } = await startServer(slowApp(), { port: 0, host: '127.0.0.1', shutdownTimeoutMs: 1000 });
        const first = shutdown();
        expect(shutdown()).toBe(first);
        await first;
    });

    it('rejects when the port is already in use', async () => {
        const { server, shutdown } = await startServer(slowApp(), { port: 0, host: '127.0.0.1', shutdownTimeoutMs: 1000 });
        const { port } = server.address() as AddressInfo;
        await expect(startServer(slowApp(), { port, host: '127.0.0.1', shutdownTimeoutMs: 1000 })).rejects.toThrow(/EADDRINUSE/);
        await shutdown();
    });
});

describe('GET /healthz', () => {
    const app = createApp();

    it('reports ok while running', async () => {
        const res = await request(app).get('/healthz').expect(200);
        expect(res.body).toEqual({ status: 'ok' });
    });

    it('returns 503 and asks clients to close connections once shutdown starts', async () => {
        lifecycle.beginShutdown();
        const res = await request(app).get('/healthz').expect(503);
        expect(res.body).toEqual({ status: 'shutting-down' });
        expect(res.headers.connection).toBe('close');
    });

    it('is not rate limited', async () => {
        const res = await request(app).get('/healthz');
        expect(res.headers['ratelimit-policy']).toBeUndefined();
    });
});
