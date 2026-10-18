import { fakeResolver, FakeRecords } from './helpers/fake-dns';

let records: FakeRecords = {};
jest.mock('../app/core/dns', () => ({ createResolver: () => fakeResolver(records) }));
jest.mock('../app/core/whois', () => ({ whoisLookup: jest.fn() }));
jest.mock('ping', () => ({ promise: { probe: jest.fn() } }));

import * as ping from 'ping';
import request from 'supertest';

import * as config from '../app/config/global.config';
import { DomainInfoSchema, DomainService, ErrorResponseSchema } from '../app/core';
import { whoisLookup } from '../app/core/whois';
import { createApp } from '../app/http/app';
import { examples, openApiSpec } from '../app/http/docs/openapi';

const probe = ping.promise.probe as jest.Mock;
const whois = whoisLookup as jest.Mock;

beforeEach(() => {
    records = {};
    whois.mockResolvedValue('Domain Name: EXAMPLE.COM');
    probe.mockImplementation(async (host: string) => ({
        inputHost: host, host, numeric_host: host, alive: true, output: 'PING', time: 9.5, times: [9.5],
        min: '9.5', max: '9.5', avg: '9.5', stddev: '0.000', packetLoss: '0.000'
    }));
});

describe('response contract (DomainInfoSchema)', () => {
    const service = new DomainService();

    it.each([
        ['taken', { 'x.com': { a: ['93.184.216.34'] } }],
        ['available', {}],
        ['private addresses', { 'x.com': { a: ['10.0.0.1'] } }],
        ['IPv6 only', { 'x.com': { aaaa: ['2606:2800:220:1::1'] } }],
        ['DNS failure', { 'x.com': { error: 'ETIMEOUT' } }]
    ])('service output matches the schema: %s', async (_, dns) => {
        records = dns as FakeRecords;
        const info = await service.getDomainInfo('x.com');
        expect(DomainInfoSchema.parse(info)).toEqual(info);
    });

    it('service output matches the schema when WHOIS fails', async () => {
        whois.mockRejectedValue(new Error('read ECONNRESET'));
        const info = await service.getDomainInfo('x.com');
        expect(DomainInfoSchema.safeParse(info).success).toBe(true);
    });

    it('rejects shapes that break the contract', () => {
        expect(DomainInfoSchema.safeParse({ domain: 'x.com', available: 'yes' }).success).toBe(false);
    });

    it.each(Object.entries(examples))('the documented %s matches the schema', (_, example) => {
        expect(DomainInfoSchema.safeParse(example).success).toBe(true);
    });
});

describe('HTTP responses follow the contract', () => {
    const app = createApp();

    it('single and bulk lookups return DomainInfo objects', async () => {
        records = { 'example.com': { a: ['93.184.216.34'] } };
        const single = await request(app).get('/api/v1/domains/info/example.com').expect(200);
        expect(DomainInfoSchema.safeParse(single.body).success).toBe(true);

        const bulk = await request(app).post('/api/v1/domains/info/_payload').send({ domains: ['example.com', 'free.com'] }).expect(200);
        bulk.body.forEach((item: unknown) => expect(DomainInfoSchema.safeParse(item).success).toBe(true));
    });

    it('errors use the Error schema', async () => {
        const res = await request(app).get('/api/v1/domains/info/10.0.0.1').expect(400);
        expect(ErrorResponseSchema.safeParse(res.body).success).toBe(true);
    });
});

describe('generated OpenAPI spec', () => {
    it('reflects the configured limits', () => {
        const payload = openApiSpec.components?.schemas?.DomainsPayload as { properties: { domains: { maxItems: number } } };
        expect(payload.properties.domains.maxItems).toBe(config.maxDomainsPerRequest);
    });

    it('marks every DomainInfo field the API always returns as required', () => {
        const info = openApiSpec.components?.schemas?.DomainInfo as { required: string[] };
        expect(info.required.sort()).toEqual(['available', 'dns', 'domain', 'probe', 'whois']);
    });
});
