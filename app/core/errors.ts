/**
 * Invalid input to a core operation (e.g. a malformed or private domain name). The message is safe to show
 * to callers; `details` may echo back the offending input. Transports map it to their own error format
 * (HTTP 400, MCP tool error, ...).
 */
export class ValidationError extends Error {
    constructor(message: string, public readonly details?: unknown) {
        super(message);
        this.name = 'ValidationError';
    }
}
