// Public
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import helmet from 'helmet';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import * as swaggerUi from 'swagger-ui-express';

// Private

// Internal
import * as config from '../config/global.config';
import { Routes } from './routes/index';
import { openApiSpec } from './docs/openapi';
import { ValidationError } from '../core';
import { apiKeyAuth, clientKey } from './auth';
import { HttpError } from './http-error';
import { lifecycle } from './lifecycle';

/**
 * Builds the Express application: security middleware, API docs, rate limiting, routes and error handling.
 * Has no side effects (does not listen), so tests can create it with supertest.
 */
export function createApp(): express.Application {
    const app = express();

    if (config.trustProxyHops > 0) {
        app.set('trust proxy', config.trustProxyHops);
    }

    // security headers (also removes X-Powered-By)
    app.use(helmet());

    // allow cross-origin browser requests only from configured origins
    app.use(cors({ origin: config.corsOrigins.length ? config.corsOrigins : false }));

    app.use(express.urlencoded({ extended: true, limit: config.maxBodyBytes, parameterLimit: 100 }));
    app.use(express.json({ limit: config.maxBodyBytes }));

    // configure logging for REST requests
    if (config.logRequests) {
        app.use(morgan((tokens, req, res) => {
            return [
                req.hostname,
                // non-secret client id (API key digest prefix) for auditing; never the key itself
                (res as express.Response).locals?.clientKey ?? '-',
                tokens.method(req, res),
                tokens.url(req, res),
                tokens.status(req, res),
                tokens.res(req, res, 'content-length'), '-',
                tokens['response-time'](req, res), 'ms'
            ].join(' ');
        }));
    }

    // while shutting down, ask clients to drop keep-alive connections so the server can close promptly
    app.use((req, res, next) => {
        if (lifecycle.isShuttingDown()) {
            res.set('Connection', 'close');
        }
        next();
    });

    // health check for load balancers and orchestrators: 503 once shutdown has started
    app.get('/healthz', (req, res) => {
        if (lifecycle.isShuttingDown()) {
            return res.status(503).json({ status: 'shutting-down' });
        }
        res.json({ status: 'ok' });
    });

    // API docs: Swagger UI at /api-docs, raw spec at /api-docs.json
    app.get('/api-docs.json', (req, res) => res.json(openApiSpec));
    app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openApiSpec, { customSiteTitle: `${config.appName} API docs` }));

    // API key authentication (enabled when API_KEYS_SHA256 is set), then a per-client request limit
    // (each request triggers outbound DNS, ping and WHOIS). Clients are API keys, or IPs when unauthenticated.
    // a loose per-IP limit runs first so requests with missing or wrong keys can't flood or guess unlimited
    app.use('/api/', rateLimit({
        windowMs: config.rateLimitWindowMs,
        limit: config.rateLimitMax * 10,
        standardHeaders: false,
        legacyHeaders: false,
        keyGenerator: req => `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`,
        message: { error: 'Too many requests, please try again later.' }
    }));
    app.use('/api/', apiKeyAuth(config.apiKeyHashes));
    app.use('/api/', rateLimit({
        windowMs: config.rateLimitWindowMs,
        limit: config.rateLimitMax,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        keyGenerator: clientKey,
        message: { error: 'Too many requests, please try again later.' }
    }));

    // register REST endpoints
    app.use('/', Routes.register());

    app.use((req, res) => {
        res.status(404).json({ error: 'Not found' });
    });

    // central error handler: client errors are returned as-is, anything else is logged and hidden
    app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
        if (error instanceof HttpError) {
            return res.status(error.status).json({ error: error.message, details: error.details });
        }
        if (error instanceof ValidationError) {
            return res.status(400).json({ error: error.message, details: error.details });
        }
        // other client errors from Express itself (malformed JSON, body too large, bad URL encoding)
        const expressError = (error ?? {}) as { status?: number, statusCode?: number, expose?: boolean, message?: string };
        const status = expressError.status ?? expressError.statusCode ?? 500;
        if (status >= 400 && status < 500) {
            // only messages flagged as safe are returned
            return res.status(status).json({ error: expressError.expose ? expressError.message : 'Bad request' });
        }
        console.error(`Server :: Unhandled error on ${req.method} ${req.path}`, error);
        res.status(500).json({ error: 'Encountered unknown error. See server logs for details.' });
    });

    return app;
}
