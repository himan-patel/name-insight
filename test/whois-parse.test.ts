import { parseWhois, toIsoDate } from '../app/core/whois-parse';

describe('parseWhois', () => {
    it.each([
        ['Verisign (.com)', 'No match for domain "ZZQX-UNREG-1-98123.COM".\r\n>>> Last update of whois database: 2026-10-17T18:51:41Z <<<'],
        ['Identity Digital (.io)', 'Domain not found.\r\n\r\nTerms of Use: Access to WHOIS information is provided...'],
        ['DENIC (.de)', 'Domain: zzqx-unreg-1-98123.de\nStatus: free\n'],
        ['.co', 'The queried object does not exist: DOMAIN NOT FOUND\n'],
        ['RIPE-style', '% No entries found for the selected source(s).\n']
    ])('detects "not registered" in %s output', (_, text) => {
        expect(parseWhois(text)).toEqual({ registered: false });
    });

    it('parses an ICANN-format record (.io / gTLD registrars)', () => {
        const text = [
            'Domain Name: namecraft.io',
            'Registrar WHOIS Server: whois.networksolutions.com',
            'Creation Date: 2026-02-21T13:02:54Z',
            'Registrar Registration Expiration Date: 2027-02-22T05:00:00Z',
            'Registrar: NETWORK SOLUTIONS, LLC.',
            'Domain Status: clientTransferProhibited https://icann.org/epp#clientTransferProhibited',
            'Domain Status: clientTransferProhibited https://icann.org/epp#clientTransferProhibited',
            'Name Server: NS53.WORLDNIC.COM',
            'Name Server: ns54.worldnic.com.',
            'For more information on Whois status codes, please visit https://icann.org/epp',
            'record. Networksolutions.com makes this information available "as is"'
        ].join('\r\n');
        expect(parseWhois(text)).toEqual({
            registered: true,
            created: '2026-02-21T13:02:54.000Z',
            expires: '2027-02-22T05:00:00.000Z',
            registrar: 'NETWORK SOLUTIONS, LLC.',
            status: ['client transfer prohibited'],
            nameservers: ['ns53.worldnic.com', 'ns54.worldnic.com']
        });
    });

    it('parses offsets like +0000 (.co)', () => {
        const parsed = parseWhois('Domain Name: google.co\nCreation Date: 2010-02-25T01:04:59+0000\nRegistrar: MarkMonitor, Inc.');
        expect(parsed).toMatchObject({ registered: true, created: '2010-02-25T01:04:59.000Z', registrar: 'MarkMonitor, Inc.' });
    });

    it('recognizes DENIC "Status: connect" as registered', () => {
        expect(parseWhois('Domain: denic.de\nNserver: ns1.denic.de\nStatus: connect\n')).toEqual({
            registered: true, nameservers: ['ns1.denic.de']
        });
    });

    it('does not let disclaimers mentioning "available" or "not found" decide', () => {
        const text = 'Domain Name: example.org\nNOTICE: the record may not be found in other databases; data available "as is".';
        expect(parseWhois(text).registered).toBe(true);
    });

    it('does not treat "Registrar WHOIS Server" as the registrar name', () => {
        expect(parseWhois('Domain Name: x.com\nRegistrar WHOIS Server: whois.example.com').registrar).toBeUndefined();
    });

    it.each([[null], [undefined], [''], ['% IANA WHOIS server\nrefer: whois.example']])('is non-committal for %p', text => {
        expect(parseWhois(text).registered).toBeNull();
    });
});

describe('toIsoDate', () => {
    it.each([
        ['2026-02-21T13:02:54Z', '2026-02-21T13:02:54.000Z'],
        ['2027-08-13', '2027-08-13T00:00:00.000Z'],
        ['2027-02-22T05:00:00Z (UTC)', '2027-02-22T05:00:00.000Z']
    ])('parses %p', (input, expected) => {
        expect(toIsoDate(input)).toBe(expected);
    });

    it.each([[undefined], [''], ['not a date'], ['   ']])('returns undefined for %p', input => {
        expect(toIsoDate(input)).toBeUndefined();
    });
});
