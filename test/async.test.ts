import { mapWithConcurrency, Semaphore, withTimeout } from '../app/utils/async';

const delay = <T>(ms: number, value?: T) => new Promise<T>(resolve => setTimeout(() => resolve(value as T), ms));

describe('withTimeout', () => {
    it('resolves with the value when the promise settles in time', async () => {
        await expect(withTimeout(delay(5, 'ok'), 100, 'too slow')).resolves.toBe('ok');
    });

    it('rejects with the given message when the promise is too slow', async () => {
        await expect(withTimeout(delay(100, 'late'), 10, 'too slow')).rejects.toThrow('too slow');
    });

    it('passes through rejections', async () => {
        await expect(withTimeout(Promise.reject(new Error('boom')), 100, 'too slow')).rejects.toThrow('boom');
    });
});

describe('mapWithConcurrency', () => {
    it('keeps input order and respects the concurrency limit', async () => {
        let active = 0;
        let peak = 0;
        const results = await mapWithConcurrency([30, 5, 20, 1, 10, 15], 2, async ms => {
            active++;
            peak = Math.max(peak, active);
            await delay(ms);
            active--;
            return ms * 2;
        });
        expect(results).toEqual([60, 10, 40, 2, 20, 30]);
        expect(peak).toBe(2);
    });

    it('handles an empty list', async () => {
        await expect(mapWithConcurrency([], 3, async x => x)).resolves.toEqual([]);
    });

    it('rejects when a mapper rejects', async () => {
        await expect(mapWithConcurrency([1, 2], 2, async x => {
            if (x === 2) {
                throw new Error('bad item');
            }
            return x;
        })).rejects.toThrow('bad item');
    });
});

describe('Semaphore', () => {
    it('never runs more than max tasks at once and releases slots after failures', async () => {
        const semaphore = new Semaphore(3);
        let active = 0;
        let peak = 0;
        const job = (i: number) => semaphore.run(async () => {
            active++;
            peak = Math.max(peak, active);
            await delay(5);
            active--;
            if (i === 4) {
                throw new Error('job failed');
            }
            return i;
        });

        const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => job(i)));
        expect(peak).toBe(3);
        expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
        // all slots released: a new task runs immediately
        await expect(semaphore.run(async () => 'free')).resolves.toBe('free');
    });

    it('runs waiting tasks in FIFO order', async () => {
        const semaphore = new Semaphore(1);
        const order: number[] = [];
        await Promise.all([1, 2, 3, 4].map(i => semaphore.run(async () => {
            order.push(i);
            await delay(1);
        })));
        expect(order).toEqual([1, 2, 3, 4]);
    });
});
