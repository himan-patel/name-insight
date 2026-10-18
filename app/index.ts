// Internal
import * as config from './config/global.config';
import { createApp } from './http/app';
import { checkExposure } from './http/auth';
import { startServer } from './http/server';

async function main() {
    console.info(`Server.start :: Starting ${config.appName}...`);
    const exposureWarning = checkExposure({ host: config.host, keyCount: config.apiKeyHashes.length, authDisabled: config.authDisabled });
    const { shutdown } = await startServer(createApp(), {
        port: config.port,
        host: config.host,
        shutdownTimeoutMs: config.shutdownTimeoutMs
    });
    console.info(`Server.start :: Service listening on ${config.host}:${config.port}`);
    if (exposureWarning) {
        console.warn(`Server.start :: WARNING: ${exposureWarning}`);
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
