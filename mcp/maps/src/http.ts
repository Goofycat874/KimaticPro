// A small, fast HTTP layer for map APIs:
// - answers repeat questions from an in-memory LRU cache (map data barely changes),
// - shares one request between identical calls that arrive at the same time,
// - spaces out calls per host so public servers' usage policies are respected,
// - times out stuck requests and retries once on 429 / 5xx.

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface HttpOptions {
  userAgent: string;
  timeoutMs?: number;
  cacheTtlMs?: number;
  cacheMax?: number;
  /** Minimum gap between requests to a host, in ms (e.g. 1000 for public Nominatim). */
  minIntervalMs?: Record<string, number>;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: string;
  headers?: Record<string, string>;
  /** Skip the cache for this call. */
  fresh?: boolean;
}

class LruCache<V> {
  private map = new Map<string, { value: V; expires: number }>();
  private max: number;
  private ttl: number;
  constructor(max: number, ttl: number) { this.max = max; this.ttl = ttl; }

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) { this.map.delete(key); return undefined; }
    // refresh recency
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V) {
    this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + this.ttl });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }

  get size() { return this.map.size; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Http {
  private cache: LruCache<unknown>;
  private inflight = new Map<string, Promise<unknown>>();
  private nextSlot = new Map<string, number>();
  private opts: Required<Omit<HttpOptions, 'fetch'>> & { fetch: typeof fetch };
  stats = { requests: 0, cacheHits: 0, shared: 0 };

  constructor(opts: HttpOptions) {
    this.opts = {
      timeoutMs: 15_000, cacheTtlMs: 6 * 60 * 60 * 1000, cacheMax: 2000, minIntervalMs: {},
      ...opts,
      fetch: opts.fetch ?? fetch,
    };
    this.cache = new LruCache(this.opts.cacheMax, this.opts.cacheTtlMs);
  }

  async json<T>(url: string, req: RequestOptions = {}): Promise<T> {
    const key = `${req.method ?? 'GET'} ${url} ${req.body ?? ''}`;
    if (!req.fresh) {
      const hit = this.cache.get(key);
      if (hit !== undefined) { this.stats.cacheHits++; return hit as T; }
      const pending = this.inflight.get(key);
      if (pending) { this.stats.shared++; return pending as Promise<T>; }
    }
    const p = this.fetchJson<T>(url, req)
      .then((v) => { this.cache.set(key, v); return v; })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /** Wait for this host's next free slot (keeps us inside public rate limits). */
  private async pace(host: string) {
    const gap = this.opts.minIntervalMs[host] ?? 0;
    if (!gap) return;
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot.get(host) ?? 0);
    this.nextSlot.set(host, slot + gap);
    if (slot > now) await sleep(slot - now);
  }

  private async fetchJson<T>(url: string, req: RequestOptions, attempt = 0): Promise<T> {
    const host = new URL(url).host;
    await this.pace(host);
    this.stats.requests++;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs);
    let res: Response;
    try {
      res = await this.opts.fetch(url, {
        method: req.method ?? 'GET',
        body: req.body,
        headers: { 'User-Agent': this.opts.userAgent, Accept: 'application/json', ...req.headers },
        signal: ctrl.signal,
      });
    } catch (e: any) {
      if (attempt === 0) return this.fetchJson(url, req, 1);
      throw new HttpError(0, e?.name === 'AbortError' ? `${host} took too long to answer` : `Couldn't reach ${host}: ${e?.message ?? e}`);
    } finally {
      clearTimeout(timer);
    }
    if ((res.status === 429 || res.status >= 500) && attempt === 0) {
      const after = Number(res.headers.get('retry-after'));
      await sleep(Math.min(5000, Number.isFinite(after) && after > 0 ? after * 1000 : 800));
      return this.fetchJson(url, req, 1);
    }
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, `${host} answered ${res.status}: ${text.slice(0, 200)}`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HttpError(res.status, `${host} sent something that isn't JSON: ${text.slice(0, 120)}`);
    }
  }
}
