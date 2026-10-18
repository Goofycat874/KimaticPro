#!/usr/bin/env node
// Maps MCP server: geocoding, directions, travel-time matrices and nearby places
// from OpenStreetMap — free, no API key. Talks MCP over stdio.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.ts';

const server = createServer();
await server.connect(new StdioServerTransport());
// stdout is the protocol channel, so anything for humans goes to stderr
console.error('kimatic-maps MCP server ready (OpenStreetMap)');
const stop = async () => { await server.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
