// Public
import * as express from 'express';
import multer from 'multer';

// Internal
import * as config from '../../config/global.config';
import { ExtractionType } from './extraction-type.enum';
import { clientIp } from '../client-ip';
import { requestSignal, requireJson } from '../request-guards';
import { HttpError } from '../http-error';
import { BudgetExceededError, chargeLookupBudget, chargeSuggestionBudget } from '../budgets';
import {
    createClaudeGenerator, DomainService, LookupOptions, MAX_SUGGESTION_LOOKUPS, normalizeDomain, normalizeDomainList,
    normalizeSuggestionRequest, suggestDomains, SuggestionsUnavailableError
} from '../../core';

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

/** Charges `count` lookups to the caller's budget, or rejects with 429 and Retry-After. */
function chargeLookups(req: express.Request, res: express.Response, count: number) {
    try {
        chargeLookupBudget(clientIp(req), count);
    } catch (error) {
        if (error instanceof BudgetExceededError) {
            res.set('Retry-After', String(error.retryAfterSeconds));
            throw new HttpError(429, error.message);
        }
        throw error;
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
        router.post('/api/v1/domains/info/_payload', requireJson, (req, res, next) => this.getInfoBulk(req, res, next, ExtractionType.PAYLOAD));
        router.post('/api/v1/domains/suggest', requireJson, (req, res, next) => this.suggest(req, res, next));

        return router;
    }

    async getInfoSingle(req: express.Request, res: express.Response, next: express.NextFunction) {
        try {
            const domain = normalizeDomain(req.params.domain);
            const options = lookupOptions(req);
            chargeLookups(req, res, 1);
            res.status(200).json(await this._domainService.getDomainInfo(domain, { ...options, signal: requestSignal(res) }));
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
            res.status(200).json(await this._domainService.getDomainInfoBulk(domains, { ...options, signal: requestSignal(res) }));
        } catch (error) {
            next(error);
        }
    }


    async suggest(req: express.Request, res: express.Response, next: express.NextFunction) {
        try {
            const request = normalizeSuggestionRequest(req.body);
            if (!config.claudeApiConfigured) {
                throw new SuggestionsUnavailableError();
            }
            const maxLookups = Math.min(MAX_SUGGESTION_LOOKUPS, config.lookupBudgetMax);
            chargeLookups(req, res, Math.min(request.count * request.tlds.length, maxLookups));
            // stricter per-IP limit for suggestions (each calls a paid model), shared with the hosted MCP endpoint;
            // charged after the lookup budget so a lookup-budget 429 doesn't burn a suggestion
            try {
                chargeSuggestionBudget(clientIp(req));
            } catch (error) {
                if (error instanceof BudgetExceededError) {
                    res.set('Retry-After', String(error.retryAfterSeconds));
                    throw new HttpError(429, error.message);
                }
                throw error;
            }
            res.status(200).json(await suggestDomains(request, createClaudeGenerator(), this._domainService, 'claude-api', maxLookups, requestSignal(res)));
        } catch (error) {
            next(error);
        }
    }

}
