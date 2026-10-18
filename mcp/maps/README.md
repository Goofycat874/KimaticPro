# kimatic-maps — a fast, free maps MCP server

Give Claude, Codex (or any MCP client) real map skills: find places, get directions, compare travel times and see what's nearby. Built on OpenStreetMap, so there's **no API key and no bill**.

| Tool | What it does |
| --- | --- |
| `geocode` | Place name or address → coordinates. Optional `near` + `radius_km` for "pizza near Brooklyn". |
| `reverse_geocode` | Coordinates → address, at building / street / city / country detail. |
| `route` | Directions through 2–25 stops for driving, cycling or walking: distance, time, per-leg summary, turn-by-turn steps, alternatives, optional route line. |
| `travel_matrix` | Travel time and road distance from every origin to every destination in one call. |
| `nearby` | Cafés, pharmacies, EV chargers, hotels… around a place, closest first, with opening hours, phone and website. Any OSM tag works too (`shop=bicycle`). |
| `distance` | Straight-line distance and compass direction. |

Anywhere a tool takes a location you can pass a name ("Eiffel Tower"), an address, or `"lat, lon"`.

## Why it's fast

- **Cache.** Answers are kept in memory for 6 hours (2,000 entries, least-recently-used out first). Asking the same thing again is instant.
- **Shared requests.** Identical calls that arrive together make one network request.
- **No build step.** Node runs the TypeScript directly, and the server answers `initialize` in about 0.3 s.
- **Your own servers.** Point it at self-hosted Nominatim / OSRM / Overpass for millisecond answers and no rate limits (see below).

It stays polite to the free public servers: one request a second to Nominatim (their usage policy), a proper `User-Agent`, 15 s timeouts and one retry on 429/5xx.

## Use it with Claude Code

Needs Node 22.18 or newer.

```bash
cd mcp/maps && npm install
```

In this repo it's already registered in `.mcp.json`. Start Claude Code from the repo root and approve the `maps` server. Anywhere else:

```bash
claude mcp add maps -- node /absolute/path/to/mcp/maps/src/index.ts
```

Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "maps": { "command": "node", "args": ["/absolute/path/to/mcp/maps/src/index.ts"] } } }
```

## Use it with Codex

In this repo it's already set up in `.codex/config.toml`. Trust the project when Codex asks, and the `maps` server starts from whichever folder you run Codex in (it finds the repo root with `git`). Run `/mcp` in Codex to check it's connected.

Anywhere else, add it once for your user:

```bash
codex mcp add maps -- node /absolute/path/to/mcp/maps/src/index.ts
```

or put this in `~/.codex/config.toml`:

```toml
[mcp_servers.maps]
command = "node"
args = ["/absolute/path/to/mcp/maps/src/index.ts"]
startup_timeout_sec = 20
tool_timeout_sec = 60

[mcp_servers.maps.env]
MAPS_LANGUAGE = "en"   # optional, see Settings below
```

The Codex IDE extension reads the same config.

Then just ask: *"How long is the walk from the Louvre to the Eiffel Tower?"*, *"Find EV chargers within 2 km of 37.7749, -122.4194"*, or *"Which of these three offices is closest by car to each of our clients?"*

## Settings (environment variables)

| Variable | Default | Use it to |
| --- | --- | --- |
| `MAPS_NOMINATIM_URL` | `https://nominatim.openstreetmap.org` | Use your own geocoder (no 1/s limit then). |
| `MAPS_OSRM_URL` | public servers at routing.openstreetmap.de | Use your own OSRM (`/route/v1/{driving,cycling,walking}`). |
| `MAPS_OVERPASS_URL` | `https://overpass-api.de/api/interpreter` | Use another Overpass instance. |
| `MAPS_USER_AGENT` | `kimatic-maps-mcp/0.1 (+repo url)` | Identify your app to public servers. |
| `MAPS_CONTACT_EMAIL` | — | Sent to Nominatim as their policy asks for heavy use. |
| `MAPS_LANGUAGE` | — | Preferred language for names, e.g. `en`. |

### Self-hosting for maximum speed

```bash
# routing for one region (Geofabrik extracts: https://download.geofabrik.de)
docker run -t -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend osrm-extract -p /opt/car.lua /data/region.osm.pbf
docker run -t -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend osrm-partition /data/region.osrm
docker run -t -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend osrm-customize /data/region.osrm
docker run -p 5000:5000 -v "$PWD:/data" ghcr.io/project-osrm/osrm-backend osrm-routed --algorithm mld /data/region.osrm
# geocoding
docker run -p 8080:8080 -e PBF_URL=https://download.geofabrik.de/europe/monaco-latest.osm.pbf mediagis/nominatim:4.5
```

Then set `MAPS_OSRM_URL=http://localhost:5000` and `MAPS_NOMINATIM_URL=http://localhost:8080`.

## Develop

```bash
npm test         # unit tests + end-to-end over stdio against local stand-in map APIs
npm run typecheck
npm start        # run the server on stdio
```

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the ODbL.
