#!/usr/bin/env node
// NameInsight MCP server over stdio, for local clients such as Claude Desktop and Claude Code.
// stdout carries the MCP protocol, so every log line must go to stderr.
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

// Imported after redirecting console so module-load logging can't corrupt the protocol stream
// eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate ordering, see above
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js') as typeof import('@modelcontextprotocol/sdk/server/stdio.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate ordering, see above
const { createMcpServer } = require('./server') as typeof import('./server');

async function main() {
    const server = createMcpServer();
    await server.connect(new StdioServerTransport());
    console.error('NameInsight MCP server running on stdio');
}

main().catch(error => {
    console.error('NameInsight MCP server failed to start', error);
    process.exit(1);
});
