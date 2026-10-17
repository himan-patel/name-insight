// Public
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import * as swaggerUi from 'swagger-ui-express';

// Private

// Internal
import * as config from './config/global.config';
import { Routes } from './routes/index';
import { openApiSpec } from './docs/openapi';
import { HttpError } from './models/http-error';

class Server {
    public app: express.Application;

    constructor() {
        this.app = express();
        this.config();
    }

    public config(): void {
        if (config.trustProxyHops > 0) {
            this.app.set('trust proxy', config.trustProxyHops);
        }

        // security headers (also removes X-Powered-By)
        this.app.use(helmet());

        // allow cross-origin browser requests only from configured origins
        this.app.use(cors({ origin: config.corsOrigins.length ? config.corsOrigins : false }));

        this.app.use(express.urlencoded({ extended: true, limit: config.maxBodyBytes, parameterLimit: 100 }));
        this.app.use(express.json({ limit: config.maxBodyBytes }));

        // configure logging for REST requests
        this.app.use(morgan((tokens, req, res) => {
            return [
                req.hostname,
                tokens.method(req, res),
                tokens.url(req, res),
                tokens.status(req, res),
                tokens.res(req, res, 'content-length'), '-',
                tokens['response-time'](req, res), 'ms'
            ].join(' ');
        }));

        // API docs: Swagger UI at /api-docs, raw spec at /api-docs.json
        this.app.get('/api-docs.json', (req, res) => res.json(openApiSpec));
        this.app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openApiSpec, { customSiteTitle: `${config.appName} API docs` }));

        // per-client rate limit on the domain endpoints (each request triggers outbound DNS, ping and WHOIS)
        this.app.use('/api/', rateLimit({
            windowMs: config.rateLimitWindowMs,
            limit: config.rateLimitMax,
            standardHeaders: 'draft-8',
            legacyHeaders: false,
            message: { error: 'Too many requests, please try again later.' }
        }));

        // register REST endpoints
        this.app.use('/', Routes.register());

        this.app.use((req, res) => {
            res.status(404).json({ error: 'Not found' });
        });

        // central error handler: client errors are returned as-is, anything else is logged and hidden
        this.app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
            if (error instanceof HttpError) {
                return res.status(error.status).json({ error: error.message, details: error.details });
            }
            // other client errors from Express itself (malformed JSON, body too large, bad URL encoding)
            const expressError = error as { status?: number, statusCode?: number, expose?: boolean, message?: string } | undefined;
            const status = expressError?.status || expressError?.statusCode;
            if (status >= 400 && status < 500) {
                // only messages flagged as safe are returned
                return res.status(status).json({ error: expressError.expose ? expressError.message : 'Bad request' });
            }
            console.error(`Server :: Unhandled error on ${req.method} ${req.path}`, error);
            res.status(500).json({ error: 'Encountered unknown error. See server logs for details.' });
        });
    }

    public async gracefulShutdown(signal: string, exitCode: number = 0) {
        console.info(`Server.gracefulShutdown :: Received Signal: ${signal}. Closing Connection and Shutting Down.`);
        process.exit(exitCode);
    }

    public start(callbackFn?: () => void): void {
        console.info(`Server.start :: Starting ${config.appName}...`);

        this.app.listen(config.port, config.host, () => {
            console.info(`Server.start :: Service listening on ${config.host}:${config.port}`);
            if (callbackFn) {
                callbackFn();
            }
        });
    }
}

const server = new Server();
server.start();

process.addListener('SIGINT', () => { server.gracefulShutdown('SIGINT'); });
process.addListener('SIGTERM', () => { server.gracefulShutdown('SIGTERM'); });
process.addListener('SIGQUIT', () => { server.gracefulShutdown('SIGQUIT'); });
