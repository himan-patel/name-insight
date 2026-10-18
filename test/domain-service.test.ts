import { fakeResolver, FakeRecords } from './helpers/fake-dns';

let records: FakeRecords = {};
jest.mock('../app/core/dns', () => ({
    createResolver: () => fakeResolver(records)
}));
jest.mock('../app/core/whois', () => ({
    whoisLookup: jest.fn()
}));
jest.mock('ping', () => ({
    promise: { probe: jest.fn() }
}));

import * as ping from 'ping';
import { DomainService } from '../app/core/domain-service';
import { whoisLookup } from '../app/core/whois';

const probe = ping.promise.probe as jest.Mock;
const whois = whoisLookup as jest.Mock;
const service = new DomainService();

beforeEach(() => {
    records = {};
    whois.mockResolvedValue('Domain Name: EXAMPLE.COM');
    probe.mockImplementation(async (host: string) => ({ host, alive: true, time: 12.3, output: 'PING ok' }));
});

describe('DomainService.getDomainInfo', () => {
    it('reports a resolving, responding domain as taken and pings its first public IPv4', async () => {
        records = { 'example.com': { a: ['93.184.216.34', '93.184.216.35'], aaaa: ['2606:2800:220:1::1'] } };

        const info = await service.getDomainInfo('example.com');

        expect(info).toMatchObject({
            domain: 'example.com',
            available: false,
            whois: 'Domain Name: EXAMPLE.COM',
            dns: { addresses: ['93.184.216.34', '93.184.216.35', '2606:2800:220:1::1'] },
            probe: { host: 'example.com', alive: true, numeric_host: '93.184.216.34' }
        });
        expect(probe).toHaveBeenCalledWith('93.184.216.34', { timeout: 1 });
    });

    it('reports a domain with no DNS records and no reply as available, without pinging', async () => {
        const info = await service.getDomainInfo('unregistered-name.com');

        expect(info.available).toBe(true);
        expect(info.dns).toEqual({ addresses: [] });
        expect(info.probe).toMatchObject({ alive: false, skipped: 'not-resolved', host: 'unregistered-name.com' });
        expect(probe).not.toHaveBeenCalled();
    });

    it('reports a resolving domain that ignores ping as not available', async () => {
        records = { 'quiet.com': { a: ['93.184.216.34'] } };
        probe.mockResolvedValue({ host: '93.184.216.34', alive: false });

        const info = await service.getDomainInfo('quiet.com');

        expect(info.available).toBe(false);
        expect(info.probe.alive).toBe(false);
    });

    it('never pings or exposes private addresses', async () => {
        records = { 'sneaky.example.net': { a: ['10.0.0.5', '93.184.216.34'], aaaa: ['::1'] } };

        const info = await service.getDomainInfo('sneaky.example.net');

        expect(probe).not.toHaveBeenCalled();
        expect(info.probe.skipped).toBe('non-public-address');
        expect(info.dns).toEqual({ addresses: ['93.184.216.34'], nonPublic: true });
        expect(info.available).toBe(false);
    });

    it('skips ping for IPv6-only domains', async () => {
        records = { 'v6only.com': { aaaa: ['2606:2800:220:1::1'] } };

        const info = await service.getDomainInfo('v6only.com');

        expect(info.probe.skipped).toBe('no-ipv4-address');
        expect(probe).not.toHaveBeenCalled();
        expect(info.available).toBe(false);
    });

    it('does not claim availability when DNS fails', async () => {
        records = { 'broken.com': { error: 'ESERVFAIL' } };

        const info = await service.getDomainInfo('broken.com');

        expect(info.dns).toEqual({ addresses: [], error: 'DNS lookup failed' });
        expect(info.available).toBe(false);
    });

    it('reports ping failures without failing the lookup', async () => {
        records = { 'example.com': { a: ['93.184.216.34'] } };
        probe.mockRejectedValue(new Error('spawn ping ENOENT'));

        const info = await service.getDomainInfo('example.com');

        expect(info.probe).toMatchObject({ alive: false, skipped: 'ping-failed' });
    });

    it.each([
        ['timed out', new Error('WHOIS lookup timed out'), 'WHOIS lookup timed out'],
        ['failed', new Error('read ECONNRESET'), 'WHOIS lookup failed']
    ])('reports WHOIS that %s as whoisError without leaking details', async (_, error, message) => {
        whois.mockRejectedValue(error);

        const info = await service.getDomainInfo('example.com');

        expect(info.whois).toBeNull();
        expect(info.whoisError).toBe(message);
    });
});

describe('DomainService.getDomainInfoBulk', () => {
    it('returns results in input order', async () => {
        records = { 'b.com': { a: ['93.184.216.34'] } };
        const results = await service.getDomainInfoBulk(['a.com', 'b.com', 'c.com']);
        expect(results.map(r => [r.domain, r.available])).toEqual([['a.com', true], ['b.com', false], ['c.com', true]]);
    });
});

describe('DomainService.parseDomainFile', () => {
    it('splits lines, trims, and skips blanks and # comments', () => {
        const file = Buffer.from('# my list\nexample.com\r\n\n  spaced.com  \n#skip.com\nlast.com');
        expect(service.parseDomainFile(file)).toEqual(['example.com', 'spaced.com', 'last.com']);
    });
});
