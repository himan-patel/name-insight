// Public
import { isIPv4 } from 'net';
import * as ping from 'ping';

// Internal
import * as config from '../config/global.config';
import { createResolver } from './dns';
import { isPublicAddress, registrableDomain } from './validation';
import { assessAvailability } from './availability';
import { getInsights } from './insights';
import { rdapClient, RdapClient } from './rdap';
import { parseWhois } from './whois-parse';
import { whoisLookup } from './whois';
import type { DnsResult, DomainInfo, Insights, PingProbe, ProbeSkipReason } from './schemas';

export interface LookupOptions {
  /** Also collect nameservers, email setup and an HTTPS/TLS check (slower). */
  insights?: boolean;
  /** Fires when the caller goes away; lookups that haven't started are skipped. */
  signal?: AbortSignal;
}
import { errorMessage, mapWithConcurrency, Semaphore, withTimeout } from '../utils/async';

/** DNS errors meaning "this name has no records", as opposed to a lookup failure. */
const NO_RECORDS_CODES = ['ENOTFOUND', 'ENODATA'];

/** Caps lookups in flight across all requests (each spawns a ping process and opens sockets). */
const lookupSlots = new Semaphore(config.maxConcurrentLookups, config.maxQueuedLookups);

export class DomainService {

  constructor(private readonly rdap: RdapClient = rdapClient) { }

  /**
   * Looks up a validated domain: DNS resolution, RDAP and WHOIS in parallel, then a ping to its first public IPv4.
   * Never throws for lookup failures; they are reported in the result instead.
   * @param domain normalized domain from `normalizeDomain`
   */
  async getDomainInfo(domain: string, options: LookupOptions = {}): Promise<DomainInfo> {
    return lookupSlots.run(async () => {
      // registries only know registrable domains (bbc.co.uk), so RDAP/WHOIS use that; DNS/ping/web use the full name
      const registrable = registrableDomain(domain);
      const [resolved, rdap, whoisResult] = await Promise.all([
        this.resolveDomain(domain),
        this.rdap.lookup(registrable),
        this.whoisDomain(registrable)
      ]);
      const probe = await this.probeDomain(domain, resolved.addresses);

      const publicAddresses = resolved.addresses.filter(isPublicAddress);
      const dnsResult: DnsResult = { addresses: publicAddresses };
      if (publicAddresses.length < resolved.addresses.length) {
        dnsResult.nonPublic = true;
      }
      if (resolved.error) {
        dnsResult.error = resolved.error;
      }

      let insights: Insights | undefined;
      if (options.insights) {
        insights = await getInsights(domain, publicAddresses.length > 0 && !dnsResult.nonPublic);
      }

      const assessment = assessAvailability({
        rdap, whois: parseWhois(whoisResult.whois), dns: dnsResult, probe, dnsNameservers: insights?.nameservers,
        subdomainOf: registrable !== domain ? registrable : undefined
      });

      return {
        domain,
        registrableDomain: registrable,
        ...assessment,
        available: assessment.status === 'available',
        probe,
        dns: dnsResult,
        rdap,
        ...whoisResult,
        ...(insights ? { insights } : {})
      };
    }, options.signal);
  }

  /** Looks up several validated domains, a few at a time, keeping input order. */
  async getDomainInfoBulk(domains: string[], options: LookupOptions = {}): Promise<DomainInfo[]> {
    return mapWithConcurrency(domains, config.lookupConcurrency, domain => this.getDomainInfo(domain, options), options.signal);
  }

  /**
   * Resolves A and AAAA records directly against DNS (not the hosts file), with a timeout.
   * Returns every address, public or not; callers must filter before exposing them.
   */
  async resolveDomain(domain: string): Promise<{ addresses: string[], error?: string }> {
    const resolver = createResolver();
    const settled = await Promise.allSettled([resolver.resolve4(domain), resolver.resolve6(domain)]);

    const addresses: string[] = [];
    let error: string | undefined;
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        addresses.push(...result.value);
      } else if (!NO_RECORDS_CODES.includes(result.reason?.code)) {
        error = 'DNS lookup failed';
        console.warn(`DomainService.resolveDomain :: DNS lookup failed for [${domain}]: ${result.reason?.code}`);
      }
    }

    return error && !addresses.length ? { addresses, error } : { addresses };
  }

  /**
   * Pings the first resolved IPv4 address. The IP is pinged rather than the hostname so the address
   * checked here is the one probed (no second DNS lookup), and private/internal addresses are never probed.
   */
  async probeDomain(domain: string, addresses: string[]): Promise<PingProbe> {
    const ipv4 = addresses.find(address => isIPv4(address));
    if (!ipv4) {
      return this.skippedProbe(domain, addresses.length ? 'no-ipv4-address' : 'not-resolved');
    }
    if (!addresses.every(isPublicAddress)) {
      console.warn(`DomainService.probeDomain :: Refusing to probe [${domain}]: resolves to a non-public address`);
      return this.skippedProbe(domain, 'non-public-address');
    }

    try {
      const result = await withTimeout<ping.PingResponse>(
        ping.promise.probe(ipv4, { timeout: config.pingTimeoutSeconds }),
        (config.pingTimeoutSeconds + 2) * 1000,
        'ping timed out'
      );
      return { ...result, host: domain, numeric_host: ipv4 };
    } catch (error) {
      console.warn(`DomainService.probeDomain :: Ping failed for [${domain}]: ${errorMessage(error)}`);
      return this.skippedProbe(domain, 'ping-failed');
    }
  }

  /**
   * Gets raw WHOIS text (see `whoisLookup`). Failures are returned as `whoisError` rather than thrown.
   */
  async whoisDomain(domain: string): Promise<Pick<DomainInfo, 'whois' | 'whoisError'>> {
    try {
      return { whois: await whoisLookup(domain) };
    } catch (error) {
      const message = errorMessage(error);
      console.warn(`DomainService.whoisDomain :: WHOIS failed for [${domain}]: ${message}`);
      const timedOut = /timed out/i.test(message);
      return { whois: null, whoisError: timedOut ? 'WHOIS lookup timed out' : 'WHOIS lookup failed' };
    }
  }

  /** Probe result in the same shape the ping library returns for an unreachable host. */
  private skippedProbe(domain: string, skipped: ProbeSkipReason): PingProbe {
    return {
      host: domain,
      alive: false,
      output: '',
      time: 'unknown',
      times: [],
      min: 'unknown',
      max: 'unknown',
      avg: 'unknown',
      stddev: 'unknown',
      packetLoss: 'unknown',
      skipped
    };
  }

  /**
   * Extracts domains from an uploaded text file: one per line, blank lines and `#` comments ignored.
   */
  parseDomainFile(contents: Buffer): string[] {
    return contents.toString('utf8')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'));
  }

}
