// Public
import type { Request } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';

/** Identifies a caller for per-client limits: the client IP, or its subnet for IPv6 (/56 by default). */
export function clientIp(req: Request): string {
    return ipKeyGenerator(req.ip ?? 'unknown');
}
