// Public
import type { NextFunction, Request, Response } from 'express';

// Internal
import * as config from '../config/global.config';
import { clientIp } from './client-ip';
import { HttpError } from './http-error';

/**
 * Requires a JSON body. Form-encoded posts are "simple" cross-origin requests that any website could make from its
 * visitors' browsers without a CORS preflight; refusing them stops that.
 */
export function requireJson(req: Request, res: Response, next: NextFunction) {
    if (!req.is('application/json')) {
        return next(new HttpError(415, 'Send a JSON body with Content-Type: application/json'));
    }
    next();
}

const inFlight = new Map<string, number>();

/** Caps how many requests one client IP may have in flight at once, so no client can monopolize lookup capacity. */
export function limitConcurrentRequests(req: Request, res: Response, next: NextFunction) {
    const client = clientIp(req);
    const current = inFlight.get(client) ?? 0;
    if (current >= config.maxConcurrentRequestsPerClient) {
        res.set('Retry-After', '1');
        return next(new HttpError(429, 'Too many concurrent requests from this client; wait for earlier ones to finish'));
    }
    inFlight.set(client, current + 1);
    let released = false;
    const release = () => {
        if (!released) {
            released = true;
            const remaining = (inFlight.get(client) ?? 1) - 1;
            if (remaining > 0) {
                inFlight.set(client, remaining);
            } else {
                inFlight.delete(client);
            }
        }
    };
    res.on('finish', release);
    res.on('close', release);
    next();
}

/** An AbortSignal that fires if the client disconnects before the response is sent, so queued lookups are skipped. */
export function requestSignal(res: Response): AbortSignal {
    const controller = new AbortController();
    res.on('close', () => {
        if (!res.writableEnded) {
            controller.abort();
        }
    });
    return controller.signal;
}
