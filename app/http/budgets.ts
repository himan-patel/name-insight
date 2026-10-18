// Internal
import * as config from '../config/global.config';
import { FixedWindowBudget } from '../utils/fixed-window-budget';

/**
 * Per-client-IP budgets shared by the REST API and the hosted MCP endpoint, so switching between them doesn't
 * multiply a client's allowance. In memory and per process.
 */

/** Domains each client IP may look up per window; bulk requests cost one unit per domain. */
export const lookupBudget = new FixedWindowBudget(config.lookupBudgetMax, config.lookupBudgetWindowMs);

/** AI suggestion requests each client IP may make per window (each one calls a paid model). */
export const suggestionBudget = new FixedWindowBudget(config.suggestRateLimitMax, config.rateLimitWindowMs);

/** A client went over a budget; `retryAfterSeconds` says when to try again. */
export class BudgetExceededError extends Error {
    constructor(message: string, public readonly retryAfterSeconds: number) {
        super(message);
        this.name = 'BudgetExceededError';
    }
}

/** Charges `count` lookups to a client, or throws BudgetExceededError. */
export function chargeLookupBudget(client: string, count: number): void {
    const decision = lookupBudget.consume(client, count);
    if (!decision.allowed) {
        throw new BudgetExceededError(`Lookup budget exceeded: ${count} requested, ${decision.remaining} of ${config.lookupBudgetMax} ` +
            `remaining in this ${config.lookupBudgetWindowMs / 1000}s window`, Math.ceil(decision.retryAfterMs / 1000));
    }
}

/** Charges one AI suggestion request to a client, or throws BudgetExceededError. */
export function chargeSuggestionBudget(client: string): void {
    const decision = suggestionBudget.consume(client, 1);
    if (!decision.allowed) {
        throw new BudgetExceededError('Too many suggestion requests, please try again later.', Math.ceil(decision.retryAfterMs / 1000));
    }
}
