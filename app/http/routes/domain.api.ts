// Public
import * as express from 'express';
import multer from 'multer';

// Internal
import * as config from '../../config/global.config';
import { ExtractionType } from './extraction-type.enum';
import { clientIp } from '../client-ip';
import { HttpError } from '../http-error';
import { FixedWindowBudget } from '../../utils/fixed-window-budget';
import { DomainService, LookupOptions, normalizeDomain, normalizeDomainList } from '../../core';

// Files are kept in memory (never written to disk) and capped in size
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 0, parts: 1 },
    fileFilter: (req, file, cb) => {
        const mimeType = file.mimetype.toLowerCase();
        if (mimeType === 'text/plain') {
            cb(null, true);
        } else {
            cb(new HttpError(400, `Unsupported file type [${mimeType}]; upload a text/plain file`));
        }
    }
}).single('file');

/** Runs multer and turns its errors into 400/413 responses instead of 500s. */
function handleUpload(req: express.Request, res: express.Response, next: express.NextFunction) {
    upload(req, res, (error: unknown) => {
        if (!error || error instanceof HttpError) {
            return next(error);
        }
        if (error instanceof multer.MulterError) {
            const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
            return next(new HttpError(status, `Invalid upload: ${error.message}`));
        }
        // anything else comes from parsing the multipart stream (e.g. truncated body)
        next(new HttpError(400, 'Malformed multipart body'));
    });
}

/** Domains each client IP may look up per window; bulk requests cost one unit per domain. */
const lookupBudget = new FixedWindowBudget(config.lookupBudgetMax, config.lookupBudgetWindowMs);

/** Charges `count` lookups to the caller's budget, or rejects with 429 and Retry-After. */
function chargeLookups(req: express.Request, res: express.Response, count: number) {
    const decision = lookupBudget.consume(clientIp(req), count);
    if (!decision.allowed) {
        res.set('Retry-After', String(Math.ceil(decision.retryAfterMs / 1000)));
        throw new HttpError(429, `Lookup budget exceeded: ${count} requested, ${decision.remaining} of ${config.lookupBudgetMax} ` +
            `remaining in this ${config.lookupBudgetWindowMs / 1000}s window`);
    }
}

/** Parses the optional `insights` query flag (true/false/1/0). */
function lookupOptions(req: express.Request): LookupOptions {
    const value = req.query.insights;
    if (value === undefined) {
        return {};
    }
    if (value === 'true' || value === '1') {
        return { insights: true };
    }
    if (value === 'false' || value === '0') {
        return { insights: false };
    }
    throw new HttpError(400, 'Invalid insights parameter: use true or false');
}

export class DomainRoutes {
    private _domainService: DomainService;

    constructor() {
        this._domainService = new DomainService();
    }

    register(router: express.Router) {
        router.get('/api/v1/domains/info/:domain', (req, res, next) => this.getInfoSingle(req, res, next));
        router.post('/api/v1/domains/info/_file', handleUpload, (req, res, next) => this.getInfoBulk(req, res, next, ExtractionType.FILE));
        router.post('/api/v1/domains/info/_payload', (req, res, next) => this.getInfoBulk(req, res, next, ExtractionType.PAYLOAD));

        return router;
    }

    async getInfoSingle(req: express.Request, res: express.Response, next: express.NextFunction) {
        try {
            const domain = normalizeDomain(req.params.domain);
            const options = lookupOptions(req);
            chargeLookups(req, res, 1);
            res.status(200).json(await this._domainService.getDomainInfo(domain, options));
        } catch (error) {
            next(error);
        }
    }

    async getInfoBulk(req: express.Request, res: express.Response, next: express.NextFunction, type: ExtractionType) {
        try {
            let rawDomains: unknown;

            switch (type) {
                case ExtractionType.FILE:
                    if (!req.file) {
                        throw new HttpError(400, 'Missing file: send a text/plain file in the "file" form field');
                    }
                    rawDomains = this._domainService.parseDomainFile(req.file.buffer);
                    break;

                case ExtractionType.PAYLOAD:
                    rawDomains = req.body?.domains;
                    break;

                default:
                    throw new HttpError(400, 'Unknown upload type');
            }

            const domains = normalizeDomainList(rawDomains, config.maxDomainsPerRequest);
            const options = lookupOptions(req);
            chargeLookups(req, res, domains.length);
            res.status(200).json(await this._domainService.getDomainInfoBulk(domains, options));
        } catch (error) {
            next(error);
        }
    }

}
