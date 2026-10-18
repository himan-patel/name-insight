// Internal
import * as config from './config/global.config';
import { createApp } from './http/app';
import { startServer } from './http/server';
import { isLoopbackHost } from './http/host-guard';

async function main() {
    console.info(`Server.start :: Starting ${config.appName}...`);
    const { shutdown } = await startServer(createApp(), {
        port: config.port,
        host: config.host,
        shutdownTimeoutMs: config.shutdownTimeoutMs
    });
    console.info(`Server.start :: Service listening on ${config.host}:${config.port}`);
    if (!isLoopbackHost(config.host) && config.trustProxyHops === 0) {
        console.warn('Server.start :: WARNING: serving a public address with TRUST_PROXY_HOPS=0. If this runs behind a proxy or load ' +
            'balancer, set TRUST_PROXY_HOPS to the exact number of proxies, or every client will share one rate limit.');
    }
    if (!isLoopbackHost(config.host) && !config.allowedHosts.length) {
        console.warn('Server.start :: WARNING: ALLOWED_HOSTS is empty, so any Host header is accepted. Set it to your public hostname(s).');
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
