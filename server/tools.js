// Tool definitions and handlers for kanka-mcp.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KankaClient, KankaError, endpointFor, requireAllowed, allowlist, TYPE_ENDPOINTS, redact } from "./kanka.js";

let client = null;
export function getClient() { return (client ??= new KankaClient()); }
export function resetClient(c = null) { client = c; }

// --- confirm gate ------------------------------------------------------------
const GATE_SECRET = crypto.randomBytes(32);
const GATE_TTL_MS = 10 * 60 * 1000;
const issued = new Map(); // token -> {hash, exp}
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}
export function payloadHash(tool, payload) { return crypto.createHash("sha256").update(`${tool}\n${canon(payload)}`).digest("hex"); }
function issue(hash) {
  const tok = crypto.createHmac("sha256", GATE_SECRET).update(hash + crypto.randomBytes(8).toString("hex")).digest("hex").slice(0, 24);
  issued.set(tok, { hash, exp: Date.now() + GATE_TTL_MS });
  return tok;
}
function redeem(tok, hash) {
  const e = issued.get(String(tok || ""));
  if (!e) throw new KankaError("CONFIRM_INVALID", "confirm_token is unknown, used, or expired; call again without it to get a fresh preview");
  if (e.exp < Date.now()) { issued.delete(tok); throw new KankaError("CONFIRM_EXPIRED", "confirm_token expired"); }
  if (e.hash !== hash) throw new KankaError("CONFIRM_MISMATCH", "confirm_token does not match this payload; the arguments changed since the preview");
  issued.delete(tok);
}
/** Two-phase: without confirm_token returns a preview + token; with it, runs exec(). */
async function gated(tool, args, payload, previewFn, exec) {
  const hash = payloadHash(tool, payload);
  if (!args.confirm_token) {
    const preview = await previewFn();
    return { status: "PREVIEW", message: "Nothing was written. Re-call with the same arguments plus confirm_token to execute.", payload_sha256: hash.slice(0, 16), confirm_token: issue(hash), expires_in_s: GATE_TTL_MS / 1000, ...preview };
  }
  redeem(args.confirm_token, hash);
  return { status: "DONE", ...(await exec()) };
}

// --- helpers -----------------------------------------------------------------
const num = (v, name) => { if (!/^\d+$/.test(String(v ?? ""))) throw new KankaError("BAD_ARGS", `${name} must be a positive integer`); return String(v); };
const camp = (a) => num(a.campaign_id ?? process.env.KANKA_CAMPAIGN_ID, "campaign_id");
const C = (cid) => `campaigns/${cid}`;
const obj = (v, name) => { if (v === undefined) return {}; if (!v || typeof v !== "object" || Array.isArray(v)) throw new KankaError("BAD_ARGS", `${name} must be an object`); return v; };
const VIS = { 1: "all", 2: "self", 3: "admin", 4: "self-admin", 5: "members" };
const visibility = (v) => { const x = v === undefined ? 3 : +v; if (!VIS[x]) throw new KankaError("BAD_ARGS", "visibility_id must be 1..5"); return x; };
function diff(before, patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch)) if (canon(before?.[k]) !== canon(v)) out[k] = { from: before?.[k] ?? null, to: v };
  return out;
}
function slim(e) {
  if (!e || typeof e !== "object") return e;
  const keep = ["id", "entity_id", "child_id", "name", "type", "type_field", "type_id", "entity_type", "is_private", "is_template", "visibility_id", "entry", "entry_parsed", "value", "relation", "owner_id", "target_id", "attitude", "post_id", "campaign_id", "tags", "parent_id", "updated_at", "created_at", "urls", "title", "locale", "rate_limit", "default_pagination"];
  const o = {}; for (const k of keep) if (k in e) o[k] = e[k];
  for (const k of ["attributes", "posts", "relations"]) if (Array.isArray(e[k])) o[k] = e[k].map(slim);
  return o;
}

// --- lastSync state -----------------------------------------------------------
function stateFile() { return process.env.KANKA_STATE_FILE || path.join(os.homedir(), ".kanka-mcp", "last-sync.json"); }
function readState() { try { return JSON.parse(fs.readFileSync(stateFile(), "utf8")); } catch { return {}; } }
function writeState(s) { const f = stateFile(); fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); fs.writeFileSync(f, JSON.stringify(s, null, 2), { mode: 0o600 }); }

// --- schemas -----------------------------------------------------------------
const S = {
  cid: { type: "string", description: "Kanka campaign id (numeric). Defaults to env KANKA_CAMPAIGN_ID." },
  type: { type: "string", description: `Entity type code or plural: ${Object.keys(TYPE_ENDPOINTS).join(", ")}` },
  id: { type: "string", description: "Typed (child) id, e.g. the character id" },
  eid: { type: "string", description: "Entity id (shared id used for posts/attributes/relations/mentions and in [type:entity_id] mentions)" },
  confirm: { type: "string", description: "Second phase only: token from the preview" },
  page: { type: "integer", minimum: 1 },
};
const props = (o, req = []) => ({ type: "object", properties: o, required: req, additionalProperties: false });

export const TOOLS = [
  { name: "kanka_whoami", description: "Profile of the token owner, the per-minute rate limit, pagination, and the token sha prefix (never the token).", inputSchema: props({}) },
  { name: "kanka_list_campaigns", description: "Campaigns the token can see, with the write allowlist status of each.", inputSchema: props({}) },
  { name: "kanka_list_entity_types", description: "Entity types/modules with ids and codes (GET /entity-types).", inputSchema: props({}) },
  { name: "kanka_list", description: "List entities of one type. Supports filters, page, all (follow links.next), and lastSync (explicit or the saved value per campaign+type).", inputSchema: props({ campaign_id: S.cid, type: S.type, page: S.page, all: { type: "boolean" }, max_pages: { type: "integer", minimum: 1, maximum: 50 }, name: { type: "string" }, is_private: { type: "boolean" }, tags: { type: "array", items: { type: "integer" } }, lastSync: { type: "string", description: "ISO time from a previous response's sync" }, use_saved_sync: { type: "boolean", description: "Use and then update the stored sync value" }, related: { type: "boolean" } }, ["type"]) },
  { name: "kanka_get", description: "One entity by type + child id; related=true adds attributes, posts, relations.", inputSchema: props({ campaign_id: S.cid, type: S.type, id: S.id, related: { type: "boolean" } }, ["type", "id"]) },
  { name: "kanka_get_entity", description: "Generic entity by entity id (returns child_id and type).", inputSchema: props({ campaign_id: S.cid, entity_id: S.eid, related: { type: "boolean" } }, ["entity_id"]) },
  { name: "kanka_resolve", description: "Map an entity id to its type, child id, and mention string.", inputSchema: props({ campaign_id: S.cid, entity_id: S.eid }, ["entity_id"]) },
  { name: "kanka_recent", description: "Most recently edited entities (1..10).", inputSchema: props({ campaign_id: S.cid, amount: { type: "integer", minimum: 1, maximum: 10 } }) },
  { name: "kanka_list_posts", description: "Posts on an entity.", inputSchema: props({ campaign_id: S.cid, entity_id: S.eid, page: S.page }, ["entity_id"]) },
  { name: "kanka_get_post", description: "One post.", inputSchema: props({ campaign_id: S.cid, entity_id: S.eid, post_id: { type: "string" } }, ["entity_id", "post_id"]) },
  { name: "kanka_list_attributes", description: "Attributes (properties) on an entity.", inputSchema: props({ campaign_id: S.cid, entity_id: S.eid, page: S.page }, ["entity_id"]) },
  { name: "kanka_list_relations", description: "Relations (connections) of an entity.", inputSchema: props({ campaign_id: S.cid, entity_id: S.eid, page: S.page }, ["entity_id"]) },
  { name: "kanka_list_mentions", description: "Mentions of an entity (read-only; may lag behind edits).", inputSchema: props({ campaign_id: S.cid, entity_id: S.eid, page: S.page }, ["entity_id"]) },
  { name: "kanka_create", description: "WRITE (two-phase). Create an entity of a type. is_private defaults to true. Campaign must be allowlisted.", inputSchema: props({ campaign_id: S.cid, type: S.type, fields: { type: "object", description: "Typed create fields; name required. entry is HTML." }, confirm_token: S.confirm }, ["type", "fields"]) },
  { name: "kanka_update", description: "WRITE (two-phase). PATCH a typed entity (type + child id). Preview diffs against the current record.", inputSchema: props({ campaign_id: S.cid, type: S.type, id: S.id, patch: { type: "object" }, confirm_token: S.confirm }, ["type", "id", "patch"]) },
  { name: "kanka_update_entity", description: "WRITE (two-phase). PATCH entities/{entity_id}: name, type, is_private, is_template, entry, image_uuid, header_uuid, parent_id.", inputSchema: props({ campaign_id: S.cid, entity_id: S.eid, patch: { type: "object" }, confirm_token: S.confirm }, ["entity_id", "patch"]) },
  { name: "kanka_create_post", description: "WRITE (two-phase). Add a post to an entity. visibility_id defaults to 3 (admin).", inputSchema: props({ campaign_id: S.cid, entity_id: S.eid, name: { type: "string" }, entry: { type: "string" }, visibility_id: { type: "integer" }, position: { type: "integer" }, confirm_token: S.confirm }, ["entity_id", "name"]) },
  { name: "kanka_update_post", description: "WRITE (two-phase). PATCH a post.", inputSchema: props({ campaign_id: S.cid, entity_id: S.eid, post_id: { type: "string" }, patch: { type: "object" }, confirm_token: S.confirm }, ["entity_id", "post_id", "patch"]) },
  { name: "kanka_set_attribute", description: "WRITE (two-phase). Create an attribute (is_private defaults to true) or, with attribute_id, PATCH it.", inputSchema: props({ campaign_id: S.cid, entity_id: S.eid, attribute_id: { type: "string" }, name: { type: "string" }, value: { type: "string" }, type_id: { type: "integer" }, is_private: { type: "boolean" }, is_pinned: { type: "boolean" }, confirm_token: S.confirm }, ["entity_id", "name"]) },
  { name: "kanka_create_relation", description: "WRITE (two-phase). Relation from one entity to another. visibility_id defaults to 3 (admin).", inputSchema: props({ campaign_id: S.cid, owner_id: S.eid, target_id: S.eid, relation: { type: "string" }, attitude: { type: "integer", minimum: -100, maximum: 100 }, two_way: { type: "boolean" }, visibility_id: { type: "integer" }, confirm_token: S.confirm }, ["owner_id", "target_id", "relation"]) },
  { name: "kanka_delete", description: "DELETE (off unless KANKA_ALLOW_DELETE=1; two-phase; one item; confirm_name must echo the item's exact name). kind: entity (type+id), post, attribute, relation.", inputSchema: props({ campaign_id: S.cid, kind: { type: "string", enum: ["entity", "post", "attribute", "relation"] }, type: S.type, id: { type: "string", description: "child id (entity) or post/attribute/relation id" }, entity_id: S.eid, confirm_name: { type: "string" }, confirm_token: S.confirm }, ["kind", "id"]) },
];

// Typed update fields (from the documented create bodies; transfer/permission-style fields are excluded).
const UPDATE_FIELDS = new Set(["name", "entry", "type", "title", "age", "sex", "pronouns", "families", "locations", "races", "tags", "status_id", "is_private", "is_template", "entity_image_uuid", "entity_header_uuid", "tooltip", "location_id", "parent_id", "is_dead", "personality_name", "personality_entry", "appearance_name", "appearance_entry", "is_personality_visible", "is_personality_pinned", "is_appearance_pinned", "date", "character_id", "is_completed"]);
function writeWarnings(patch) {
  const w = [];
  if (patch.entry === "") w.push('entry:"" erases the whole description');
  if (patch.is_private === false || patch.is_private === 0) w.push("is_private:false makes this visible to players");
  return w.length ? w : undefined;
}
const WRITE_KEYS_ENTITY = new Set(["name", "type", "is_private", "is_template", "tooltip", "entry", "image_uuid", "header_uuid", "parent_id"]);

const handlers = {
  async kanka_whoami() {
    const k = getClient(); const r = await k.get("profile"); const d = r.data || {};
    if (d.rate_limit) k.limiter.setLimit(d.rate_limit);
    return { id: d.id, name: d.name, rate_limit: d.rate_limit, effective_limit_per_min: k.limiter.limit, bucket_capacity: k.limiter.capacity, default_pagination: d.default_pagination, is_patreon: d.is_patreon, token_sha256_prefix: k.tokenSha, note: "Personal tokens expire 365 days after creation; the expiry is not exposed by the API." };
  },
  async kanka_list_campaigns() {
    const r = await getClient().list("campaigns", {}, { all: true }); const allow = allowlist();
    return { campaigns: r.data.map((c) => ({ id: c.id, name: c.name, locale: c.locale, write_allowlisted: allow.has(String(c.id)) })) };
  },
  async kanka_list_entity_types() { const r = await getClient().list("entity-types", {}, { all: true }); return { types: r.data.map((t) => ({ id: t.id, code: t.code, plural: t.plural, is_enabled: t.is_enabled, supported_by_plugin: !!TYPE_ENDPOINTS[t.code] })) }; },
  async kanka_list(a) {
    const cid = camp(a); const { code, path: p } = endpointFor(a.type);
    const key = `${cid}:${code}`; const st = a.use_saved_sync ? readState() : null;
    const lastSync = a.lastSync || (st ? st[key] : undefined);
    const q = { page: a.page, name: a.name, is_private: a.is_private === undefined ? undefined : a.is_private ? 1 : 0, tags: a.tags, lastSync, related: a.related ? 1 : undefined };
    const r = await getClient().list(`${C(cid)}/${p}`, q, { all: !!a.all, maxPages: Math.min(50, Math.max(1, Math.floor(+a.max_pages) || 10)) });
    if (a.use_saved_sync && r.sync) { const s = readState(); s[key] = r.sync; writeState(s); }
    return { type: code, count: r.data.length, items: r.data.map(slim), sync: r.sync, used_lastSync: lastSync || null, pages: r.pages, has_more: r.next, meta: r.meta, note: lastSync ? "lastSync results never include deletions; run a full list to detect removed entities." : undefined };
  },
  async kanka_get(a) { const cid = camp(a); const { path: p } = endpointFor(a.type); const r = await getClient().get(`${C(cid)}/${p}/${num(a.id, "id")}`, { related: a.related ? 1 : undefined }); return { item: slim(r.data) }; },
  async kanka_get_entity(a) { const cid = camp(a); const r = await getClient().get(`${C(cid)}/entities/${num(a.entity_id, "entity_id")}`, { related: a.related ? 1 : undefined }); return { entity: slim(r.data) }; },
  async kanka_resolve(a) {
    const cid = camp(a); const eid = num(a.entity_id, "entity_id"); const d = (await getClient().get(`${C(cid)}/entities/${eid}`)).data || {};
    const code = d.type || d.entity_type || d.module?.code;
    return { entity_id: d.id, name: d.name, type: code, child_id: d.child_id, endpoint: TYPE_ENDPOINTS[code] ? `${TYPE_ENDPOINTS[code]}/${d.child_id}` : null, mention: `[${code}:${d.id}]` };
  },
  async kanka_recent(a) { const cid = camp(a); const r = await getClient().get(`${C(cid)}/entities/recent`, { amount: a.amount || 5 }); return { items: (r.data || []).map(slim) }; },
  async kanka_list_posts(a) { const cid = camp(a); const r = await getClient().list(`${C(cid)}/entities/${num(a.entity_id, "entity_id")}/posts`, { page: a.page }); return { posts: r.data.map(slim), has_more: r.next }; },
  async kanka_get_post(a) { const cid = camp(a); const r = await getClient().get(`${C(cid)}/entities/${num(a.entity_id, "entity_id")}/posts/${num(a.post_id, "post_id")}`); return { post: slim(r.data) }; },
  async kanka_list_attributes(a) { const cid = camp(a); const r = await getClient().list(`${C(cid)}/entities/${num(a.entity_id, "entity_id")}/attributes`, { page: a.page }); return { attributes: r.data.map(slim), has_more: r.next }; },
  async kanka_list_relations(a) { const cid = camp(a); const r = await getClient().list(`${C(cid)}/entities/${num(a.entity_id, "entity_id")}/relations`, { page: a.page }); return { relations: r.data.map(slim), has_more: r.next }; },
  async kanka_list_mentions(a) { const cid = camp(a); const r = await getClient().list(`${C(cid)}/entities/${num(a.entity_id, "entity_id")}/mentions`, { page: a.page }); return { mentions: r.data, has_more: r.next }; },

  async kanka_create(a) {
    const cid = requireAllowed(camp(a)); const { code, path: p } = endpointFor(a.type); const f = { ...obj(a.fields, "fields") };
    if (typeof f.name !== "string" || !f.name.trim()) throw new KankaError("BAD_ARGS", "fields.name is required");
    if (f.is_private === undefined) f.is_private = true;
    return gated("kanka_create", a, { cid, code, f }, async () => ({ action: `POST ${C(cid)}/${p}`, fields: f, warning: f.is_private ? undefined : "is_private=false: players will see this" }),
      async () => ({ item: slim((await getClient().request("POST", `${C(cid)}/${p}`, { body: f })).data) }));
  },
  async kanka_update(a) {
    const cid = requireAllowed(camp(a)); const { code, path: p } = endpointFor(a.type); const id = num(a.id, "id"); const patch = obj(a.patch, "patch");
    if (!Object.keys(patch).length) throw new KankaError("BAD_ARGS", "patch is empty");
    const bad = Object.keys(patch).filter((k) => !UPDATE_FIELDS.has(k)); if (bad.length) throw new KankaError("BAD_ARGS", `Unsupported update fields: ${bad.join(", ")}`);
    const warnings = writeWarnings(patch);
    return gated("kanka_update", a, { cid, code, id, patch }, async () => { const cur = (await getClient().get(`${C(cid)}/${p}/${id}`)).data; return { action: `PATCH ${C(cid)}/${p}/${id}`, name: cur?.name, diff: diff(cur, patch), warnings }; },
      async () => ({ item: slim((await getClient().request("PATCH", `${C(cid)}/${p}/${id}`, { body: patch })).data) }));
  },
  async kanka_update_entity(a) {
    const cid = requireAllowed(camp(a)); const eid = num(a.entity_id, "entity_id"); const patch = obj(a.patch, "patch");
    const bad = Object.keys(patch).filter((k) => !WRITE_KEYS_ENTITY.has(k)); if (bad.length) throw new KankaError("BAD_ARGS", `Unsupported entity fields: ${bad.join(", ")}`);
    if (!Object.keys(patch).length) throw new KankaError("BAD_ARGS", "patch is empty");
    return gated("kanka_update_entity", a, { cid, eid, patch }, async () => { const cur = (await getClient().get(`${C(cid)}/entities/${eid}`)).data; return { action: `PATCH ${C(cid)}/entities/${eid}`, name: cur?.name, diff: diff({ ...cur, type: cur?.type_field ?? cur?.type }, patch) }; },
      async () => ({ entity: slim((await getClient().request("PATCH", `${C(cid)}/entities/${eid}`, { body: patch })).data) }));
  },
  async kanka_create_post(a) {
    const cid = requireAllowed(camp(a)); const eid = num(a.entity_id, "entity_id");
    const body = { name: a.name, entry: a.entry ?? "", entity_id: +eid, visibility_id: visibility(a.visibility_id) }; if (a.position !== undefined) body.position = a.position;
    return gated("kanka_create_post", a, { cid, body }, async () => ({ action: `POST ${C(cid)}/entities/${eid}/posts`, body, visibility: VIS[body.visibility_id] }),
      async () => ({ post: slim((await getClient().request("POST", `${C(cid)}/entities/${eid}/posts`, { body })).data) }));
  },
  async kanka_update_post(a) {
    const cid = requireAllowed(camp(a)); const eid = num(a.entity_id, "entity_id"); const pid = num(a.post_id, "post_id"); const patch = obj(a.patch, "patch");
    if (patch.visibility_id !== undefined) visibility(patch.visibility_id);
    const u = `${C(cid)}/entities/${eid}/posts/${pid}`;
    return gated("kanka_update_post", a, { cid, eid, pid, patch }, async () => { const cur = (await getClient().get(u)).data; return { action: `PATCH ${u}`, diff: diff(cur, patch) }; },
      async () => ({ post: slim((await getClient().request("PATCH", u, { body: { name: patch.name, ...patch } })).data) }));
  },
  async kanka_set_attribute(a) {
    const cid = requireAllowed(camp(a)); const eid = num(a.entity_id, "entity_id");
    const body = { name: a.name }; for (const k of ["value", "type_id", "is_pinned", "is_private"]) if (a[k] !== undefined) body[k] = a[k];
    if (!a.attribute_id && body.is_private === undefined) body.is_private = true;
    const u = a.attribute_id ? `${C(cid)}/entities/${eid}/attributes/${num(a.attribute_id, "attribute_id")}` : `${C(cid)}/entities/${eid}/attributes`;
    const method = a.attribute_id ? "PATCH" : "POST";
    return gated("kanka_set_attribute", a, { cid, u, body }, async () => ({ action: `${method} ${u}`, body }),
      async () => ({ attribute: slim((await getClient().request(method, u, { body })).data) }));
  },
  async kanka_create_relation(a) {
    const cid = requireAllowed(camp(a)); const owner = num(a.owner_id, "owner_id"); const target = num(a.target_id, "target_id");
    if (typeof a.relation !== "string" || !a.relation || a.relation.length > 255) throw new KankaError("BAD_ARGS", "relation is required, max 255 chars");
    const body = { relation: a.relation, owner_id: +owner, target_id: +target, visibility_id: visibility(a.visibility_id) };
    if (a.attitude !== undefined) body.attitude = a.attitude; if (a.two_way !== undefined) body.two_way = !!a.two_way;
    const u = `${C(cid)}/entities/${owner}/relations`;
    return gated("kanka_create_relation", a, { cid, body }, async () => ({ action: `POST ${u}`, body, visibility: VIS[body.visibility_id] }),
      async () => { const d = (await getClient().request("POST", u, { body })).data; return { relations: (Array.isArray(d) ? d : [d]).map(slim) }; });
  },
  async kanka_delete(a) {
    if (process.env.KANKA_ALLOW_DELETE !== "1") throw new KankaError("DELETE_DISABLED", "Deletes are off. Set KANKA_ALLOW_DELETE=1 to enable single-item deletes.");
    const cid = requireAllowed(camp(a)); const id = num(a.id, "id");
    let u, nameOf;
    if (a.kind === "entity") { const { path: p } = endpointFor(a.type); u = `${C(cid)}/${p}/${id}`; nameOf = (d) => d?.name; }
    else if (["post", "attribute", "relation"].includes(a.kind)) { const eid = num(a.entity_id, "entity_id"); u = `${C(cid)}/entities/${eid}/${a.kind}s/${id}`; nameOf = (d) => (a.kind === "relation" ? d?.relation : d?.name); }
    else throw new KankaError("BAD_ARGS", "kind must be entity, post, attribute or relation");
    if (Array.isArray(a.id)) throw new KankaError("BAD_ARGS", "one item only");
    const payload = { cid, u };
    const cur = (await getClient().get(u)).data; const name = nameOf(cur);
    if (!a.confirm_token) return gated("kanka_delete", a, payload, async () => ({ action: `DELETE ${u}`, name, required: "re-call with confirm_token and confirm_name equal to the exact name above" }));
    if (typeof a.confirm_name !== "string" || typeof name !== "string" || a.confirm_name !== name) throw new KankaError("CONFIRM_NAME_MISMATCH", "confirm_name does not match the item's current name; nothing deleted");
    return gated("kanka_delete", a, payload, null, async () => { await getClient().request("DELETE", u); return { deleted: u, name }; });
  },
};

export async function callTool(name, args) {
  const h = handlers[name]; if (!h) return { unknown: true };
  let before = 0;
  try {
    before = getClient().calls;
    const out = await h(args && typeof args === "object" ? args : {});
    out.api_calls = getClient().calls - before;
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out };
  } catch (e) {
    const err = { error: e instanceof KankaError ? e.code : "INTERNAL", message: redact(e?.message || String(e), process.env.KANKA_TOKEN).slice(0, 600), status: e?.status, api_calls: client ? client.calls - before : 0 };
    return { isError: true, content: [{ type: "text", text: JSON.stringify(err) }], structuredContent: err };
  }
}
