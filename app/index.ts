// Internal
import * as config from './config/global.config';
import { createApp } from './app';

const app = createApp();

console.info(`Server.start :: Starting ${config.appName}...`);
app.listen(config.port, config.host, () => {
    console.info(`Server.start :: Service listening on ${config.host}:${config.port}`);
});

function shutdown(signal: string) {
    console.info(`Server.shutdown :: Received ${signal}. Shutting down.`);
    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGQUIT', () => shutdown('SIGQUIT'));
