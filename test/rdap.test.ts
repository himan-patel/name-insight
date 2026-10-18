import { findRdapBase, parseBootstrap, parseRdapDomain, RDAP_BOOTSTRAP_URL, RdapClient } from '../app/core/rdap';
import type { JsonResponse } from '../app/core/http-client';

const bootstrapBody = {
    version: '1.0',
    services: [
        [['com', 'net'], ['https://rdap.verisign.com/com/v1/']],
        [['dev', 'app'], ['http://insecure.example/rdap/', 'https://pubapi.registry.google/rdap']],
        [['kg'], ['http://rdap.cctld.kg/']],
        [['uk'], ['https://rdap.nominet.uk/uk/']],
        'garbage'
    ]
};

const verisignExample = {
    objectClassName: 'domain',
    ldhName: 'EXAMPLE.COM',
    status: ['client delete prohibited', 'client transfer prohibited'],
    events: [
        { eventAction: 'registration', eventDate: '1995-08-14T04:00:00Z' },
        { eventAction: 'expiration', eventDate: '2027-08-13T04:00:00Z' },
        { eventAction: 'last changed', eventDate: '2026-08-14T08:01:43Z' }
    ],
    entities: [
        { roles: ['technical'], vcardArray: ['vcard', [['fn', {}, 'text', 'Not the registrar']]] },
        { roles: ['registrar'], vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'Example Registrar']]],
            publicIds: [{ type: 'IANA Registrar ID', identifier: '376' }] }
    ],
    nameservers: [{ ldhName: 'NS1.EXAMPLE.NET' }, { ldhName: 'ns2.example.net' }, { nope: true }],
    secureDNS: { delegationSigned: true }
};

describe('parseBootstrap', () => {
    it('maps TLDs to HTTPS base URLs (normalizing the trailing slash) and skips HTTP-only services', () => {
        const map = parseBootstrap(bootstrapBody);
        expect(map.get('com')).toBe('https://rdap.verisign.com/com/v1/');
        expect(map.get('dev')).toBe('https://pubapi.registry.google/rdap/');
        expect(map.has('kg')).toBe(false);
    });

    it.each([[null], [{}], [{ services: 'x' }]])('rejects an invalid file %p', body => {
        expect(() => parseBootstrap(body)).toThrow('invalid RDAP bootstrap file');
    });
});

describe('findRdapBase', () => {
    const map = parseBootstrap(bootstrapBody);
    it.each([
        ['example.com', 'https://rdap.verisign.com/com/v1/'],
        ['deep.sub.example.co.uk', 'https://rdap.nominet.uk/uk/'],
        ['web.dev', 'https://pubapi.registry.google/rdap/'],
        ['example.io', undefined]
    ])('%s -> %s', (domain, base) => {
        expect(findRdapBase(domain, map)).toBe(base);
    });
});

describe('parseRdapDomain', () => {
    it('extracts status, dates, registrar, nameservers and DNSSEC', () => {
        expect(parseRdapDomain(verisignExample)).toEqual({
            status: ['client delete prohibited', 'client transfer prohibited'],
            created: '1995-08-14T04:00:00Z',
            expires: '2027-08-13T04:00:00Z',
            updated: '2026-08-14T08:01:43Z',
            registrar: 'Example Registrar',
            registrarIanaId: '376',
            nameservers: ['ns1.example.net', 'ns2.example.net'],
            dnssec: true
        });
    });

    it.each([[null], [{}], [{ status: 'x', events: {}, entities: 'y', nameservers: 1, secureDNS: 'z' }], [{ entities: [{ roles: ['registrar'], vcardArray: 'bad' }] }]])(
        'tolerates unexpected shapes %p',
        body => {
            expect(() => parseRdapDomain(body)).not.toThrow();
        }
    );
});

describe('RdapClient', () => {
    function client(responses: { [url: string]: JsonResponse | Error }, now = () => 0) {
        const calls: string[] = [];
        const fetchJson = jest.fn(async (url: string) => {
            calls.push(url);
            const response = responses[url];
            if (response instanceof Error) {
                throw response;
            }
            return response ?? { status: 500, body: undefined };
        });
        return { rdap: new RdapClient(fetchJson, now), calls };
    }
    const bootstrap: JsonResponse = { status: 200, body: bootstrapBody };

    it('reports a registered domain with parsed details', async () => {
        const { rdap } = client({
            [RDAP_BOOTSTRAP_URL]: bootstrap,
            'https://rdap.verisign.com/com/v1/domain/example.com': { status: 200, body: verisignExample }
        });
        await expect(rdap.lookup('example.com')).resolves.toMatchObject({
            registered: true, server: 'rdap.verisign.com', registrar: 'Example Registrar', expires: '2027-08-13T04:00:00Z'
        });
    });

    it('treats 404 as not registered (authoritative)', async () => {
        const { rdap } = client({ [RDAP_BOOTSTRAP_URL]: bootstrap });
        (rdap as unknown as { fetchJson: jest.Mock }).fetchJson.mockImplementation(async (url: string) =>
            url === RDAP_BOOTSTRAP_URL ? bootstrap : { status: 404, body: undefined });
        await expect(rdap.lookup('free-name.com')).resolves.toEqual({ registered: false, server: 'rdap.verisign.com' });
    });

    it('reports TLDs without RDAP', async () => {
        const { rdap } = client({ [RDAP_BOOTSTRAP_URL]: bootstrap });
        await expect(rdap.lookup('example.io')).resolves.toEqual({ registered: null, error: 'RDAP not available for this TLD' });
    });

    it.each([
        ['a server error', { status: 503, body: undefined }, 'RDAP lookup failed'],
        ['a non-JSON 200', { status: 200, body: undefined }, 'RDAP lookup failed'],
        ['a timeout', new Error('request timed out'), 'RDAP lookup timed out'],
        ['a refused private address', new Error('rdap.verisign.com does not resolve to a public IPv4 address'), 'RDAP lookup failed']
    ])('reports %s as unknown', async (_, response, error) => {
        const { rdap } = client({ [RDAP_BOOTSTRAP_URL]: bootstrap, 'https://rdap.verisign.com/com/v1/domain/example.com': response });
        await expect(rdap.lookup('example.com')).resolves.toEqual({ registered: null, server: 'rdap.verisign.com', error });
    });

    it('downloads the bootstrap once and shares it between concurrent lookups', async () => {
        const { rdap, calls } = client({ [RDAP_BOOTSTRAP_URL]: bootstrap });
        await Promise.all(['a.com', 'b.com', 'c.dev', 'd.io'].map(domain => rdap.lookup(domain)));
        expect(calls.filter(url => url === RDAP_BOOTSTRAP_URL)).toHaveLength(1);
    });

    it('refreshes the bootstrap after 24 hours', async () => {
        let time = 0;
        const { rdap, calls } = client({ [RDAP_BOOTSTRAP_URL]: bootstrap }, () => time);
        await rdap.lookup('a.io');
        time = 24 * 60 * 60 * 1000 + 1;
        await rdap.lookup('b.io');
        expect(calls.filter(url => url === RDAP_BOOTSTRAP_URL)).toHaveLength(2);
    });

    it('backs off for 5 minutes after a bootstrap failure', async () => {
        let time = 0;
        const { rdap, calls } = client({ [RDAP_BOOTSTRAP_URL]: new Error('boom') }, () => time);
        await expect(rdap.lookup('a.com')).resolves.toEqual({ registered: null, error: 'RDAP lookup failed' });
        await rdap.lookup('b.com');
        expect(calls).toHaveLength(1);
        time = 5 * 60 * 1000 + 1;
        await rdap.lookup('c.com');
        expect(calls).toHaveLength(2);
    });

    it('URL-encodes the domain in the request path', async () => {
        const { rdap, calls } = client({ [RDAP_BOOTSTRAP_URL]: bootstrap });
        await rdap.lookup('xn--mnchen-3ya.com');
        expect(calls[1]).toBe('https://rdap.verisign.com/com/v1/domain/xn--mnchen-3ya.com');
    });

    it('cannot reach the network in tests (default client)', async () => {
        await expect(new RdapClient().lookup('example.com')).resolves.toEqual({ registered: null, error: 'RDAP lookup failed' });
    });
});
