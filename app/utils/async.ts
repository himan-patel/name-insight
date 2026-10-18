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

/**
 * Limits how many calls of `run` execute at once; extra calls wait in FIFO order.
 */
export class Semaphore {
    private active = 0;
    private readonly waiting: (() => void)[] = [];

    constructor(private readonly max: number) { }

    async run<T>(fn: () => Promise<T>): Promise<T> {
        if (this.active >= this.max) {
            await new Promise<void>(resolve => this.waiting.push(resolve));
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
export async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;

    const worker = async () => {
        while (next < items.length) {
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
