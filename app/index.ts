// Internal
import * as config from './config/global.config';
import { createApp } from './http/app';
import { startServer } from './http/server';

async function main() {
    console.info(`Server.start :: Starting ${config.appName}...`);
    const { shutdown } = await startServer(createApp(), {
        port: config.port,
        host: config.host,
        shutdownTimeoutMs: config.shutdownTimeoutMs
    });
    console.info(`Server.start :: Service listening on ${config.host}:${config.port}`);
    if (!config.apiKeyHashes.length && !['127.0.0.1', '::1', 'localhost'].includes(config.host)) {
        console.warn('Server.start :: WARNING: no API keys configured (API_KEYS_SHA256) and the server is reachable beyond ' +
            'localhost. Anyone who can reach it can use it. Set API_KEYS_SHA256, or API_HOST=127.0.0.1 for local use.');
    }

    let stopping = false;
    const onSignal = (signal: string) => {
        if (stopping) {
            console.info(`Server.shutdown :: Received ${signal} again. Exiting immediately.`);
            process.exit(1);
        }
        stopping = true;
        console.info(`Server.shutdown :: Received ${signal}. Finishing in-flight requests (up to ${config.shutdownTimeoutMs}ms)...`);
        shutdown().then(() => {
            console.info('Server.shutdown :: All connections closed. Bye.');
            process.exit(0);
        });
    };

    process.on('SIGINT', () => onSignal('SIGINT'));
    process.on('SIGTERM', () => onSignal('SIGTERM'));
    process.on('SIGQUIT', () => onSignal('SIGQUIT'));
}

main().catch(error => {
    console.error('Server.start :: Failed to start', error);
    process.exit(1);
});
