// Minimal typings for the parts of `ping@0.4` that NameInsight uses (the package ships none).
declare module 'ping' {
    export interface PingConfig {
        /** Seconds to wait for a reply. */
        timeout?: number;
        min_reply?: number;
        v6?: boolean;
        extra?: string[];
    }

    export interface PingResponse {
        /** The address as passed to probe() (ping >= 0.4). */
        inputHost?: string;
        host: string;
        numeric_host?: string;
        alive: boolean;
        output: string;
        time: number | 'unknown';
        times: number[];
        min: string;
        max: string;
        avg: string;
        stddev: string;
        packetLoss: string;
    }

    export const promise: {
        probe(address: string, config?: PingConfig): Promise<PingResponse>;
    };
}
