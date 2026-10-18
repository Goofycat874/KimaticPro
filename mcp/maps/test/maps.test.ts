import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Http } from '../src/http.ts';
import { bearing, compass, haversine, instruction, parseLatLon, tagsFor } from '../src/osm.ts';

describe('geometry and parsing', () => {
  test('haversine and bearing', () => {
    const berlin = { lat: 52.52, lon: 13.405 }, paris = { lat: 48.8566, lon: 2.3522 };
    const d = haversine(berlin, paris);
    assert.ok(Math.abs(d - 877_500) < 3000, `Berlin–Paris ${d}`);
    assert.equal(compass(bearing(berlin, paris)), 'SW');
  });

  test('coordinates vs place names', () => {
    assert.deepEqual(parseLatLon('48.8584, 2.2945'), { lat: 48.8584, lon: 2.2945 });
    assert.deepEqual(parseLatLon('-33.86 151.21'), { lat: -33.86, lon: 151.21 });
    assert.equal(parseLatLon('Eiffel Tower'), null);
    assert.equal(parseLatLon('95, 10'), null);
  });

  test('place types become OSM tags', () => {
    assert.deepEqual(tagsFor('Cafe'), [['amenity', 'cafe']]);
    assert.deepEqual(tagsFor('pharmacies'), [['amenity', 'pharmacy']]);
    assert.deepEqual(tagsFor('shop=bicycle|amenity'), [['shop', 'bicycle'], ['amenity', '*']]);
    assert.throws(() => tagsFor('!!!'));
  });

  test('turn instructions read naturally', () => {
    assert.equal(instruction({ name: 'Main St', maneuver: { type: 'turn', modifier: 'left' } }), 'Turn left onto Main St');
    assert.equal(instruction({ name: '', maneuver: { type: 'roundabout', exit: 2 } }), 'At the roundabout, take exit 2');
    assert.equal(instruction({ name: 'A1', maneuver: { type: 'depart', bearing_after: 90 } }), 'Head E on A1');
    assert.equal(instruction({ name: 'Elm', maneuver: { type: 'fork', modifier: 'slight right' } }), 'Keep right onto Elm');
  });
});

describe('fast HTTP layer', () => {
  const fakeFetch = (log: string[], fail = 0) => (async (url: string) => {
    log.push(String(url));
    if (fail-- > 0) return new Response('busy', { status: 503 });
    await new Promise((r) => setTimeout(r, 20));
    return new Response(JSON.stringify({ url }), { status: 200 });
  }) as unknown as typeof fetch;

  test('caches answers and shares identical in-flight calls', async () => {
    const log: string[] = [];
    const http = new Http({ userAgent: 't', fetch: fakeFetch(log) });
    const [a, b] = await Promise.all([http.json('http://x/1'), http.json('http://x/1')]);
    assert.deepEqual(a, b);
    await http.json('http://x/1');
    assert.equal(log.length, 1);
    assert.equal(http.stats.shared, 1);
    assert.equal(http.stats.cacheHits, 1);
  });

  test('spaces out calls to a rate-limited host', async () => {
    const log: string[] = [];
    const http = new Http({ userAgent: 't', fetch: fakeFetch(log), minIntervalMs: { slow: 100 } });
    const t0 = Date.now();
    await Promise.all([http.json('http://slow/a'), http.json('http://slow/b'), http.json('http://slow/c')]);
    assert.ok(Date.now() - t0 >= 200, 'three calls need at least two gaps');
  });

  test('retries once when the server is busy', async () => {
    const log: string[] = [];
    const http = new Http({ userAgent: 't', fetch: fakeFetch(log, 1) });
    assert.deepEqual(await http.json('http://x/r'), { url: 'http://x/r' });
    assert.equal(log.length, 2);
  });
});

// ---------------------------------------------------------------------------
// end to end: the real server over stdio, with map APIs served by a local stand-in

const PLACES: Record<string, { lat: string; lon: string; display_name: string; name: string }> = {
  'brandenburg gate': { lat: '52.5163', lon: '13.3777', display_name: 'Brandenburger Tor, Pariser Platz, Berlin, Germany', name: 'Brandenburger Tor' },
  'alexanderplatz': { lat: '52.5219', lon: '13.4132', display_name: 'Alexanderplatz, Mitte, Berlin, Germany', name: 'Alexanderplatz' },
};

function mockApis(): Promise<{ server: Server; url: string; hits: string[] }> {
  const hits: string[] = [];
  const server = createHttpServer(async (req, res) => {
    const u = new URL(req.url!, 'http://local');
    hits.push(`${req.method} ${u.pathname}`);
    const send = (o: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (u.pathname === '/nominatim/search') {
      const p = PLACES[(u.searchParams.get('q') ?? '').toLowerCase()];
      return send(p ? [{ ...p, osm_type: 'node', osm_id: 1, category: 'tourism', type: 'attraction', boundingbox: ['52.5', '52.6', '13.3', '13.4'] }] : []);
    }
    if (u.pathname === '/nominatim/reverse') return send({ ...PLACES['brandenburg gate'], osm_type: 'way', osm_id: 2, category: 'tourism', type: 'attraction' });
    if (u.pathname.startsWith('/osrm/route/v1/')) {
      const n = u.pathname.split('/').pop()!.split(';').length;
      const leg = {
        distance: 3200, duration: 540, summary: 'Unter den Linden, Karl-Liebknecht-Straße',
        steps: [
          { name: 'Pariser Platz', distance: 100, duration: 20, maneuver: { type: 'depart', bearing_after: 90 } },
          { name: 'Unter den Linden', distance: 3000, duration: 500, maneuver: { type: 'turn', modifier: 'left' } },
          { name: '', distance: 0, duration: 0, maneuver: { type: 'arrive' } },
        ],
      };
      return send({ code: 'Ok', routes: [{ distance: 3200 * (n - 1), duration: 540 * (n - 1), geometry: 'abc', legs: Array(n - 1).fill(leg) }] });
    }
    if (u.pathname.startsWith('/osrm/table/v1/')) {
      const src = u.searchParams.get('sources')!.split(';').length, dst = u.searchParams.get('destinations')!.split(';').length;
      return send({ code: 'Ok', durations: Array.from({ length: src }, (_, i) => Array.from({ length: dst }, (_, j) => 300 + i * 60 + j)), distances: Array.from({ length: src }, () => Array(dst).fill(2500.4)) });
    }
    if (u.pathname === '/overpass' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      assert.match(decodeURIComponent(body), /\["amenity"="cafe"\]/);
      return send({ elements: [
        { type: 'node', id: 10, lat: 52.517, lon: 13.38, tags: { name: 'Far Café', amenity: 'cafe' } },
        { type: 'way', id: 11, center: { lat: 52.5164, lon: 13.3778 }, tags: { name: 'Gate Coffee', amenity: 'cafe', opening_hours: 'Mo-Su 08:00-18:00', 'addr:street': 'Pariser Platz', 'addr:housenumber': '1' } },
      ] });
    }
    res.statusCode = 404;
    res.end('not found');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as any).port;
    resolve({ server, url: `http://127.0.0.1:${port}`, hits });
  }));
}

describe('MCP server end to end', () => {
  let api: Awaited<ReturnType<typeof mockApis>>;
  let client: Client;

  before(async () => {
    api = await mockApis();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [new URL('../src/index.ts', import.meta.url).pathname],
      env: {
        ...process.env as Record<string, string>,
        MAPS_NOMINATIM_URL: `${api.url}/nominatim`,
        MAPS_OSRM_URL: `${api.url}/osrm`,
        MAPS_OVERPASS_URL: `${api.url}/overpass`,
      },
      stderr: 'ignore',
    });
    client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(transport);
  });

  after(async () => {
    await client?.close();
    api?.server.close();
  });

  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args }) as any;
    return { text: r.content?.[0]?.text as string, data: r.structuredContent as any, isError: !!r.isError };
  };

  test('lists all six tools as read-only', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['distance', 'geocode', 'nearby', 'reverse_geocode', 'route', 'travel_matrix']);
    for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true);
  });

  test('geocode', async () => {
    const r = await call('geocode', { query: 'Brandenburg Gate' });
    assert.equal(r.data.results[0].name, 'Brandenburger Tor');
    assert.equal(r.data.results[0].lat, 52.5163);
    assert.match(r.text, /openstreetmap\.org\/node\/1/);
  });

  test('reverse geocode', async () => {
    const r = await call('reverse_geocode', { lat: 52.5163, lon: 13.3777 });
    assert.match(r.text, /Brandenburger Tor/);
  });

  test('route with place names and coordinates, turn by turn', async () => {
    const r = await call('route', { stops: ['Brandenburg Gate', '52.5219, 13.4132'], mode: 'walking' });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.routes[0].distanceM, 3200);
    assert.match(r.text, /Walking: 3\.2 km, about 9 min/);
    assert.match(r.text, /Turn left onto Unter den Linden/);
    assert.ok(api.hits.some((h) => h.startsWith('GET /osrm/route/v1/walking/')));
  });

  test('travel matrix', async () => {
    const r = await call('travel_matrix', { origins: ['Brandenburg Gate', 'Alexanderplatz'], destinations: ['52.5, 13.4', '52.51, 13.39'] });
    assert.deepEqual(r.data.durationsS, [[300, 301], [360, 361]]);
    assert.equal(r.data.distancesM[0][0], 2500);
    assert.match(r.text, /From Brandenburger Tor/);
  });

  test('nearby sorts by distance and shows opening hours', async () => {
    const r = await call('nearby', { location: 'Brandenburg Gate', what: 'coffee', radius_m: 500 });
    assert.deepEqual(r.data.results.map((p: any) => p.name), ['Gate Coffee', 'Far Café']);
    assert.equal(r.data.results[0].address, 'Pariser Platz 1');
    assert.match(r.text, /opening hours: Mo-Su 08:00-18:00/);
  });

  test('straight-line distance', async () => {
    const r = await call('distance', { from: 'Brandenburg Gate', to: 'Alexanderplatz' });
    assert.ok(Math.abs(r.data.distanceM - 2470) < 60, String(r.data.distanceM));
    assert.equal(r.data.direction, 'E');
  });

  test('helpful errors instead of crashes', async () => {
    const r = await call('route', { stops: ['Atlantis', 'Alexanderplatz'] });
    assert.equal(r.isError, true);
    assert.match(r.text, /Couldn't find “Atlantis”/);
  });

  test('repeat questions come from the cache', async () => {
    const before = api.hits.filter((h) => h === 'GET /nominatim/search').length;
    await call('geocode', { query: 'Brandenburg Gate' });
    await call('distance', { from: 'Brandenburg Gate', to: 'Alexanderplatz' });
    assert.equal(api.hits.filter((h) => h === 'GET /nominatim/search').length, before);
  });
});
