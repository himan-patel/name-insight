// Public
import { promises as dns } from 'dns';

// Internal
import * as config from '../config/global.config';

/**
 * Creates a DNS resolver that queries DNS directly (not the hosts file), with a timeout.
 * Uses DNS_SERVERS when configured, so internal zones of the host network can be avoided.
 */
export function createResolver(): dns.Resolver {
    const resolver = new dns.Resolver({ timeout: config.dnsTimeoutMs, tries: 1 });
    if (config.dnsServers.length) {
        resolver.setServers(config.dnsServers);
    }
    return resolver;
}
