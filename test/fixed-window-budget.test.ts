import { FixedWindowBudget } from '../app/utils/fixed-window-budget';

describe('FixedWindowBudget', () => {
    it('charges the cost of each request until the limit, then rejects', () => {
        const budget = new FixedWindowBudget(10, 60_000);
        expect(budget.consume('a', 4, 0)).toEqual({ allowed: true, remaining: 6, retryAfterMs: 60_000 });
        expect(budget.consume('a', 6, 1_000)).toEqual({ allowed: true, remaining: 0, retryAfterMs: 59_000 });
        expect(budget.consume('a', 1, 2_000)).toEqual({ allowed: false, remaining: 0, retryAfterMs: 58_000 });
    });

    it('does not charge rejected requests', () => {
        const budget = new FixedWindowBudget(10, 60_000);
        budget.consume('a', 8, 0);
        expect(budget.consume('a', 5, 0).allowed).toBe(false);
        expect(budget.consume('a', 2, 0)).toMatchObject({ allowed: true, remaining: 0 });
    });

    it('rejects a single request that costs more than the whole budget', () => {
        expect(new FixedWindowBudget(10, 60_000).consume('a', 11, 0).allowed).toBe(false);
    });

    it('keeps separate budgets per client', () => {
        const budget = new FixedWindowBudget(5, 60_000);
        budget.consume('a', 5, 0);
        expect(budget.consume('a', 1, 0).allowed).toBe(false);
        expect(budget.consume('b', 5, 0).allowed).toBe(true);
    });

    it('resets after the window', () => {
        const budget = new FixedWindowBudget(5, 60_000);
        budget.consume('a', 5, 0);
        expect(budget.consume('a', 5, 60_000)).toMatchObject({ allowed: true, remaining: 0 });
    });

    it('bounds memory by evicting expired, then oldest, clients', () => {
        const budget = new FixedWindowBudget(5, 60_000, 3);
        budget.consume('a', 1, 0);
        budget.consume('b', 1, 1);
        budget.consume('c', 1, 2);
        budget.consume('d', 1, 3);
        expect(budget.trackedClients).toBe(3);
        // 'a' (oldest) was evicted, so it starts a fresh window
        expect(budget.consume('a', 5, 4)).toMatchObject({ allowed: true, remaining: 0 });
        expect(budget.trackedClients).toBe(3);
    });
});
