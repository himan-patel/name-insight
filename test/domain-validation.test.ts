import { HttpError } from '../app/models/http-error';
import { isPublicAddress, normalizeDomain, normalizeDomainList } from '../app/services/domain-validation';

describe('normalizeDomain', () => {
    it.each([
        ['example.com', 'example.com'],
        ['EXAMPLE.Com', 'example.com'],
        ['  example.com  ', 'example.com'],
        ['example.com.', 'example.com'],
        ['sub.domain.co.uk', 'sub.domain.co.uk'],
        ['münchen.de', 'xn--mnchen-3ya.de'],
        ['ｅｘａｍｐｌｅ。ｃｏｍ', 'example.com'],
        ['a-b.io', 'a-b.io'],
        ['xn--mnchen-3ya.de', 'xn--mnchen-3ya.de']
    ])('accepts %p as %p', (input, expected) => {
        expect(normalizeDomain(input)).toBe(expected);
    });

    it.each([
        ['IPv4', '127.0.0.1'],
        ['private IPv4', '10.0.0.1'],
        ['IPv6', '::1'],
        ['ping option', '-c99999'],
        ['option-like label', '-fexample.com'],
        ['--help', '--help.com'],
        ['single label', 'localhost'],
        ['fullwidth localhost', 'ｌｏｃａｌｈｏｓｔ'],
        ['empty label', 'a..com'],
        ['underscore', 'exa_mple.com'],
        ['space', 'exa mple.com'],
        ['newline', 'example.com\nfoo'],
        ['tab inside', 'exam\tple.com'],
        ['carriage return inside', 'exa\rmple.com'],
        ['NUL byte', 'example.com\u0000'],
        ['bare reserved TLD', 'example'],
        ['numeric TLD', '127.1'],
        ['hex IP', '0x7f.0.0.1'],
        ['label over 63 chars', `${'a'.repeat(64)}.com`],
        ['empty', ''],
        ['too long', `${'a.'.repeat(130)}com`]
    ])('rejects %s (%p)', (_, input) => {
        expect(() => normalizeDomain(input)).toThrow(HttpError);
    });

    it.each(['foo.local', 'printer.LOCAL', 'db.internal', 'x.lan', 'a.test', 'b.invalid', 'c.localhost', 'r.home.arpa', 'x.onion'])(
        'rejects reserved/internal name %p',
        input => {
            expect(() => normalizeDomain(input)).toThrow('Reserved or internal domain names are not accepted');
        }
    );

    it('allows example.com (only the bare .example TLD is reserved)', () => {
        expect(normalizeDomain('example.com')).toBe('example.com');
    });

    it.each([[42], [null], [undefined], [{}], [['example.com']]])('rejects non-string %p', input => {
        expect(() => normalizeDomain(input)).toThrow('Domain must be a string');
    });

    it('returns a 400 HttpError that echoes the input', () => {
        try {
            normalizeDomain('10.0.0.1');
            throw new Error('expected to throw');
        } catch (error) {
            expect(error).toBeInstanceOf(HttpError);
            expect((error as HttpError).status).toBe(400);
            expect((error as HttpError).details).toEqual({ domain: '10.0.0.1' });
        }
    });

    it('validates worst-case input quickly (no catastrophic backtracking)', () => {
        const start = process.hrtime.bigint();
        for (let i = 0; i < 1000; i++) {
            try {
                normalizeDomain(`${'a-'.repeat(120)}!`);
            } catch {
                // expected
            }
        }
        expect(Number(process.hrtime.bigint() - start) / 1e6).toBeLessThan(500);
    });
});

describe('normalizeDomainList', () => {
    it('normalizes and de-duplicates while keeping order', () => {
        expect(normalizeDomainList(['B.com', 'a.com', 'b.com.', 'a.com'], 10)).toEqual(['b.com', 'a.com']);
    });

    it.each([[[]], ['example.com'], [undefined], [{ 0: 'a.com' }]])('rejects non-list or empty input %p', input => {
        expect(() => normalizeDomainList(input, 10)).toThrow('Provide a non-empty list of domains');
    });

    it('rejects lists over the maximum before validating entries', () => {
        expect(() => normalizeDomainList(['a.com', 'b.com', 'c.com'], 2)).toThrow('Too many domains: 3 provided, maximum is 2');
    });

    it('reports every invalid entry with a reason', () => {
        try {
            normalizeDomainList(['example.com', '127.0.0.1', 42, 'printer.local'], 10);
            throw new Error('expected to throw');
        } catch (error) {
            expect((error as HttpError).status).toBe(400);
            expect((error as HttpError).details).toEqual({
                invalid: [
                    { domain: '127.0.0.1', reason: 'IP addresses are not accepted; provide a domain name' },
                    { domain: 42, reason: 'Domain must be a string' },
                    { domain: 'printer.local', reason: 'Reserved or internal domain names are not accepted' }
                ]
            });
        }
    });
});

describe('isPublicAddress', () => {
    it.each(['8.8.8.8', '104.20.23.154', '1.1.1.1', '2606:4700:10::ac42:93f3', '2001:4860:4860::8888', '::ffff:8.8.8.8'])(
        'treats %p as public',
        address => expect(isPublicAddress(address)).toBe(true)
    );

    it.each([
        '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.5.4', '172.31.255.255',
        '192.0.2.1', '192.168.1.1', '198.18.0.1', '198.51.100.7', '203.0.113.9', '224.0.0.1', '255.255.255.255',
        '::', '::1', '::127.0.0.1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '2001:db8::1', '64:ff9b::808:808',
        '::ffff:10.0.0.1', '::ffff:a00:1', '::ffff:127.0.0.1', '::ffff:169.254.169.254'
    ])('treats %p as non-public', address => expect(isPublicAddress(address)).toBe(false));

    it.each(['not-an-ip', '', 'example.com', '999.1.1.1'])('treats non-IP %p as non-public', value => {
        expect(isPublicAddress(value)).toBe(false);
    });
});
