import * as net from 'net';
import { AddressInfo } from 'net';

import { fakeResolver, FakeRecords } from './helpers/fake-dns';

let records: FakeRecords = {};
jest.mock('../app/services/dns-resolver', () => ({
    createResolver: () => fakeResolver(records)
}));

import { extractReferral, queryServer, resolvePublicHost, whoisLookup } from '../app/services/whois.client';

// Settings come from test/setup-env.ts: WHOIS_TIMEOUT_MS=500, MAX_WHOIS_RESPONSE_BYTES=2048

type Handler = (socket: net.Socket, query: string) => void;
const servers: net.Server[] = [];

/** Starts a local fake WHOIS server; the handler receives the first chunk (the query). */
async function fakeWhoisServer(handler: Handler): Promise<number> {
    const server = net.createServer(socket => {
        socket.on('error', () => undefined);
        socket.once('data', chunk => handler(socket, chunk.toString()));
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
}

// The real (mutable) module object; the client's `import * as net` reads properties from it on each call
const nodeNet: typeof net = jest.requireActual('net');

/** Routes outgoing port-43 connections for fake public IPs to local fake servers. */
function routeConnections(routes: { [ip: string]: number }) {
    const realConnect = nodeNet.connect;
    const connected: string[] = [];
    jest.spyOn(nodeNet, 'connect').mockImplementation(((options: net.NetConnectOpts) => {
        const { host, port } = options as net.TcpNetConnectOpts;
        connected.push(`${host}:${port}`);
        return realConnect({ host: '127.0.0.1', port: routes[host] ?? 1 });
    }) as typeof net.connect);
    return connected;
}

afterEach(async () => {
    records = {};
    await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

describe('extractReferral', () => {
    it.each([
        ['registry referral', 'Domain Name: X\r\n   Registrar WHOIS Server: whois.markmonitor.com\r\n', 'whois.markmonitor.com'],
        ['IANA refer', 'refer:        whois.verisign-grs.com\n', 'whois.verisign-grs.com'],
        ['whois:// prefix', 'ReferralServer: whois://whois.ripe.net\n', 'whois.ripe.net'],
        ['explicit port 43', 'Whois Server: whois.nic.example:43\n', 'whois.nic.example'],
        ['uppercase host', 'Registrar WHOIS Server: WHOIS.Example.COM\n', 'whois.example.com'],
        ['real line after an injected mid-line one', 'Registrant Organization: Acme refer: 127.0.0.1\nRegistrar WHOIS Server: whois.reg.com\n', 'whois.reg.com']
    ])('finds the %s', (_, data, expected) => {
        expect(extractReferral(data)).toBe(expected);
    });

    it.each([
        ['non-43 port', 'Registrar WHOIS Server: 169.254.169.254:80\n'],
        ['rwhois', 'ReferralServer: rwhois://rwhois.x.net:4321\n'],
        ['mid-line value only', 'Registrant Organization: Acme refer: evil.com\n'],
        ['empty value', 'Registrar WHOIS Server: \nDomain Status: ok\n'],
        ['no referral', 'No match for domain "X.COM".\n']
    ])('ignores %s', (_, data) => {
        expect(extractReferral(data)).toBeUndefined();
    });
});

describe('resolvePublicHost', () => {
    it('returns the first address of a public host', async () => {
        records = { 'whois.example.net': { a: ['93.184.216.34', '93.184.216.35'] } };
        await expect(resolvePublicHost('whois.example.net')).resolves.toBe('93.184.216.34');
    });

    it.each([
        ['loopback IP', '127.0.0.1', {}],
        ['metadata IP', '169.254.169.254', {}],
        ['host resolving to a private IP', 'internal.example.net', { 'internal.example.net': { a: ['10.0.0.5'] } }],
        ['host with mixed public/private answers', 'mixed.example.net', { 'mixed.example.net': { a: ['93.184.216.34', '192.168.0.1'] } }]
    ])('refuses a %s', async (_, host, dns) => {
        records = dns as FakeRecords;
        await expect(resolvePublicHost(host)).rejects.toThrow('resolves to a non-public address');
    });
});

describe('queryServer', () => {
    it('sends the query and returns the full response', async () => {
        const port = await fakeWhoisServer((socket, query) => socket.end(`you asked: ${query}`));
        await expect(queryServer('127.0.0.1', 'example.com\r\n', port)).resolves.toBe('you asked: example.com\r\n');
    });

    it('truncates a flooding server at MAX_WHOIS_RESPONSE_BYTES and closes the socket', async () => {
        let closed = false;
        const port = await fakeWhoisServer(socket => {
            socket.on('close', () => { closed = true; });
            const timer = setInterval(() => socket.write('x'.repeat(4096)), 2);
            socket.on('close', () => clearInterval(timer));
        });
        const data = await queryServer('127.0.0.1', 'q\r\n', port);
        expect(data).toHaveLength(2048);
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(closed).toBe(true);
    });

    it('enforces a hard deadline against a server that trickles data', async () => {
        const port = await fakeWhoisServer(socket => {
            const timer = setInterval(() => socket.write('.'), 50);
            socket.on('close', () => clearInterval(timer));
        });
        const start = Date.now();
        await expect(queryServer('127.0.0.1', 'q\r\n', port)).rejects.toThrow('WHOIS lookup timed out');
        expect(Date.now() - start).toBeLessThan(1000);
    });

    it('rejects when the connection is refused', async () => {
        const port = await fakeWhoisServer(socket => socket.end());
        servers[0].close();
        await new Promise(resolve => setTimeout(resolve, 20));
        await expect(queryServer('127.0.0.1', 'q\r\n', port)).rejects.toThrow();
    });
});

describe('whoisLookup', () => {
    const registryIp = '93.184.216.34';
    const registrarIp = '151.101.1.1';

    beforeEach(() => {
        records = {
            'whois.verisign-grs.com': { a: [registryIp] },
            'whois.registrar.example': { a: [registrarIp] },
            'whois.denic.de': { a: [registryIp] }
        };
    });

    it('follows the registry referral and returns the registrar response', async () => {
        const queries: string[] = [];
        const registry = await fakeWhoisServer((socket, query) => {
            queries.push(query);
            socket.end('Domain Name: EXAMPLE.COM\r\n   Registrar WHOIS Server: whois.registrar.example\r\n');
        });
        const registrar = await fakeWhoisServer((socket, query) => {
            queries.push(query);
            socket.end('Domain Name: example.com\r\nRegistrar: Example Registrar\r\n');
        });
        const connected = routeConnections({ [registryIp]: registry, [registrarIp]: registrar });

        await expect(whoisLookup('example.com')).resolves.toContain('Registrar: Example Registrar');
        expect(queries).toEqual(['DOMAIN example.com\r\n', 'example.com\r\n']);
        expect(connected).toEqual([`${registryIp}:43`, `${registrarIp}:43`]);
    });

    it('falls back to the registry response when the registrar fails', async () => {
        const registry = await fakeWhoisServer(socket => {
            socket.end('Domain Name: EXAMPLE.COM\r\n   Registrar WHOIS Server: whois.registrar.example\r\n');
        });
        const registrar = await fakeWhoisServer(socket => socket.destroy());
        routeConnections({ [registryIp]: registry, [registrarIp]: registrar });

        await expect(whoisLookup('example.com')).resolves.toContain('Domain Name: EXAMPLE.COM');
    });

    it('never contacts a referral server that resolves to a private address', async () => {
        records['whois.registrar.example'] = { a: ['10.0.0.5'] };
        const registry = await fakeWhoisServer(socket => {
            socket.end('Domain Name: EXAMPLE.COM\r\n   Registrar WHOIS Server: whois.registrar.example\r\n');
        });
        const connected = routeConnections({ [registryIp]: registry });

        await expect(whoisLookup('example.com')).resolves.toContain('Domain Name: EXAMPLE.COM');
        expect(connected).toEqual([`${registryIp}:43`]);
    });

    it('ignores referrals to non-standard ports', async () => {
        const registry = await fakeWhoisServer(socket => {
            socket.end('Domain Name: EXAMPLE.COM\r\nRegistrar WHOIS Server: 151.101.1.1:6379\r\n');
        });
        const connected = routeConnections({ [registryIp]: registry });

        await whoisLookup('example.com');
        expect(connected).toEqual([`${registryIp}:43`]);
    });

    it('stops at the referral limit', async () => {
        // every server refers onwards to itself under a new name
        records['hop1.example'] = { a: [registrarIp] };
        records['hop2.example'] = { a: [registrarIp] };
        records['hop3.example'] = { a: [registrarIp] };
        let hop = 0;
        const loop = await fakeWhoisServer(socket => {
            hop++;
            socket.end(`answer ${hop}\r\nWhois Server: hop${hop}.example\r\n`);
        });
        const connected = routeConnections({ [registryIp]: loop, [registrarIp]: loop });

        await expect(whoisLookup('example.com')).resolves.toContain('answer 3');
        expect(connected).toHaveLength(3);
    });

    it('sends the Unicode form to registries that do not accept punycode (.de)', async () => {
        let received = '';
        const denic = await fakeWhoisServer((socket, query) => {
            received = query;
            socket.end('Domain: münchen.de\r\nStatus: connect\r\n');
        });
        routeConnections({ [registryIp]: denic });

        await whoisLookup('xn--mnchen-3ya.de');
        expect(received).toBe('-T dn münchen.de\r\n');
    });

    it('rejects when the registry server is unreachable', async () => {
        routeConnections({});
        await expect(whoisLookup('example.com')).rejects.toThrow();
    });

    it('rejects when no WHOIS server is known for the TLD', async () => {
        await expect(whoisLookup('example.zzzzunknown')).rejects.toThrow('no WHOIS server is known');
    });
});
