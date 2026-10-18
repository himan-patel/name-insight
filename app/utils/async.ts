/**
 * Rejects with `message` if `promise` has not settled within `ms` milliseconds.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The wait queue is full; callers should back off and retry. */
export class QueueFullError extends Error {
    constructor() {
        super('Server is busy');
        this.name = 'QueueFullError';
    }
}

/** The caller went away (or cancelled) before the work started. */
export class AbortedError extends Error {
    constructor() {
        super('Request aborted');
        this.name = 'AbortedError';
    }
}

/**
 * Limits how many calls of `run` execute at once; extra calls wait in FIFO order. The queue is bounded
 * (QueueFullError when full), and a waiting call is dropped if its AbortSignal fires before it starts.
 */
export class Semaphore {
    private active = 0;
    private readonly waiting: (() => void)[] = [];

    constructor(private readonly max: number, private readonly maxWaiting = Infinity) { }

    async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        if (signal?.aborted) {
            throw new AbortedError();
        }
        if (this.active >= this.max) {
            if (this.waiting.length >= this.maxWaiting) {
                throw new QueueFullError();
            }
            await new Promise<void>((resolve, reject) => {
                const onAbort = () => {
                    const index = this.waiting.indexOf(start);
                    if (index !== -1) {
                        this.waiting.splice(index, 1);
                    }
                    reject(new AbortedError());
                };
                const start = () => {
                    signal?.removeEventListener('abort', onAbort);
                    resolve();
                };
                this.waiting.push(start);
                signal?.addEventListener('abort', onAbort, { once: true });
            });
        } else {
            this.active++;
        }
        try {
            return await fn();
        } finally {
            const next = this.waiting.shift();
            if (next) {
                // hand the slot straight to the next waiter; `active` stays the same
                next();
            } else {
                this.active--;
            }
        }
    }
}

/**
 * Maps `items` through `fn` with at most `concurrency` calls in flight. Results keep input order.
 */
export async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;

    const worker = async () => {
        while (next < items.length) {
            if (signal?.aborted) {
                throw new AbortedError();
            }
            const index = next++;
            results[index] = await fn(items[index]);
        }
    };

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
    await Promise.all(workers);
    return results;
}

/** Message of a caught value, which may not be an Error under `strict` (`catch` gives `unknown`). */
export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
