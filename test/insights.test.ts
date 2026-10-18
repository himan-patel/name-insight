import { fakeResolver, FakeRecords } from './helpers/fake-dns';

let records: FakeRecords = {};
jest.mock('../app/core/dns', () => ({ createResolver: () => fakeResolver(records) }));

import { checkWebsite, describeResponse, getInsights } from '../app/core/insights';
import type { WebCheck } from '../app/core/schemas';

const NOW = Date.parse('2026-10-17T00:00:00Z');
const resolver = () => fakeResolver(records) as unknown as Parameters<typeof getInsights>[2];
const offline: WebCheck = { reachable: false, error: 'no public address' };

describe('getInsights (DNS signals)', () => {
    it('reports nameservers, MX by priority, SPF and DMARC policy', async () => {
        records = {
            'example.com': {
                ns: ['NS2.Example.net', 'ns1.example.net'],
                mx: [{ exchange: 'backup.mail.example.com', priority: 20 }, { exchange: 'Mail.Example.com', priority: 10 }],
                txt: [['google-site-verification=abc'], ['v=spf1 include:_spf.example.net ', '-all']]
            },
            '_dmarc.example.com': { txt: [['v=DMARC1; p=Reject; rua=mailto:dmarc@example.com']] }
        };
        await expect(getInsights('example.com', false, resolver())).resolves.toEqual({
            nameservers: ['ns1.example.net', 'ns2.example.net'],
            email: { mx: ['mail.example.com', 'backup.mail.example.com'], acceptsMail: true, spf: true, dmarc: true, dmarcPolicy: 'reject' },
            web: offline
        });
    });

    it('reports missing email setup', async () => {
        records = { 'bare.com': { ns: ['ns1.host.net'] } };
        await expect(getInsights('bare.com', false, resolver())).resolves.toEqual({
            nameservers: ['ns1.host.net'],
            email: { mx: [], acceptsMail: false, spf: false, dmarc: false },
            web: offline
        });
    });

    it('ignores records that only look like SPF or DMARC', async () => {
        records = { 'x.com': { txt: [['v=spf10 nope'], ['spf1 missing prefix']] }, '_dmarc.x.com': { txt: [['v=DMARC2; p=reject']] } };
        const insights = await getInsights('x.com', false, resolver());
        expect(insights.email).toEqual({ mx: [], acceptsMail: false, spf: false, dmarc: false });
    });

    it('treats a null MX (RFC 7505) as accepting no mail', async () => {
        records = { 'nomail.com': { mx: [{ exchange: '', priority: 0 }] } };
        const insights = await getInsights('nomail.com', false, resolver());
        expect(insights.email).toMatchObject({ mx: [], acceptsMail: false });
    });

    it('omits nameservers when the NS query fails (not just empty)', async () => {
        records = { 'broken.com': { error: 'ESERVFAIL' } };
        const insights = await getInsights('broken.com', false, resolver());
        expect(insights.nameservers).toBeUndefined();
    });
});

describe('describeResponse', () => {
    const socket = (overrides: object = {}) => ({
        authorized: true,
        authorizationError: null,
        getPeerCertificate: () => ({ valid_to: 'Dec 25 22:56:35 2026 GMT', issuer: { O: 'SSL Corporation', CN: 'Some CA' } }),
        ...overrides
    });

    it('reports status and a valid certificate with days remaining', () => {
        expect(describeResponse(200, undefined, socket(), NOW)).toEqual({
            reachable: true, status: 200,
            tls: { valid: true, issuer: 'SSL Corporation', validTo: '2026-12-25T22:56:35.000Z', daysRemaining: 69 }
        });
    });

    it('reports redirects without following them', () => {
        expect(describeResponse(301, 'https://www.example.com/', socket(), NOW).redirect).toBe('https://www.example.com/');
        expect(describeResponse(200, 'https://ignored.example/', socket(), NOW).redirect).toBeUndefined();
    });

    it('reports invalid certificates with the reason', () => {
        const result = describeResponse(200, undefined, socket({ authorized: false, authorizationError: 'CERT_HAS_EXPIRED',
            getPeerCertificate: () => ({ valid_to: 'Apr 12 23:59:59 2015 GMT', issuer: { CN: 'Old CA' } }) }), NOW);
        expect(result.tls).toEqual({ valid: false, error: 'CERT_HAS_EXPIRED', issuer: 'Old CA', validTo: '2015-04-12T23:59:59.000Z', daysRemaining: -4206 });
    });

    it('caps very long redirect targets', () => {
        expect(describeResponse(302, `https://x.example/${'a'.repeat(5000)}`, socket(), NOW).redirect).toHaveLength(2048);
    });

    it('omits TLS details when there is no certificate', () => {
        expect(describeResponse(200, undefined, socket({ getPeerCertificate: () => ({}) }), NOW).tls).toBeUndefined();
    });
});

describe('checkWebsite (network paths)', () => {
    it('refuses to connect to a domain that resolves to a private address', async () => {
        records = { 'internal.example.com': { a: ['10.0.0.7'] } };
        await expect(checkWebsite('internal.example.com', NOW)).resolves.toEqual({ reachable: false, error: 'not a public address' });
    });
});
