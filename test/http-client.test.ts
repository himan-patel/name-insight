import * as http from 'http';
import { AddressInfo } from 'net';

import { fakeResolver, FakeRecords } from './helpers/fake-dns';

let records: FakeRecords = {};
jest.mock('../app/core/dns', () => ({ createResolver: () => fakeResolver(records) }));

const actual: typeof import('../app/core/http-client') = jest.requireActual('../app/core/http-client');
const { getJson, publicLookup, readCapped } = actual;

function lookup(hostname: string, all = false): Promise<unknown> {
    return new Promise((resolve, reject) => {
        publicLookup(hostname, { all }, (error, address, family) => error ? reject(error) : resolve(all ? address : [address, family]));
    });
}

describe('publicLookup', () => {
    beforeEach(() => {
        records = {
            'rdap.example.net': { a: ['93.184.216.34', '93.184.216.35'] },
            'internal.example.net': { a: ['10.0.0.8'] },
            'mixed.example.net': { a: ['93.184.216.34', '127.0.0.1'] }
        };
    });

    it('returns the first public IPv4 address', async () => {
        await expect(lookup('rdap.example.net')).resolves.toEqual(['93.184.216.34', 4]);
    });

    it('supports the all: true form used by Happy Eyeballs', async () => {
        await expect(lookup('rdap.example.net', true)).resolves.toEqual([
            { address: '93.184.216.34', family: 4 }, { address: '93.184.216.35', family: 4 }
        ]);
    });

    it.each(['internal.example.net', 'mixed.example.net', '169.254.169.254', '127.0.0.1'])('refuses %s', async host => {
        await expect(lookup(host)).rejects.toMatchObject({ code: 'ENOTPUBLIC' });
    });

    it('passes through resolution failures', async () => {
        await expect(lookup('missing.example.net')).rejects.toMatchObject({ code: 'ENOTFOUND' });
    });
});

describe('readCapped', () => {
    let server: http.Server;
    afterEach(() => new Promise(resolve => server.close(resolve)));

    async function fetchWith(handler: http.RequestListener, maxBytes: number) {
        server = http.createServer(handler);
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address() as AddressInfo;
        return new Promise<{ data: string, truncated: boolean }>((resolve, reject) => {
            http.get({ host: '127.0.0.1', port }, res => readCapped(res, maxBytes).then(resolve, reject)).on('error', reject);
        });
    }

    it('returns the whole body when it fits', async () => {
        await expect(fetchWith((req, res) => res.end('{"ok":true}'), 100)).resolves.toEqual({ data: '{"ok":true}', truncated: false });
    });

    it('truncates and stops reading at maxBytes', async () => {
        const result = await fetchWith((req, res) => {
            const timer = setInterval(() => res.write('x'.repeat(1024)), 1);
            res.on('close', () => clearInterval(timer));
        }, 4096);
        expect(result.truncated).toBe(true);
        expect(result.data).toHaveLength(4096);
    });
});

describe('getJson', () => {
    it.each(['http://rdap.example.net/', 'ftp://rdap.example.net/', 'file:///etc/passwd'])('refuses non-HTTPS URL %s', async url => {
        await expect(getJson(url, { timeoutMs: 100, maxBytes: 100 })).rejects.toThrow('Refusing non-HTTPS URL');
    });

    it('refuses hosts that resolve to private addresses before connecting', async () => {
        records = { 'internal.example.net': { a: ['10.0.0.8'] } };
        await expect(getJson('https://internal.example.net/x', { timeoutMs: 1000, maxBytes: 100 })).rejects.toMatchObject({ code: 'ENOTPUBLIC' });
    });
});
