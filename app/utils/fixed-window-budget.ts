export interface BudgetDecision {
    allowed: boolean;
    remaining: number;
    /** Milliseconds until the client's window resets. */
    retryAfterMs: number;
}

/**
 * Per-client fixed-window budget where each request can cost more than one unit (e.g. one per domain).
 * In-memory and per-process; the number of tracked clients is capped so memory stays bounded.
 */
export class FixedWindowBudget {
    private readonly windows = new Map<string, { start: number, used: number }>();

    constructor(
        private readonly limit: number,
        private readonly windowMs: number,
        private readonly maxClients = 10_000
    ) { }

    consume(client: string, cost: number, now = Date.now()): BudgetDecision {
        let window = this.windows.get(client);
        if (!window || now - window.start >= this.windowMs) {
            window = { start: now, used: 0 };
            this.windows.delete(client);
            this.makeRoom(now);
            this.windows.set(client, window);
        }

        const retryAfterMs = window.start + this.windowMs - now;
        if (window.used + cost > this.limit) {
            return { allowed: false, remaining: this.limit - window.used, retryAfterMs };
        }
        window.used += cost;
        return { allowed: true, remaining: this.limit - window.used, retryAfterMs };
    }

    get trackedClients(): number {
        return this.windows.size;
    }

    /** Drops expired windows, then the oldest ones, so at most maxClients - 1 remain before an insert. */
    private makeRoom(now: number) {
        if (this.windows.size < this.maxClients) {
            return;
        }
        for (const [client, window] of this.windows) {
            if (now - window.start >= this.windowMs) {
                this.windows.delete(client);
            }
        }
        // Map iteration is insertion order, so the first keys are the oldest windows
        for (const client of this.windows.keys()) {
            if (this.windows.size < this.maxClients) {
                break;
            }
            this.windows.delete(client);
        }
    }
}
