#!/usr/bin/env node
// Maps MCP server: geocoding, directions, travel-time matrices and nearby places
// from OpenStreetMap — free, no API key. Talks MCP over stdio.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Maps, configFromEnv } from './osm.ts';
import { registerTools } from './tools.ts';

export function createServer(maps = new Maps(configFromEnv())) {
  const server = new McpServer(
    { name: 'kimatic-maps', version: '0.1.0' },
    {
      instructions: 'Map tools backed by OpenStreetMap. Places can be names, addresses or "lat, lon". '
        + 'Use geocode to find places, nearby for "X near Y", route for directions and travel time, '
        + 'travel_matrix to compare many trips at once, and distance for straight-line distance. '
        + 'Map data © OpenStreetMap contributors (ODbL).',
    },
  );
  registerTools(server, maps);
  return server;
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/src/index.ts');
if (isMain) {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  // stdout is the protocol channel, so anything for humans goes to stderr
  console.error('kimatic-maps MCP server ready (OpenStreetMap)');
  const stop = async () => { await server.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
