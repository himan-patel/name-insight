// Public
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';

// Internal
import * as config from '../config/global.config';
import { DomainService } from '../core';
import { createMcpServer, ToolLimitError, ToolLimits } from '../mcp/server';
import { errorMessage } from '../utils/async';
import { BudgetExceededError, chargeLookupBudget, chargeSuggestionBudget } from './budgets';
import { clientIp } from './client-ip';

/** Maps the shared per-IP budgets onto MCP tool limits for one caller. */
function limitsFor(client: string): ToolLimits {
    const wrap = (charge: () => void) => {
        try {
            charge();
        } catch (error) {
            throw error instanceof BudgetExceededError
                ? new ToolLimitError(`${error.message} (retry in ${error.retryAfterSeconds}s)`)
                : error;
        }
    };
    return {
        lookups: count => wrap(() => chargeLookupBudget(client, count)),
        suggestion: () => wrap(() => chargeSuggestionBudget(client))
    };
}

const methodNotAllowed = (req: express.Request, res: express.Response) => {
    res.status(405).set('Allow', 'POST').json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed: this MCP endpoint is stateless and only accepts POST' },
        id: null
    });
};

/**
 * Public, stateless MCP endpoint over Streamable HTTP (POST /mcp). Each request gets a fresh server and transport,
 * so no session state is kept and every tool call is charged to the caller's IP budgets.
 */
export function mcpRouter(service: DomainService = new DomainService()): express.Router {
    const router = express.Router();

    router.post('/mcp', async (req, res) => {
        const server = createMcpServer(service, { limits: limitsFor(clientIp(req)) });
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
            ...(config.mcpAllowedHosts.length ? { enableDnsRebindingProtection: true, allowedHosts: config.mcpAllowedHosts } : {})
        });
        res.on('close', () => {
            void transport.close();
            void server.close();
        });
        try {
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        } catch (error) {
            console.error(`McpRoute :: Failed to handle MCP request: ${errorMessage(error)}`);
            if (!res.headersSent) {
                res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
            }
        }
    });
    router.get('/mcp', methodNotAllowed);
    router.delete('/mcp', methodNotAllowed);

    return router;
}
