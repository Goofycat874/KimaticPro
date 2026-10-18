import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CATEGORIES, Maps, bearing, compass, fmtDistance, fmtDuration, haversine, type Place, type Profile } from './osm.ts';

const location = z.string().min(1).describe('A place name or address ("Eiffel Tower", "10 Downing St, London") or coordinates as "lat, lon" ("48.8584, 2.2945").');
const mode = z.enum(['driving', 'cycling', 'walking']).default('driving').describe('How you travel.');

const latLon = { lat: z.number(), lon: z.number() };
const placeOut = z.object({
  ...latLon,
  name: z.string(),
  address: z.string(),
  category: z.string(),
  type: z.string(),
  osmUrl: z.string(),
  distanceM: z.number().optional(),
  details: z.record(z.string(), z.string()).optional(),
});

const READ_ONLY = { readOnlyHint: true, openWorldHint: true, idempotentHint: true } as const;

function fail(e: unknown): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }] };
}

function ok(text: string, data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: data };
}

const ll = (p: { lat: number; lon: number }) => `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
const placeLine = (p: Place & { distanceM?: number }, i: number) =>
  `${i + 1}. ${p.name}${p.distanceM !== undefined ? ` — ${fmtDistance(p.distanceM)}` : ''}\n   ${p.address || p.type}\n   ${ll(p)} · ${p.osmUrl}`;

export function registerTools(server: McpServer, maps: Maps) {
  server.registerTool('geocode', {
    title: 'Find a place',
    description: 'Look up places by name or address and get their coordinates. Use `near` to prefer results around a location (e.g. "pizza" near "Brooklyn").',
    inputSchema: {
      query: z.string().min(1).describe('What to look for: an address, place name, landmark or business.'),
      near: location.optional().describe('Only return results around this place or "lat, lon".'),
      radius_km: z.number().positive().max(500).optional().describe('How far around `near` to search (default 10 km).'),
      country_codes: z.array(z.string().length(2)).optional().describe('Limit to countries by ISO code, e.g. ["us", "ca"].'),
      limit: z.number().int().min(1).max(40).default(5),
      language: z.string().optional().describe('Preferred language for names, e.g. "en" or "de".'),
    },
    outputSchema: { results: z.array(placeOut) },
    annotations: { title: 'Find a place', ...READ_ONLY },
  }, async (a) => {
    try {
      const near = a.near ? await maps.resolve(a.near) : undefined;
      const results = await maps.geocode(a.query, { limit: a.limit, countryCodes: a.country_codes, near, radiusKm: a.radius_km, language: a.language });
      const list = results.map((p) => ({ ...p, boundingBox: undefined, distanceM: near ? Math.round(haversine(near, p)) : undefined }));
      const text = list.length ? list.map(placeLine).join('\n') : `No places found for “${a.query}”${near ? ' in that area' : ''}.`;
      return ok(text, { results: list });
    } catch (e) { return fail(e); }
  });

  server.registerTool('reverse_geocode', {
    title: 'What’s here?',
    description: 'Get the address or place at a coordinate.',
    inputSchema: {
      lat: z.number().min(-90).max(90),
      lon: z.number().min(-180).max(180),
      detail: z.enum(['building', 'street', 'neighbourhood', 'city', 'region', 'country']).default('building').describe('How specific the answer should be.'),
      language: z.string().optional(),
    },
    outputSchema: { place: placeOut.nullable() },
    annotations: { title: 'What’s here?', ...READ_ONLY },
  }, async (a) => {
    try {
      const zoom = { building: 18, street: 17, neighbourhood: 14, city: 10, region: 5, country: 3 }[a.detail];
      const p = await maps.reverse({ lat: a.lat, lon: a.lon }, { zoom, language: a.language });
      if (!p) return ok('Nothing found at that spot (it may be open water).', { place: null });
      const { boundingBox: _, ...place } = p;
      return ok(`${p.address || p.name}\n${ll(p)} · ${p.osmUrl}`, { place });
    } catch (e) { return fail(e); }
  });

  server.registerTool('route', {
    title: 'Directions',
    description: 'Directions between two or more stops: total distance and travel time, per-leg summaries and turn-by-turn steps. Works for driving, cycling and walking.',
    inputSchema: {
      stops: z.array(location).min(2).max(25).describe('Start, any stops in order, and the destination.'),
      mode,
      steps: z.boolean().default(true).describe('Include turn-by-turn instructions.'),
      alternatives: z.boolean().default(false).describe('Also return alternative routes (only for two stops).'),
      geometry: z.boolean().default(false).describe('Include the route line as an encoded polyline (precision 6) for drawing on a map.'),
    },
    outputSchema: {
      stops: z.array(z.object({ ...latLon, label: z.string() })),
      routes: z.array(z.object({
        distanceM: z.number(),
        durationS: z.number(),
        polyline6: z.string().optional(),
        legs: z.array(z.object({
          distanceM: z.number(),
          durationS: z.number(),
          summary: z.string(),
          steps: z.array(z.object({ instruction: z.string(), distanceM: z.number(), durationS: z.number() })).optional(),
        })),
      })),
    },
    annotations: { title: 'Directions', ...READ_ONLY },
  }, async (a) => {
    try {
      const stops = await Promise.all(a.stops.map((s) => maps.resolve(s)));
      const routes = await maps.route(stops, { profile: a.mode as Profile, steps: a.steps, alternatives: a.alternatives, geometry: a.geometry });
      const best = routes[0];
      const lines = [
        `${a.mode[0].toUpperCase()}${a.mode.slice(1)}: ${fmtDistance(best.distanceM)}, about ${fmtDuration(best.durationS)}`,
        `From ${stops[0].label} to ${stops[stops.length - 1].label}`,
      ];
      best.legs.forEach((leg, i) => {
        if (best.legs.length > 1) lines.push('', `Leg ${i + 1}: ${stops[i].label} → ${stops[i + 1].label} (${fmtDistance(leg.distanceM)}, ${fmtDuration(leg.durationS)})${leg.summary ? ` via ${leg.summary}` : ''}`);
        else if (leg.summary) lines.push(`Via ${leg.summary}`);
        if (leg.steps?.length) {
          lines.push('');
          leg.steps.forEach((s, k) => lines.push(`${k + 1}. ${s.instruction}${s.distanceM ? ` (${fmtDistance(s.distanceM)})` : ''}`));
        }
      });
      routes.slice(1).forEach((r, i) => lines.push('', `Alternative ${i + 1}: ${fmtDistance(r.distanceM)}, about ${fmtDuration(r.durationS)}${r.legs[0]?.summary ? ` via ${r.legs[0].summary}` : ''}`));
      return ok(lines.join('\n'), { stops, routes });
    } catch (e) { return fail(e); }
  });

  server.registerTool('travel_matrix', {
    title: 'Travel times between many places',
    description: 'Travel time and road distance from every origin to every destination in one call — for picking the closest option, planning visits or comparing locations.',
    inputSchema: {
      origins: z.array(location).min(1).max(25),
      destinations: z.array(location).min(1).max(25),
      mode,
    },
    outputSchema: {
      origins: z.array(z.object({ ...latLon, label: z.string() })),
      destinations: z.array(z.object({ ...latLon, label: z.string() })),
      durationsS: z.array(z.array(z.number().nullable())),
      distancesM: z.array(z.array(z.number().nullable())),
    },
    annotations: { title: 'Travel times between many places', ...READ_ONLY },
  }, async (a) => {
    try {
      const [origins, destinations] = await Promise.all([Promise.all(a.origins.map((s) => maps.resolve(s))), Promise.all(a.destinations.map((s) => maps.resolve(s)))]);
      const m = await maps.matrix(origins, destinations, a.mode as Profile);
      const short = (s: string) => (s.length > 40 ? `${s.slice(0, 38)}…` : s);
      const lines: string[] = [];
      origins.forEach((o, i) => {
        lines.push(`From ${short(o.label)}:`);
        destinations.forEach((d, j) => {
          const t = m.durationsS[i]?.[j], dist = m.distancesM[i]?.[j];
          lines.push(`  → ${short(d.label)}: ${t === null || t === undefined ? 'no route' : `${fmtDuration(t)}, ${fmtDistance(dist ?? 0)}`}`);
        });
      });
      return ok(lines.join('\n'), { origins, destinations, ...m });
    } catch (e) { return fail(e); }
  });

  server.registerTool('nearby', {
    title: 'What’s nearby',
    description: `Find places of a kind around a location, closest first, with opening hours, phone and website when known. Types include: ${Object.keys(CATEGORIES).join(', ')}. Any OpenStreetMap tag also works, e.g. "shop=bicycle" or "amenity=charging_station|amenity=fuel".`,
    inputSchema: {
      location,
      what: z.string().min(1).describe('The kind of place, e.g. "cafe", "pharmacy", "ev_charging", or an OSM tag like "shop=bicycle".'),
      radius_m: z.number().int().min(50).max(20000).default(1000),
      limit: z.number().int().min(1).max(100).default(10),
    },
    outputSchema: { center: z.object({ ...latLon, label: z.string() }), results: z.array(placeOut) },
    annotations: { title: 'What’s nearby', ...READ_ONLY },
  }, async (a) => {
    try {
      const center = await maps.resolve(a.location);
      const results = await maps.nearby(center, a.what, { radiusM: a.radius_m, limit: a.limit });
      const text = results.length
        ? [`${results.length} × ${a.what} within ${fmtDistance(a.radius_m)} of ${center.label}:`, ...results.map((p, i) => {
          const extra = p.details ? Object.entries(p.details).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(' · ') : '';
          return `${placeLine(p, i)}${extra ? `\n   ${extra}` : ''}`;
        })].join('\n')
        : `No ${a.what} found within ${fmtDistance(a.radius_m)} of ${center.label}. Try a bigger radius.`;
      return ok(text, { center, results });
    } catch (e) { return fail(e); }
  });

  server.registerTool('distance', {
    title: 'Straight-line distance',
    description: 'Distance as the crow flies and compass direction between two places. Instant once places are known; use `route` for travel distance.',
    inputSchema: { from: location, to: location },
    outputSchema: {
      from: z.object({ ...latLon, label: z.string() }),
      to: z.object({ ...latLon, label: z.string() }),
      distanceM: z.number(),
      bearingDeg: z.number(),
      direction: z.string(),
    },
    annotations: { title: 'Straight-line distance', ...READ_ONLY },
  }, async (a) => {
    try {
      const [from, to] = await Promise.all([maps.resolve(a.from), maps.resolve(a.to)]);
      const d = haversine(from, to), b = bearing(from, to);
      return ok(`${fmtDistance(d)} ${compass(b)} (${Math.round(b)}°) from ${from.label} to ${to.label}`,
        { from, to, distanceM: Math.round(d), bearingDeg: Math.round(b * 10) / 10, direction: compass(b) });
    } catch (e) { return fail(e); }
  });
}
