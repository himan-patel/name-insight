// Public
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import * as swaggerUi from 'swagger-ui-express';

// Private

// Internal
import * as config from '../config/global.config';
import { Routes } from './routes/index';
import { openApiSpec } from './docs/openapi';
import { SuggestionsFailedError, SuggestionsUnavailableError, ValidationError } from '../core';
import { HttpError } from './http-error';
import { lifecycle } from './lifecycle';
import { mcpRouter } from './mcp-route';

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

    // one per-IP request limit shared by the REST API and the hosted MCP endpoint (each request triggers outbound
    // DNS, RDAP, WHOIS and ping); MCP clients get the error in JSON-RPC form
    app.use(['/api/', '/mcp'], rateLimit({
        windowMs: config.rateLimitWindowMs,
        limit: config.rateLimitMax,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        handler: (req, res, _next, options) => {
            const message = 'Too many requests, please try again later.';
            res.status(options.statusCode).json(req.baseUrl.toLowerCase() === '/mcp'
                ? { jsonrpc: '2.0', error: { code: -32000, message }, id: null }
                : { error: message });
        }
    }));

    // public, stateless MCP endpoint (Streamable HTTP)
    app.use('/', mcpRouter());

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
        if (error instanceof SuggestionsUnavailableError) {
            return res.status(503).json({ error: error.message });
        }
        if (error instanceof SuggestionsFailedError) {
            return res.status(error.status).json({ error: error.message });
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
