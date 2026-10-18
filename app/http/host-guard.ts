// Public
import type { NextFunction, Request, Response } from 'express';

// Internal
import * as config from '../config/global.config';

const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '::1', '[::1]'];

/** True for addresses only reachable from this machine. */
export function isLoopbackHost(host: string): boolean {
    return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/** Host names accepted in the Host header, or undefined when any host is accepted. */
export function acceptedHosts(): string[] | undefined {
    if (config.allowedHosts.length) {
        return config.allowedHosts;
    }
    return isLoopbackHost(config.host) ? LOOPBACK_NAMES : undefined;
}

/**
 * DNS-rebinding protection: rejects requests whose Host header isn't an accepted name. On a loopback bind this stops a
 * malicious website from rebinding its domain to 127.0.0.1 and driving the local server (and its API key).
 */
export function hostGuard(req: Request, res: Response, next: NextFunction) {
    const accepted = acceptedHosts();
    if (!accepted) {
        return next();
    }
    const raw = (req.headers.host ?? '').toLowerCase();
    const name = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.split(':')[0];
    if (!accepted.includes(name)) {
        return res.status(403).json({ error: 'Host not allowed' });
    }
    next();
}
