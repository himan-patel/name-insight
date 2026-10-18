/** Process lifecycle state shared by the HTTP layer (health checks, connection handling). */
let shuttingDown = false;

export const lifecycle = {
    beginShutdown(): void {
        shuttingDown = true;
    },
    isShuttingDown(): boolean {
        return shuttingDown;
    },
    /** For tests only. */
    reset(): void {
        shuttingDown = false;
    }
};
