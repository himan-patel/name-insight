/**
 * Error carrying an HTTP status and a message that is safe to return to the client.
 */
export class HttpError extends Error {
    constructor(public readonly status: number, message: string, public readonly details?: unknown) {
        super(message);
        this.name = 'HttpError';
    }
}
