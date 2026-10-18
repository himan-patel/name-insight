import { assessAvailability, AssessmentInput, EXPIRING_SOON_DAYS } from '../app/core/availability';

const NOW = Date.parse('2026-10-17T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (offsetDays: number) => new Date(NOW + offsetDays * DAY).toISOString();

function input(overrides: Partial<AssessmentInput> = {}): AssessmentInput {
    return {
        rdap: { registered: null, error: 'RDAP not available for this TLD' },
        whois: { registered: null },
        dns: { addresses: [] },
        probe: { host: 'x.com', alive: false },
        now: NOW,
        ...overrides
    };
}

describe('assessAvailability', () => {
    it('trusts an RDAP "not registered" answer (high confidence)', () => {
        const result = assessAvailability(input({ rdap: { registered: false, server: 'rdap.example' } }));
        expect(result).toEqual({
            status: 'available', confidence: 'high',
            registration: { source: 'rdap', registered: false },
            reasons: ['Registry (RDAP) reports the domain is not registered']
        });
    });

    it('uses parsed WHOIS when RDAP is unavailable (fixes no-RDAP TLDs like .io)', () => {
        const result = assessAvailability(input({ whois: { registered: true, created: iso(-238), expires: iso(128), registrar: 'NETWORK SOLUTIONS' } }));
        expect(result.status).toBe('registered');
        expect(result.confidence).toBe('high');
        expect(result.registration).toMatchObject({ source: 'whois', ageDays: 238, daysUntilExpiry: 128, registrar: 'NETWORK SOLUTIONS' });
        expect(result.reasons[0]).toBe('WHOIS reports the domain is registered (registrar: NETWORK SOLUTIONS)');
    });

    it('prefers RDAP over WHOIS when both answer', () => {
        const result = assessAvailability(input({ rdap: { registered: true, registrar: 'From RDAP' }, whois: { registered: false } }));
        expect(result.registration.source).toBe('rdap');
        expect(result.status).toBe('registered');
    });

    it('reports WHOIS "no match" as available (high confidence)', () => {
        expect(assessAvailability(input({ whois: { registered: false } }))).toMatchObject({ status: 'available', confidence: 'high' });
    });

    it('infers registration from DNS records without registry data (medium)', () => {
        const result = assessAvailability(input({ dns: { addresses: ['93.184.216.34'] } }));
        expect(result).toMatchObject({ status: 'registered', confidence: 'medium', registration: { source: 'none', registered: null } });
    });

    it('counts private-only DNS answers and ping replies as presence', () => {
        expect(assessAvailability(input({ dns: { addresses: [], nonPublic: true } })).status).toBe('registered');
        expect(assessAvailability(input({ probe: { host: 'x', alive: true } })).status).toBe('registered');
    });

    it('estimates availability from silence (low confidence)', () => {
        expect(assessAvailability(input())).toMatchObject({ status: 'available', confidence: 'low' });
    });

    it('is unknown when nothing answers and DNS failed', () => {
        expect(assessAvailability(input({ dns: { addresses: [], error: 'DNS lookup failed' } }))).toMatchObject({ status: 'unknown', confidence: 'low' });
    });

    it.each([
        ['expiring within the threshold', { expires: iso(EXPIRING_SOON_DAYS) }, 'Expires in 30 days'],
        ['already expired', { expires: iso(-3) }, 'Expired 3 days ago (may be in a grace period)'],
        ['in redemption', { status: ['redemption period'], expires: iso(200) }, 'Registry status "redemption period": the domain is being deleted and may be released soon'],
        ['pending delete', { status: ['pending delete'] }, 'Registry status "pending delete": the domain is being deleted and may be released soon']
    ])('flags a domain %s as expiring', (_, rdapFields, reason) => {
        const result = assessAvailability(input({ rdap: { registered: true, ...rdapFields } }));
        expect(result.status).toBe('expiring');
        expect(result.reasons).toContain(reason);
    });

    it('is not expiring just outside the threshold', () => {
        expect(assessAvailability(input({ rdap: { registered: true, expires: iso(EXPIRING_SOON_DAYS + 1) } })).status).toBe('registered');
    });

    it('flags parking / marketplace nameservers as parked', () => {
        const result = assessAvailability(input({ rdap: { registered: true, nameservers: ['ns1.sedoparking.com', 'ns2.sedoparking.com'] } }));
        expect(result.status).toBe('parked');
        expect(result.reasons).toContain('Nameservers point to a parking/marketplace service (sedoparking.com); it may be for sale');
    });

    it('does not match look-alike nameserver names', () => {
        expect(assessAvailability(input({ rdap: { registered: true, nameservers: ['ns1.notsedoparking.com'] } })).status).toBe('registered');
    });

    it('ranks expiring above parked', () => {
        const result = assessAvailability(input({ rdap: { registered: true, expires: iso(5), nameservers: ['ns1.bodis.com'] } }));
        expect(result.status).toBe('expiring');
    });

    it('omits derived fields when dates are missing or invalid', () => {
        const result = assessAvailability(input({ rdap: { registered: true, created: 'garbage' } }));
        expect(result.registration.ageDays).toBeUndefined();
        expect(result.registration.daysUntilExpiry).toBeUndefined();
    });
});
