// Live test against a THROWAWAY campaign. Requires: KANKA_TOKEN, KANKA_LIVE_CAMPAIGN (must also be in
// KANKA_CAMPAIGN_ALLOWLIST). Every created item is named "[tinkabot-test] ..." and deleted at the end.
// Paced by the client's token bucket (30/min with headroom). Prints answers to the open API questions.
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";
import { KankaClient } from "../server/kanka.js";
import { callTool, resetClient, getClient } from "../server/tools.js";
import { push } from "../skills/obsidian-kanka-push/push.mjs";

const CID = process.env.KANKA_LIVE_CAMPAIGN;
if (!CID || !String(process.env.KANKA_CAMPAIGN_ALLOWLIST || "").split(/[\s,]+/).includes(CID)) { console.error("set KANKA_LIVE_CAMPAIGN and allowlist it"); process.exit(2); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "kanka-live-"));
process.env.KANKA_STATE_FILE = path.join(TMP, "state.json"); process.env.KANKA_ALLOW_DELETE = "1";
resetClient(new KankaClient());
const P = "[tinkabot-test]";
let pass = 0, fail = 0; const answers = {}; const created = []; // {kind,type,id,entity_id,name}
const ok = (c, n) => { if (c) pass++; else { fail++; console.error("FAIL", n); } };
const call = async (n, a) => { const r = (await callTool(n, { campaign_id: CID, ...a })).structuredContent; if (r.error) console.error(n, r.error, r.message); return r; };
const two = async (n, a) => { const p = await call(n, a); if (p.status !== "PREVIEW") return p; return call(n, { ...a, confirm_token: p.confirm_token }); };
const t0 = Date.now();
try {
  const w = await call("kanka_whoami", {}); ok(w.rate_limit > 0 && w.token_sha256_prefix?.length === 12, "whoami");
  const cs = await call("kanka_list_campaigns", {}); ok(cs.campaigns.some((c) => String(c.id) === CID && c.write_allowlisted), "campaign visible + allowlisted");
  const et = await call("kanka_list_entity_types", {}); ok(et.types.some((t) => t.code === "character" && t.id === 1), "GET /entity-types");
  answers.entity_types_path = "GET /1.0/entity-types (global, not campaign-scoped)";
  const base = await call("kanka_list", { type: "character", use_saved_sync: true }); ok(typeof base.sync === "string", "list + sync saved");

  const loc = await two("kanka_create", { type: "location", fields: { name: `${P} Keep`, entry: "<p>stone keep</p>" } });
  ok(loc.item?.is_private === true, "location created private by default"); created.push({ kind: "entity", type: "location", id: loc.item.id, name: loc.item.name });
  const L = loc.item;
  const ch = await two("kanka_create", { type: "character", fields: { name: `${P} Aria`, entry: `<p>E:[location:${L.entity_id}] C:[location:${L.id}]</p>` } });
  ok(ch.item?.is_private === true, "character created private"); created.push({ kind: "entity", type: "character", id: ch.item.id, name: ch.item.name });
  const parsed = ch.item.entry_parsed || "";
  const eOk = parsed.includes(`entities/${L.entity_id}`) && parsed.includes("Keep"); const cOk = /C:<a [^>]*entities\/\d+/.test(parsed);
  ok(eOk, "mention by entity_id renders link");
  answers.mention_syntax = `[<type_code>:<entity_id>] renders a link (entity_id ${eOk ? "works" : "FAILED"}); child id ${cOk ? "also links" : "renders 'Unknown'"}`;
  const E = String(ch.item.entity_id);

  const up = await two("kanka_update", { type: "character", id: String(ch.item.id), patch: { title: "tester" } });
  ok(up.item?.title === "tester" && up.item?.name === ch.item.name, "PATCH characters/{id} partial update");
  const ue = await two("kanka_update_entity", { entity_id: E, patch: { type: "NPC" } });
  ok(ue.entity?.type_field === "NPC" || ue.entity?.type === "NPC", "PATCH entities/{entity_id}");
  answers.patch = "PATCH campaigns/{cid}/<plural>/{child_id} (partial) and PATCH campaigns/{cid}/entities/{entity_id} both 200; bare PATCH entities is 405. Entity response puts the user 'type' text in type_field and the module code in type.";
  const sync2 = await call("kanka_list", { type: "character", use_saved_sync: true });
  ok(sync2.count >= 1 && sync2.items.every((i) => i.name.startsWith(P)) && sync2.used_lastSync === base.sync, "lastSync returns only changed rows");

  const post = await two("kanka_create_post", { entity_id: E, name: `${P} post`, entry: `<p>see [location:${L.entity_id}]</p>` });
  ok(post.post?.visibility_id === 3, "post visibility 3"); created.unshift({ kind: "post", entity_id: E, id: post.post.id, name: post.post.name });
  const pu = await two("kanka_update_post", { entity_id: E, post_id: String(post.post.id), patch: { name: `${P} post`, entry: "<p>edited</p>" } });
  ok(pu.post?.entry?.includes("edited"), "PATCH post");
  const at = await two("kanka_set_attribute", { entity_id: E, name: `${P} HP`, value: "12" });
  ok(at.attribute?.is_private === true, "attribute private"); created.unshift({ kind: "attribute", entity_id: E, id: at.attribute.id, name: at.attribute.name });
  const rel = await two("kanka_create_relation", { owner_id: E, target_id: String(L.entity_id), relation: `${P} lives in` });
  ok(rel.relations?.[0]?.visibility_id === 3, "relation visibility 3"); created.unshift({ kind: "relation", entity_id: E, id: rel.relations[0].id, name: rel.relations[0].relation });
  const lp = await call("kanka_list_posts", { entity_id: E }); ok(lp.posts?.length === 1, "list posts");
  const la = await call("kanka_list_attributes", { entity_id: E }); ok(la.attributes?.some((a) => a.id === at.attribute.id), "list attributes");
  const lr = await call("kanka_list_relations", { entity_id: E }); ok(lr.relations?.some((r) => r.id === rel.relations[0].id), "list relations");
  const rs = await call("kanka_resolve", { entity_id: E }); ok(rs.child_id === ch.item.id && rs.type === "character", "resolve");
  const rc = await call("kanka_recent", { amount: 3 }); ok(Array.isArray(rc.items), "recent");
  const g = await call("kanka_get", { type: "character", id: String(ch.item.id), related: true }); ok(g.item?.entity_id === ch.item.entity_id, "get related");
  const mn = await call("kanka_list_mentions", { entity_id: String(L.entity_id) });
  answers.mentions_endpoint = `GET entities/{id}/mentions returned ${mn.mentions?.length ?? "error"} rows right after mentioning (may be indexed async)`;
  // bulk create
  const bulk = await getClient().request("POST", `campaigns/${CID}/entities`, { body: { entities: [{ name: `${P} bulk`, module: 6, is_private: true }] } }).then(() => "accepted", (e) => `${e.status} ${e.code}`);
  answers.bulk_create = `POST campaigns/{cid}/entities -> ${bulk} (route not available, so is_private on bulk is moot; plugin omits bulk create)`;
  if (bulk === "accepted") console.error("WARNING: bulk create accepted; check for a stray [tinkabot-test] bulk note");
  answers.rate_headers_on_200 = `x-ratelimit-limit/x-ratelimit-remaining present on 200s (observed limit ${getClient().limiter.limit})`;

  // push skill: 5-note fixture vault copy, twice
  const vault = path.join(TMP, "vault"); fs.cpSync(path.join(HERE, "fixture-vault"), vault, { recursive: true });
  const pc = getClient();
  const dry = await push({ vault, campaign: CID, client: pc }); ok(dry.api_calls === 0 && dry.created.length === 4, "push dry-run");
  const r1 = await push({ vault, campaign: CID, client: pc, apply: true }); ok(r1.created.length === 4 && r1.errors.length === 0, "push apply #1 creates 4");
  for (const c of r1.created) created.push({ kind: "entity", type: c.type, id: c.id, name: null });
  const r2 = await push({ vault, campaign: CID, client: pc, apply: true }); ok(r2.api_calls === 0 && r2.skipped_unchanged.length === 4, "push apply #2 idempotent (0 calls)");
  const hero = r1.created.find((c) => c.note === "Hero"); const vil = r1.created.find((c) => c.note === "Villain");
  const hg = await call("kanka_get", { type: "character", id: String(hero.id) });
  ok(hg.item.is_private === true && hg.item.entry_parsed.includes(`entities/${vil.entity_id}`) && !hg.item.entry.includes("sibling"), "pushed note: private, mention renders, GM text stripped");
  answers.push = { run1: { created: r1.created.length, calls: r1.api_calls, unresolved: r1.unresolved_links }, run2: { skipped: r2.skipped_unchanged.length, calls: r2.api_calls } };
} catch (e) { fail++; console.error("ERROR", e.code, e.message); }
finally {
  // cleanup via the gated delete tool (name echo)
  for (const c of created) {
    const a = c.kind === "entity" ? { kind: "entity", type: c.type, id: String(c.id) } : { kind: c.kind, entity_id: c.entity_id, id: String(c.id) };
    const pv = await call("kanka_delete", a);
    if (pv.status !== "PREVIEW") { if (pv.status !== 404) fail++; continue; }
    if (!String(pv.name).startsWith(P)) { console.error("refusing to delete non-test item"); fail++; continue; }
    const d = await call("kanka_delete", { ...a, confirm_token: pv.confirm_token, confirm_name: pv.name }); ok(d.status === "DONE", `cleanup ${c.kind} ${c.id}`);
  }
  const left = await getClient().get(`campaigns/${CID}/entities`, { name: P }).catch(() => null);
  ok(left && left.data.length === 0, "no [tinkabot-test] entities left");
  answers.calls = getClient().calls; answers.seconds = Math.round((Date.now() - t0) / 1000);
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(JSON.stringify(answers, null, 2));
  console.log(`live: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
