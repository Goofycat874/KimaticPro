// OpenStreetMap-backed map services: Nominatim (geocoding), OSRM (routing and
// travel-time matrices) and Overpass (what's nearby). All free and key-less; every
// endpoint can be pointed at your own server for more speed and no rate limits.

import { Http } from './http.ts';

export type Profile = 'driving' | 'cycling' | 'walking';

export interface Config {
  nominatimUrl: string;
  /** One OSRM server for every profile (self-hosted). Empty = public per-profile servers. */
  osrmUrl: string;
  overpassUrl: string;
  userAgent: string;
  email?: string;
  language?: string;
}

export interface LatLon { lat: number; lon: number }

export interface Place extends LatLon {
  name: string;
  address: string;
  category: string;
  type: string;
  osmUrl: string;
  boundingBox?: [number, number, number, number];
  details?: Record<string, string>;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const trim = (s: string | undefined, d: string) => (s?.trim() || d).replace(/\/+$/, '');
  return {
    nominatimUrl: trim(env.MAPS_NOMINATIM_URL, 'https://nominatim.openstreetmap.org'),
    osrmUrl: trim(env.MAPS_OSRM_URL, ''),
    overpassUrl: trim(env.MAPS_OVERPASS_URL, 'https://overpass-api.de/api/interpreter'),
    userAgent: env.MAPS_USER_AGENT?.trim() || 'kimatic-maps-mcp/0.1 (+https://github.com/goofycat874/kimaticpro)',
    email: env.MAPS_CONTACT_EMAIL?.trim() || undefined,
    language: env.MAPS_LANGUAGE?.trim() || undefined,
  };
}

const PUBLIC_OSRM: Record<Profile, string> = {
  driving: 'https://routing.openstreetmap.de/routed-car',
  cycling: 'https://routing.openstreetmap.de/routed-bike',
  walking: 'https://routing.openstreetmap.de/routed-foot',
};

/** Friendly words for common place types, mapped to OpenStreetMap tags. */
export const CATEGORIES: Record<string, string[]> = {
  cafe: ['amenity=cafe'], coffee: ['amenity=cafe'], restaurant: ['amenity=restaurant'], fast_food: ['amenity=fast_food'],
  bar: ['amenity=bar', 'amenity=pub'], pub: ['amenity=pub'], food: ['amenity=restaurant', 'amenity=fast_food', 'amenity=cafe'],
  fuel: ['amenity=fuel'], gas: ['amenity=fuel'], petrol: ['amenity=fuel'], ev_charging: ['amenity=charging_station'], charging: ['amenity=charging_station'],
  parking: ['amenity=parking'], hospital: ['amenity=hospital'], clinic: ['amenity=clinic', 'amenity=doctors'], doctor: ['amenity=doctors'],
  pharmacy: ['amenity=pharmacy'], dentist: ['amenity=dentist'], atm: ['amenity=atm'], bank: ['amenity=bank'],
  supermarket: ['shop=supermarket'], grocery: ['shop=supermarket', 'shop=convenience'], convenience: ['shop=convenience'], bakery: ['shop=bakery'],
  hotel: ['tourism=hotel', 'tourism=hostel', 'tourism=guest_house'], hostel: ['tourism=hostel'], museum: ['tourism=museum'],
  attraction: ['tourism=attraction'], viewpoint: ['tourism=viewpoint'], park: ['leisure=park'], playground: ['leisure=playground'],
  gym: ['leisure=fitness_centre'], toilets: ['amenity=toilets'], school: ['amenity=school'], university: ['amenity=university'], library: ['amenity=library'],
  police: ['amenity=police'], post_office: ['amenity=post_office'], bus_stop: ['highway=bus_stop'], train_station: ['railway=station'],
  subway: ['station=subway', 'railway=subway_entrance'], airport: ['aeroway=aerodrome'], bike_rental: ['amenity=bicycle_rental'],
  hardware: ['shop=hardware', 'shop=doityourself'], makerspace: ['leisure=hackerspace'], drinking_water: ['amenity=drinking_water'],
};

// ---------------------------------------------------------------------------
// geometry helpers

const R_EARTH = 6_371_008.8;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversine(a: LatLon, b: LatLon) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial compass bearing from a to b, degrees clockwise from north. */
export function bearing(a: LatLon, b: LatLon) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export const compass = (deg: number) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];

/** "52.52, 13.40" (or "52.52 13.40") → coordinates, or null for a place name. */
export function parseLatLon(s: string): LatLon | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(s);
  if (!m) return null;
  const lat = Number(m[1]), lon = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

const round = (v: number, d = 6) => Math.round(v * 10 ** d) / 10 ** d;
const osmUrl = (type: string | undefined, id: number | undefined, p: LatLon) =>
  type && id ? `https://www.openstreetmap.org/${type}/${id}` : `https://www.openstreetmap.org/?mlat=${round(p.lat, 6)}&mlon=${round(p.lon, 6)}#map=17/${round(p.lat, 5)}/${round(p.lon, 5)}`;

// ---------------------------------------------------------------------------
// the service

export class Maps {
  private http: Http;
  private cfg: Config;

  constructor(cfg: Config, http?: Http) {
    this.cfg = cfg;
    const publicNominatim = /nominatim\.openstreetmap\.org$/.test(new URL(cfg.nominatimUrl).host);
    this.http = http ?? new Http({
      userAgent: cfg.userAgent,
      // the public Nominatim allows one request a second; your own server needs no pacing
      minIntervalMs: publicNominatim ? { [new URL(cfg.nominatimUrl).host]: 1000 } : {},
    });
  }

  get stats() { return this.http.stats; }

  private nominatim(path: string, params: Record<string, string | number | undefined>) {
    const q = new URLSearchParams({ format: 'jsonv2', addressdetails: '1' });
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
    if (this.cfg.email) q.set('email', this.cfg.email);
    if (this.cfg.language && !q.has('accept-language')) q.set('accept-language', this.cfg.language);
    return this.http.json<any>(`${this.cfg.nominatimUrl}/${path}?${q}`);
  }

  private toPlace(r: any): Place {
    const p = { lat: Number(r.lat), lon: Number(r.lon) };
    const bb = r.boundingbox?.map(Number) as number[] | undefined;
    return {
      ...p,
      name: r.name || r.display_name?.split(',')[0] || 'Unnamed place',
      address: r.display_name ?? '',
      category: r.category ?? r.class ?? '',
      type: r.type ?? '',
      osmUrl: osmUrl(r.osm_type, r.osm_id, p),
      boundingBox: bb && bb.length === 4 ? [bb[0], bb[2], bb[1], bb[3]] : undefined, // south, west, north, east
    };
  }

  /** Find places by name or address, optionally close to a point. */
  async geocode(query: string, opts: { limit?: number; countryCodes?: string[]; near?: LatLon; radiusKm?: number; language?: string } = {}): Promise<Place[]> {
    let viewbox: string | undefined;
    if (opts.near) {
      // a box around the point; Nominatim prefers results inside it (bounded = only inside)
      const km = opts.radiusKm ?? 10;
      const dLat = km / 111.32, dLon = km / (111.32 * Math.max(0.05, Math.cos(rad(opts.near.lat))));
      viewbox = [opts.near.lon - dLon, opts.near.lat + dLat, opts.near.lon + dLon, opts.near.lat - dLat].map((v) => round(v, 5)).join(',');
    }
    const rows = await this.nominatim('search', {
      q: query,
      limit: Math.min(40, Math.max(1, opts.limit ?? 5)),
      countrycodes: opts.countryCodes?.map((c) => c.toLowerCase()).join(','),
      viewbox,
      bounded: viewbox ? 1 : undefined,
      'accept-language': opts.language,
    });
    const places = (rows as any[]).map((r) => this.toPlace(r));
    if (opts.near) places.sort((a, b) => haversine(opts.near!, a) - haversine(opts.near!, b));
    return places;
  }

  /** The address at a point. */
  async reverse(p: LatLon, opts: { zoom?: number; language?: string } = {}): Promise<Place | null> {
    const r = await this.nominatim('reverse', { lat: p.lat, lon: p.lon, zoom: opts.zoom ?? 18, 'accept-language': opts.language });
    if (!r || r.error) return null;
    return this.toPlace(r);
  }

  /** Coordinates as given, or the best match for a place name. */
  async resolve(where: string | LatLon): Promise<LatLon & { label: string }> {
    if (typeof where !== 'string') return { ...where, label: `${round(where.lat, 5)}, ${round(where.lon, 5)}` };
    const ll = parseLatLon(where);
    if (ll) return { ...ll, label: where.trim() };
    const [hit] = await this.geocode(where, { limit: 1 });
    if (!hit) throw new Error(`Couldn't find “${where}”. Try adding a city or country.`);
    return { lat: hit.lat, lon: hit.lon, label: hit.address || hit.name };
  }

  private osrm(service: 'route' | 'table', profile: Profile, pts: LatLon[], params: Record<string, string>) {
    const base = this.cfg.osrmUrl ? `${this.cfg.osrmUrl}/${service}/v1/${profile}` : `${PUBLIC_OSRM[profile]}/${service}/v1/driving`;
    const coords = pts.map((p) => `${round(p.lon, 6)},${round(p.lat, 6)}`).join(';');
    return this.http.json<any>(`${base}/${coords}?${new URLSearchParams(params)}`);
  }

  /** Route through two or more points, with turn-by-turn steps. */
  async route(pts: LatLon[], opts: { profile?: Profile; steps?: boolean; alternatives?: boolean; geometry?: boolean } = {}) {
    if (pts.length < 2) throw new Error('A route needs a start and an end.');
    const r = await this.osrm('route', opts.profile ?? 'driving', pts, {
      overview: opts.geometry ? 'simplified' : 'false',
      geometries: 'polyline6',
      steps: String(opts.steps ?? true),
      alternatives: String(!!opts.alternatives && pts.length === 2),
    });
    if (r.code !== 'Ok' || !r.routes?.length) throw new Error(osrmError(r));
    return (r.routes as any[]).map((rt) => ({
      distanceM: Math.round(rt.distance),
      durationS: Math.round(rt.duration),
      polyline6: opts.geometry ? (rt.geometry as string) : undefined,
      legs: (rt.legs as any[]).map((leg) => ({
        distanceM: Math.round(leg.distance),
        durationS: Math.round(leg.duration),
        summary: leg.summary || '',
        steps: (leg.steps as any[] | undefined)?.map((s) => ({
          instruction: instruction(s),
          distanceM: Math.round(s.distance),
          durationS: Math.round(s.duration),
        })).filter((s) => s.instruction),
      })),
    }));
  }

  /** Travel times and road distances between every origin and destination. */
  async matrix(origins: LatLon[], destinations: LatLon[], profile: Profile = 'driving') {
    const pts = [...origins, ...destinations];
    if (pts.length > 100) throw new Error('Keep it to 100 places or fewer in one matrix.');
    const r = await this.osrm('table', profile, pts, {
      sources: origins.map((_, i) => i).join(';'),
      destinations: destinations.map((_, i) => origins.length + i).join(';'),
      annotations: 'duration,distance',
    });
    if (r.code !== 'Ok') throw new Error(osrmError(r));
    const fix = (m: (number | null)[][] | undefined) => (m ?? []).map((row) => row.map((v) => (v === null ? null : Math.round(v))));
    return { durationsS: fix(r.durations), distancesM: fix(r.distances) };
  }

  /** Places of a kind around a point, closest first. */
  async nearby(center: LatLon, what: string, opts: { radiusM?: number; limit?: number } = {}) {
    const radius = Math.round(Math.min(20_000, Math.max(50, opts.radiusM ?? 1000)));
    const limit = Math.min(100, Math.max(1, opts.limit ?? 10));
    const tags = tagsFor(what);
    const filters = tags.map(([k, v]) => `nwr(around:${radius},${center.lat},${center.lon})["${esc(k)}"${v === '*' ? '' : `="${esc(v)}"`}];`).join('');
    // ask for a few extra so sorting by distance still has the closest ones
    const q = `[out:json][timeout:20];(${filters});out center tags ${Math.min(300, limit * 4)};`;
    const r = await this.http.json<any>(this.cfg.overpassUrl, {
      method: 'POST',
      body: `data=${encodeURIComponent(q)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const items = ((r.elements ?? []) as any[]).map((el) => {
      const p = { lat: Number(el.lat ?? el.center?.lat), lon: Number(el.lon ?? el.center?.lon) };
      const t = el.tags ?? {};
      const addr = [t['addr:housenumber'] && t['addr:street'] ? `${t['addr:street']} ${t['addr:housenumber']}` : t['addr:street'], t['addr:city']].filter(Boolean).join(', ');
      const details: Record<string, string> = {};
      for (const k of ['opening_hours', 'phone', 'website', 'cuisine', 'wheelchair', 'brand', 'operator', 'socket:type2', 'capacity']) if (t[k]) details[k] = t[k];
      return {
        ...p,
        name: t.name || t.brand || t.operator || prettyTag(t),
        address: addr,
        category: tags.find(([k, v]) => t[k] && (v === '*' || t[k] === v))?.[0] ?? '',
        type: tags.map(([k]) => t[k]).find(Boolean) ?? '',
        osmUrl: osmUrl(el.type, el.id, p),
        details: Object.keys(details).length ? details : undefined,
        distanceM: Math.round(haversine(center, p)),
      };
    }).filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lon));
    items.sort((a, b) => a.distanceM - b.distanceM);
    return items.slice(0, limit);
  }
}

const esc = (s: string) => s.replace(/["\\]/g, '\\$&');

/** "cafe" → amenity=cafe; "shop=bicycle" or "amenity" are used as given. */
export function tagsFor(what: string): [string, string][] {
  const key = what.trim().toLowerCase().replace(/[\s-]+/g, '_');
  // plurals too: pharmacies → pharmacy, cafes → cafe, buses → bus
  const known = CATEGORIES[key] ?? CATEGORIES[key.replace(/ies$/, 'y')] ?? CATEGORIES[key.replace(/es$/, '')] ?? CATEGORIES[key.replace(/s$/, '')];
  const list = known ?? what.split(/[|;]/).map((s) => s.trim()).filter(Boolean);
  const out = list.map((t) => {
    const [k, v] = t.split('=');
    return [k.trim(), (v ?? '*').trim()] as [string, string];
  }).filter(([k]) => /^[a-z0-9_:]+$/i.test(k));
  if (!out.length) throw new Error(`I don't know the place type “${what}”. Try one of: ${Object.keys(CATEGORIES).slice(0, 20).join(', ')}… or an OSM tag like shop=bicycle.`);
  return out;
}

function prettyTag(t: Record<string, string>) {
  const v = t.amenity ?? t.shop ?? t.tourism ?? t.leisure ?? t.railway ?? t.highway ?? 'place';
  return `Unnamed ${String(v).replace(/_/g, ' ')}`;
}

function osrmError(r: any) {
  if (r?.code === 'NoRoute') return 'There is no route between those places for this way of travelling.';
  if (r?.code === 'NoSegment') return 'One of the places is too far from any road or path.';
  return r?.message || `Routing failed (${r?.code ?? 'unknown error'}).`;
}

/** Turn an OSRM step into a short instruction like "Turn left onto Main Street". */
export function instruction(s: any): string {
  const m = s.maneuver ?? {};
  const road = s.name || s.ref || '';
  const onto = road ? ` onto ${road}` : '';
  const dir = m.modifier ? String(m.modifier) : '';
  switch (m.type) {
    case 'depart': return `Head ${compass(m.bearing_after ?? 0)}${road ? ` on ${road}` : ''}`;
    case 'arrive': return `Arrive at your destination${dir === 'left' || dir === 'right' ? ` (on the ${dir})` : ''}`;
    case 'turn': case 'end of road': case 'fork':
      return dir === 'straight' ? `Continue straight${onto}` : dir.startsWith('slight') ? `Keep ${dir.replace('slight ', '')}${onto}` : dir === 'uturn' ? `Make a U-turn${onto}` : `Turn ${dir}${onto}`;
    case 'new name': case 'continue': return road ? `Continue on ${road}` : 'Continue';
    case 'merge': return `Merge${dir ? ` ${dir.replace('slight ', '')}` : ''}${onto}`;
    case 'on ramp': return `Take the ramp${dir ? ` on the ${dir.replace('slight ', '')}` : ''}${onto}`;
    case 'off ramp': return `Take the exit${s.destinations ? ` towards ${s.destinations}` : ''}${onto}`;
    case 'roundabout': case 'rotary': case 'roundabout turn':
      return `At the roundabout, take exit ${m.exit ?? 1}${onto}`;
    case 'exit roundabout': case 'exit rotary': return `Leave the roundabout${onto}`;
    default: return road ? `Continue on ${road}` : '';
  }
}

// ---------------------------------------------------------------------------
// formatting for people

export const fmtDistance = (m: number) => (m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 9500 ? 1 : 0)} km`);
export function fmtDuration(s: number) {
  if (s < 60) return '< 1 min';
  const h = Math.floor(s / 3600), min = Math.round((s % 3600) / 60);
  return h ? `${h} h ${min} min` : `${min} min`;
}
