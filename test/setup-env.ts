// Runs before each test file's modules load, so config picks these up. No real secrets belong here.
process.env.LOG_REQUESTS = 'false';
process.env.RATE_LIMIT_MAX = process.env.RATE_LIMIT_MAX || '10000';
process.env.WHOIS_TIMEOUT_MS = '500';
process.env.MAX_WHOIS_RESPONSE_BYTES = '2048';
process.env.PING_TIMEOUT_SECONDS = '1';

// Keep test output readable; errors still print.
console.info = () => undefined;
console.warn = () => undefined;
