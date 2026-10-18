import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
