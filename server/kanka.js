// Zero-dependency Kanka API client shared by the MCP server and the Obsidian push script.
// Rules: the token is read from env KANKA_TOKEN, sent only in the Authorization header, never logged,
// never placed in a URL; it is referred to by sha256 prefix only. Logs go to stderr.
import crypto from "node:crypto";

export const DEFAULT_BASE = "https://api.kanka.io/1.0";

export function log(...a) { process.stderr.write(`[kanka-mcp] ${a.join(" ")}\n`); }

export class KankaError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

export function tokenSha(tok) { return tok ? crypto.createHash("sha256").update(tok).digest("hex").slice(0, 12) : null; }

/** Replace the token (and any bearer value) wherever it might appear in a string. */
export function redact(s, tok) {
  let out = String(s ?? "");
  if (tok && tok.length >= 8) out = out.split(tok).join("[redacted]");
  return out.replace(/Bearer\s+[A-Za-z0-9._\-~+/=]{8,}/gi, "Bearer [redacted]");
}

/** Only the real API, or a loopback mock for tests. */
export function resolveBase(raw) {
  if (!raw) return DEFAULT_BASE;
  let u; try { u = new URL(raw); } catch { throw new KankaError("CONFIG", "KANKA_API_BASE is not a URL"); }
  const ok = (u.protocol === "https:" && u.hostname === "api.kanka.io") ||
    (u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost"));
  if (!ok) throw new KankaError("CONFIG", "KANKA_API_BASE must be https://api.kanka.io/... or a loopback test server");
  if (u.username || u.password || u.search) throw new KankaError("CONFIG", "KANKA_API_BASE must not carry credentials or a query");
  return u.toString().replace(/\/+$/, "");
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Rate limiter: a token bucket of capacity floor(limit * 0.9) (10% headroom) whose tokens come back
 * 60 s after each one is spent (a sliding-window bucket, matching Kanka's per-minute quota).
 * The effective limit is min(server limit, KANKA_RATE_LIMIT override): overrides can only slow down.
 * syncRemaining() lowers the available tokens to the server's x-ratelimit-remaining (shared quota).
 */
export class RateLimiter {
  constructor({ limit = 30, override, minIntervalMs = 0, now = Date.now, sleep = realSleep, windowMs = 60000 } = {}) {
    this.now = now; this.sleep = sleep; this.windowMs = windowMs;
    this.override = Number.isFinite(+override) && +override > 0 ? +override : Infinity;
    this.minIntervalMs = Math.min(60000, Math.max(0, +minIntervalMs || 0)); // slow-down only, capped at 60 s
    this.lastAt = -Infinity; this.spent = []; this.blockedUntil = 0;
    this.setLimit(limit);
  }
  setLimit(serverLimit) {
    const l = Math.min(Number.isFinite(+serverLimit) && +serverLimit > 0 ? +serverLimit : 30, this.override);
    this.limit = l; this.capacity = Math.max(1, Math.floor(l * 0.9));
  }
  prune() { const cut = this.now() - this.windowMs; while (this.spent.length && this.spent[0] <= cut) this.spent.shift(); }
  get available() { this.prune(); return this.capacity - this.spent.length; }
  /** Server says only `rem` calls are left in its window: pad our log so we never exceed it. */
  syncRemaining(rem) {
    this.prune(); const allowed = Math.max(0, rem - 2);
    while (this.capacity - this.spent.length > allowed) this.spent.push(this.now());
    this.spent.sort((x, y) => x - y);
  }
  drain(ms = this.windowMs) { this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms); }
  async take() {
    for (;;) {
      this.prune(); const n = this.now();
      const waits = [this.lastAt + this.minIntervalMs - n, this.blockedUntil - n];
      if (this.spent.length >= this.capacity) waits.push(this.spent[0] + this.windowMs - n);
      const wait = Math.max(0, ...waits);
      if (wait <= 0) { this.spent.push(n); this.lastAt = n; return; }
      await this.sleep(Math.max(1, wait));
    }
  }
}

export class KankaClient {
  constructor({ token = process.env.KANKA_TOKEN, base = process.env.KANKA_API_BASE, sleep = realSleep, now = Date.now,
    rateOverride = process.env.KANKA_RATE_LIMIT, minIntervalMs = process.env.KANKA_MIN_INTERVAL_MS, maxRetries = 5, fetchImpl = globalThis.fetch } = {}) {
    this.token = token || "";
    this.base = resolveBase(base);
    this.sleep = sleep;
    this.maxRetries = maxRetries;
    this.fetch = fetchImpl;
    this.limiter = new RateLimiter({ limit: 30, override: rateOverride, minIntervalMs, now, sleep });
    this.calls = 0;
    this.last429 = null;
  }
  get tokenSha() { return tokenSha(this.token); }
  url(path, query) {
    const p = String(path).replace(/^\/+/, "");
    if (/(^|\/)\.\.(\/|$)|%2e%2e|%2f/i.test(p)) throw new KankaError("BAD_PATH", "Refusing path traversal");
    const u = new URL(`${this.base}/${p}`);
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null || v === "") continue;
      if (Array.isArray(v)) for (const x of v) u.searchParams.append(`${k}[]`, String(x));
      else u.searchParams.set(k, String(v));
    }
    return u;
  }
  /** Accept a links.next URL only when it points at our own base. */
  sameOrigin(next) {
    try { const n = new URL(next), b = new URL(this.base); return n.origin === b.origin && n.pathname.startsWith(b.pathname); } catch { return false; }
  }
  async request(method, path, { query, body, absolute } = {}) {
    if (!this.token) throw new KankaError("NO_TOKEN", "KANKA_TOKEN is not set");
    const u = absolute ? new URL(absolute) : this.url(path, query);
    if (absolute && !this.sameOrigin(absolute)) throw new KankaError("BAD_PATH", "Refusing to follow a link off the API host");
    const headers = { Accept: "application/json", Authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let attempt = 0;
    for (;;) {
      await this.limiter.take();
      this.calls++;
      let res;
      try {
        res = await this.fetch(u, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(30000) });
      } catch (e) {
        throw new KankaError("NETWORK", redact(`Network error: ${e?.cause?.code || e?.name || "fetch failed"}`, this.token));
      }
      const lim = res.headers.get("x-ratelimit-limit");
      if (lim && +lim > 0 && +lim !== this.limiter.limit && +lim < this.limiter.override) this.limiter.setLimit(+lim);
      const rem = res.headers.get("x-ratelimit-remaining");
      // Sync the bucket to the server's view (all of a user's tokens share one quota).
      if (rem !== null && rem !== "" && Number.isFinite(+rem)) this.limiter.syncRemaining(+rem);
      if (res.status === 429) {
        const ra = res.headers.get("retry-after");
        this.last429 = { retryAfter: ra, limit: lim, remaining: rem };
        if (attempt >= this.maxRetries) throw new KankaError("RATE_LIMITED", "Kanka rate limit: still 429 after retries", { status: 429 });
        if (ra && /^\d+$/.test(ra) && +ra > 120) throw new KankaError("RATE_LIMITED", `Kanka asked to wait ${ra}s (over the 120 s cap); try later`, { status: 429, retryAfter: +ra });
        const base = ra && /^\d+$/.test(ra) ? +ra * 1000 : Math.min(2000 * 2 ** attempt, 32000);
        const wait = base + Math.floor(Math.random() * 500);
        log(`429 from Kanka, waiting ${Math.round(wait / 1000)}s (attempt ${attempt + 1}/${this.maxRetries})`);
        await this.sleep(wait);
        attempt++;
        continue;
      }
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
      if (!res.ok) {
        const msg = json?.message || json?.error || `HTTP ${res.status}`;
        const errs = json?.errors ? ` ${JSON.stringify(json.errors).slice(0, 400)}` : "";
        const code = { 401: "UNAUTHENTICATED", 403: "FORBIDDEN", 404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED", 422: "VALIDATION" }[res.status] || "HTTP_ERROR";
        throw new KankaError(code, redact(`${msg}${errs}`.slice(0, 600), this.token), { status: res.status });
      }
      if (json === null && text && res.status !== 204) throw new KankaError("BAD_RESPONSE", "Kanka returned non-JSON (check base URL / Accept header)");
      return json ?? {};
    }
  }
  get(p, q) { return this.request("GET", p, { query: q }); }
  /** Follow links.next up to maxPages. Returns {data, sync, pages, meta}. */
  async list(path, query, { all = false, maxPages = 10 } = {}) {
    let r = await this.get(path, query);
    const data = [...(r.data || [])];
    let pages = 1; const sync = r.sync;
    while (all && r.links?.next && pages < maxPages) {
      r = await this.request("GET", null, { absolute: r.links.next });
      data.push(...(r.data || [])); pages++;
    }
    return { data, sync, pages, meta: r.meta ? { current_page: r.meta.current_page, last_page: r.meta.last_page, per_page: r.meta.per_page, total: r.meta.total } : undefined, next: r.links?.next ? true : false };
  }
}

/** Entity type code -> typed endpoint. Codes and ids from GET /entity-types (verified live 21 Oct 2026). */
export const TYPE_ENDPOINTS = {
  character: "characters", family: "families", location: "locations", organisation: "organisations",
  item: "items", note: "notes", event: "events", calendar: "calendars", race: "races", quest: "quests",
  journal: "journals", tag: "tags", creature: "creatures", timeline: "timelines", map: "maps", ability: "abilities",
};
export function endpointFor(type) {
  const s = String(type || "").toLowerCase();
  const code = TYPE_ENDPOINTS[s] ? s : Object.keys(TYPE_ENDPOINTS).find((k) => TYPE_ENDPOINTS[k] === s);
  if (!code) throw new KankaError("BAD_TYPE", `Unknown entity type: ${s.slice(0, 40)}. Use one of: ${Object.keys(TYPE_ENDPOINTS).join(", ")}`);
  return { code, path: TYPE_ENDPOINTS[code] };
}

export function allowlist() {
  return new Set(String(process.env.KANKA_CAMPAIGN_ALLOWLIST || "").split(/[\s,]+/).filter((x) => /^\d+$/.test(x)));
}
export function requireAllowed(campaignId) {
  const id = String(campaignId);
  if (!/^\d+$/.test(id)) throw new KankaError("BAD_ARGS", "campaign_id must be numeric");
  if (!allowlist().has(id)) throw new KankaError("CAMPAIGN_NOT_ALLOWLISTED", `Campaign ${id} is not in KANKA_CAMPAIGN_ALLOWLIST; writes are refused`);
  return id;
}
