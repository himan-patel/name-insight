// Public
import { isIPv4 } from 'net';
import * as ping from 'ping';

// Internal
import * as config from './../config/global.config';
import { createResolver } from './dns-resolver';
import { isPublicAddress } from './domain-validation';
import { whoisLookup } from './whois.client';
import { mapWithConcurrency, Semaphore, withTimeout } from '../utils/async';

/** DNS errors meaning "this name has no records", as opposed to a lookup failure. */
const NO_RECORDS_CODES = ['ENOTFOUND', 'ENODATA'];

/** Caps lookups in flight across all requests (each spawns a ping process and opens sockets). */
const lookupSlots = new Semaphore(config.maxConcurrentLookups);

export interface DnsResult {
  /** Public addresses only; private/reserved answers are never returned to clients. */
  addresses: string[];
  /** true when the domain also resolved to private or reserved addresses (not listed). */
  nonPublic?: boolean;
  error?: string;
}

/** Ping result; extra fields come from the `ping` library or `skipped` when no ping was sent. */
export interface PingProbe {
  host: string;
  alive: boolean;
  [field: string]: unknown;
}

export interface DomainInfo {
  probe: PingProbe;
  dns: DnsResult;
  whois: string | null;
  whoisError?: string;
  available: boolean;
  domain: string;
}

export class DomainService {

  /**
   * Looks up a validated domain: DNS resolution, a ping to its first public IPv4 address, and WHOIS.
   * Never throws for lookup failures; they are reported in the result instead.
   * @param domain normalized domain from `normalizeDomain`
   */
  async getDomainInfo(domain: string): Promise<DomainInfo> {
    return lookupSlots.run(async () => {
      const [resolved, whoisResult] = await Promise.all([
        this.resolveDomain(domain),
        this.whoisDomain(domain)
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

      return {
        probe,
        dns: dnsResult,
        ...whoisResult,
        // Available only when DNS confirms there are no records and nothing answers
        available: !resolved.error && resolved.addresses.length === 0 && !probe.alive,
        domain
      };
    });
  }

  /** Looks up several validated domains, a few at a time, keeping input order. */
  async getDomainInfoBulk(domains: string[]): Promise<DomainInfo[]> {
    return mapWithConcurrency(domains, config.lookupConcurrency, domain => this.getDomainInfo(domain));
  }

  /**
   * Resolves A and AAAA records directly against DNS (not the hosts file), with a timeout.
   * Returns every address, public or not; callers must filter before exposing them.
   */
  async resolveDomain(domain: string): Promise<{ addresses: string[], error?: string }> {
    const resolver = createResolver();
    const settled = await Promise.allSettled([resolver.resolve4(domain), resolver.resolve6(domain)]);

    const addresses: string[] = [];
    let error: string;
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
      const result = await withTimeout<PingProbe>(
        ping.promise.probe(ipv4, { timeout: config.pingTimeoutSeconds }),
        (config.pingTimeoutSeconds + 2) * 1000,
        'ping timed out'
      );
      return { ...result, host: domain, numeric_host: ipv4 };
    } catch (error) {
      console.warn(`DomainService.probeDomain :: Ping failed for [${domain}]: ${error.message}`);
      return this.skippedProbe(domain, 'ping-failed');
    }
  }

  /**
   * Gets raw WHOIS text (see `whoisLookup`). Failures are returned as `whoisError` rather than thrown.
   */
  async whoisDomain(domain: string): Promise<{ whois: string | null, whoisError?: string }> {
    try {
      return { whois: await whoisLookup(domain) };
    } catch (error) {
      console.warn(`DomainService.whoisDomain :: WHOIS failed for [${domain}]: ${error.message}`);
      const timedOut = /timed out/i.test(error.message);
      return { whois: null, whoisError: timedOut ? 'WHOIS lookup timed out' : 'WHOIS lookup failed' };
    }
  }

  /** Probe result in the same shape the ping library returns for an unreachable host. */
  private skippedProbe(domain: string, skipped: string): PingProbe {
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
