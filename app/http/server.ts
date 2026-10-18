// Public
import type { Application } from 'express';
import type { Server } from 'http';

// Internal
import { lifecycle } from './lifecycle';

export interface ServerOptions {
    port: number;
    host: string;
    /** How long in-flight requests may take to finish after shutdown starts before connections are forced closed. */
    shutdownTimeoutMs: number;
}

export interface RunningServer {
    server: Server;
    /** Stops accepting connections, lets in-flight requests finish (up to the timeout), then resolves. */
    shutdown(): Promise<void>;
}

/** Starts listening and returns a handle for graceful shutdown. */
export function startServer(app: Application, options: ServerOptions): Promise<RunningServer> {
    return new Promise((resolve, reject) => {
        const server = app.listen(options.port, options.host);
        let shutdownPromise: Promise<void> | undefined;

        const shutdown = () => {
            shutdownPromise ??= new Promise<void>(done => {
                lifecycle.beginShutdown();
                // Stop accepting new connections; resolves once every open connection has ended
                server.close(() => done());
                // Keep-alive connections with no request in flight would otherwise hold shutdown open
                server.closeIdleConnections();
                const force = setTimeout(() => server.closeAllConnections(), options.shutdownTimeoutMs);
                force.unref();
            });
            return shutdownPromise;
        };

        server.once('listening', () => resolve({ server, shutdown }));
        server.once('error', reject);
    });
}
