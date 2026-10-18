// Public
import { createHash, timingSafeEqual } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';

/** SHA-256 hex digest of an API key. Only digests are configured or compared; raw keys are never stored. */
export function hashApiKey(key: string): string {
    return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** Reads a key from `Authorization: Bearer <key>` or `X-API-Key: <key>`. */
function presentedKey(req: Request): string | undefined {
    const authorization = req.get('authorization');
    const bearer = authorization?.match(/^Bearer\s+(\S+)\s*$/i)?.[1];
    return bearer ?? req.get('x-api-key')?.trim() ?? undefined;
}

/**
 * Requires a valid API key when any key digests are configured; otherwise lets every request through.
 * On success sets `res.locals.clientKey` to a non-secret identifier (a digest prefix) for rate limiting.
 */
export function apiKeyAuth(keyHashes: string[]) {
    const expected = keyHashes.map(hash => Buffer.from(hash, 'hex'));

    return (req: Request, res: Response, next: NextFunction) => {
        if (!expected.length) {
            return next();
        }
        const key = presentedKey(req);
        if (key) {
            const digest = Buffer.from(hashApiKey(key), 'hex');
            // compare against every configured digest in constant time
            let match = false;
            for (const candidate of expected) {
                match = timingSafeEqual(candidate, digest) || match;
            }
            if (match) {
                res.locals.clientKey = `key:${digest.toString('hex').slice(0, 16)}`;
                return next();
            }
        }
        res.set('WWW-Authenticate', 'Bearer realm="NameInsight"');
        res.status(401).json({ error: 'Missing or invalid API key' });
    };
}

/** Identifies the caller for rate limiting: the API key (when authenticated) or the client IP/IPv6 subnet. */
export function clientKey(req: Request, res: Response): string {
    return (res.locals.clientKey as string | undefined) ?? `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`;
}
