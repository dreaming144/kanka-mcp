// Offline selftest: framing, gates, private defaults, redaction, 429, pagination, lastSync, rate limiter, push skill.
import { spawn } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMock } from "./mock-kanka.js";
import { KankaClient, RateLimiter, resolveBase, tokenSha } from "../server/kanka.js";
import { createFrameParser } from "../server/index.js";
import { callTool, resetClient, TOOLS } from "../server/tools.js";
import { push, mdToHtml, stripPrivate, patchKankaKeys } from "../skills/obsidian-kanka-push/push.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (c, name) => { if (c) pass++; else { fail++; console.error("FAIL", name); } };
const mock = await startMock();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "kanka-selftest-"));
Object.assign(process.env, { KANKA_TOKEN: mock.token, KANKA_API_BASE: mock.base, KANKA_CAMPAIGN_ALLOWLIST: "1", KANKA_STATE_FILE: path.join(TMP, "state.json") });
delete process.env.KANKA_ALLOW_DELETE; delete process.env.KANKA_RATE_LIMIT; delete process.env.KANKA_MIN_INTERVAL_MS;
const waits = [];
const mk = () => new KankaClient({ sleep: async (ms) => { waits.push(ms); } });
resetClient(mk());
const call = async (n, a) => (await callTool(n, a)).structuredContent;

// 1. framing via a real child process
{
  const child = spawn(process.execPath, [path.join(HERE, "../server/index.js")], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  let out = "", err = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (err += d));
  const body = (id) => JSON.stringify({ jsonrpc: "2.0", id, method: "ping" });
  const cl = (id, t) => `Content-Length: ${Buffer.byteLength(body(id))}${t}${t}${body(id)}`;
  child.stdin.write(body(1) + "\n" + cl(2, "\n") + cl(3, "\r\n"));
  const s4 = cl(4, "\r\n"); child.stdin.write(s4.slice(0, 9)); await new Promise((r) => setTimeout(r, 50)); child.stdin.write(s4.slice(9) + body(5) + "\r\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "kanka_whoami", arguments: {} } }) + "\n");
  child.stdin.write("{bad json\n");
  child.stdin.end();
  await new Promise((r) => child.on("exit", r));
  ok(/(^|\n)\{"jsonrpc":"2.0","id":1,"result":\{\}\}\n/.test(out), "ndjson reply");
  ok(out.includes(`Content-Length: ${Buffer.byteLength('{"jsonrpc":"2.0","id":2,"result":{}}')}\n\n{"jsonrpc":"2.0","id":2`), "CL LF reply");
  ok(out.includes('\r\n\r\n{"jsonrpc":"2.0","id":3'), "CL CRLF reply");
  ok(out.includes('\r\n\r\n{"jsonrpc":"2.0","id":4'), "CL CRLF split across chunks");
  ok(out.includes('{"jsonrpc":"2.0","id":5,"result":{}}'), "ndjson CRLF line");
  ok(out.includes('"id":6') && out.includes("rate_limit"), "tools/call over stdio");
  ok(out.includes('"code":-32700'), "parse error reported");
  const msgs = []; let perr = 0; const pr = createFrameParser((o) => msgs.push(o), () => perr++); pr.push(Buffer.from(out)); pr.end();
  ok(perr === 0 && msgs.length === 7 && msgs.every((m) => m.jsonrpc === "2.0"), "stdout is JSON-RPC only");
  ok(err.includes("ready") && !err.includes(mock.token) && !out.includes(mock.token), "logs on stderr, no token anywhere");
}
ok(TOOLS.length === 21 && !TOOLS.some((t) => /transfer|transform|permission|recover/.test(t.name)), "tool list excludes transfer/transform/permissions/recover");

// 2. whoami + redaction + headers
{
  const w = await call("kanka_whoami", {});
  ok(w.token_sha256_prefix === tokenSha(mock.token) && !JSON.stringify(w).includes(mock.token), "whoami sha prefix only");
  ok(w.rate_limit === 600 && w.bucket_capacity === 540, "bucket sized from profile.rate_limit with 10% headroom");
  const last = mock.st.log.at(-1);
  ok(last.auth === `Bearer ${mock.token}` && last.accept === "application/json", "auth + accept headers");
  ok(mock.st.log.every((l) => !l.url.includes(mock.token)), "token never in URL");
  let msg = ""; try { await mk().get("echo-token"); } catch (e) { msg = e.message; }
  ok(msg && !msg.includes(mock.token) && msg.includes("[redacted]"), "error bodies are redacted");
  ok((() => { try { resolveBase("https://evil.example/1.0"); return false; } catch { return true; } })(), "non-Kanka base refused");
  ok((() => { try { mk().url("campaigns/1/%2e%2e/x"); return false; } catch { return true; } })(), "encoded traversal refused");
}

// 3. gates + defaults
{
  const denied = await call("kanka_create", { campaign_id: "2", type: "character", fields: { name: "X" } });
  ok(denied.error === "CAMPAIGN_NOT_ALLOWLISTED", "writes need allowlist");
  const n0 = mock.st.log.length;
  const pv = await call("kanka_create", { campaign_id: "1", type: "character", fields: { name: "Aria" } });
  ok(pv.status === "PREVIEW" && pv.confirm_token && pv.fields.is_private === true, "create preview, private default");
  ok(mock.st.log.length === n0, "preview makes no API write");
  const mis = await call("kanka_create", { campaign_id: "1", type: "character", fields: { name: "Aria2" }, confirm_token: pv.confirm_token });
  ok(mis.error === "CONFIRM_MISMATCH", "token bound to payload hash");
  const done = await call("kanka_create", { campaign_id: "1", type: "character", fields: { name: "Aria" }, confirm_token: pv.confirm_token });
  ok(done.status === "DONE" && done.item.is_private === true, "create executes, stored private");
  const again = await call("kanka_create", { campaign_id: "1", type: "character", fields: { name: "Aria" }, confirm_token: pv.confirm_token });
  ok(again.error === "CONFIRM_INVALID", "confirm token is single-use");
  const eid = String(done.item.entity_id), cid = String(done.item.id);
  const up = await call("kanka_update", { campaign_id: "1", type: "characters", id: cid, patch: { title: "Bard" } });
  ok(up.status === "PREVIEW" && up.diff.title?.to === "Bard", "update preview diff");
  const upd = await call("kanka_update", { campaign_id: "1", type: "characters", id: cid, patch: { title: "Bard" }, confirm_token: up.confirm_token });
  ok(upd.status === "DONE" && mock.st.log.at(-1).method === "PATCH" && mock.st.log.at(-1).url.endsWith(`/characters/${cid}`), "update uses PATCH typed path");
  const ue = await call("kanka_update_entity", { campaign_id: "1", entity_id: eid, patch: { bogus: 1 } });
  ok(ue.error === "BAD_ARGS", "entity patch field allow-list");
  const two = async (n, a) => { const p = await call(n, a); return call(n, { ...a, confirm_token: p.confirm_token }); };
  const post = await two("kanka_create_post", { campaign_id: "1", entity_id: eid, name: "Notes" });
  ok(post.post.visibility_id === 3, "post visibility defaults to 3");
  const attr = await two("kanka_set_attribute", { campaign_id: "1", entity_id: eid, name: "HP", value: "12" });
  ok(attr.attribute.is_private === true, "attribute private default");
  const loc = await two("kanka_create", { campaign_id: "1", type: "location", fields: { name: "Keep" } });
  const rel = await two("kanka_create_relation", { campaign_id: "1", owner_id: eid, target_id: String(loc.item.entity_id), relation: "lives in" });
  ok(rel.relations[0].visibility_id === 3, "relation visibility defaults to 3");
  const pubv = await call("kanka_create_post", { campaign_id: "1", entity_id: eid, name: "Open", visibility_id: 1 });
  ok(pubv.status === "PREVIEW" && pubv.visibility === "all", "explicit visibility honoured (preview shows it)");
  const r = await call("kanka_resolve", { campaign_id: "1", entity_id: eid });
  ok(r.child_id === done.item.id && r.mention === `[character:${eid}]`, "resolve -> child id + mention by entity_id");
  // deletes
  const d0 = await call("kanka_delete", { campaign_id: "1", kind: "entity", type: "character", id: cid });
  ok(d0.error === "DELETE_DISABLED", "deletes off by default");
  process.env.KANKA_ALLOW_DELETE = "1";
  const dn = await call("kanka_delete", { campaign_id: "2", kind: "entity", type: "character", id: cid });
  ok(dn.error === "CAMPAIGN_NOT_ALLOWLISTED", "delete needs allowlist");
  const dp = await call("kanka_delete", { campaign_id: "1", kind: "entity", type: "character", id: cid });
  ok(dp.status === "PREVIEW" && dp.name === "Aria", "delete preview echoes name");
  const dw = await call("kanka_delete", { campaign_id: "1", kind: "entity", type: "character", id: cid, confirm_token: dp.confirm_token, confirm_name: "aria" });
  ok(dw.error === "CONFIRM_NAME_MISMATCH" && mock.st.ents.has(+eid), "wrong name echo refuses");
  const dk = await call("kanka_delete", { campaign_id: "1", kind: "entity", type: "character", id: cid, confirm_token: dp.confirm_token, confirm_name: "Aria" });
  ok(dk.status === "DONE" && !mock.st.ents.has(+eid), "delete with name echo");
  delete process.env.KANKA_ALLOW_DELETE;
}

// 4. 429 handling
{
  waits.length = 0;
  mock.st.inject.push({ status: 429, headers: { "retry-after": "3" } });
  const a = await call("kanka_list_campaigns", {});
  ok(a.campaigns?.length === 3 && waits.some((w) => w >= 3000 && w < 3600), "429 honours Retry-After");
  waits.length = 0;
  mock.st.inject.push({ status: 429 }, { status: 429 });
  const b = await call("kanka_list_entity_types", {});
  ok(b.types?.length === 2 && waits.filter((w) => w >= 2000).length >= 2 && waits.some((w) => w >= 4000), "429 exponential backoff without headers");
  const c = new KankaClient({ sleep: async () => {}, maxRetries: 2 });
  for (let i = 0; i < 3; i++) mock.st.inject.push({ status: 429 });
  let code = ""; try { await c.get("profile"); } catch (e) { code = e.code; }
  ok(code === "RATE_LIMITED", "gives up with RATE_LIMITED");
}

// 5. pagination + lastSync
{
  for (const n of ["P1", "P2", "P3", "P4", "P5"]) { const p = await call("kanka_create", { campaign_id: "1", type: "note", fields: { name: n } }); await call("kanka_create", { campaign_id: "1", type: "note", fields: { name: n }, confirm_token: p.confirm_token }); }
  const one = await call("kanka_list", { campaign_id: "1", type: "note" });
  ok(one.count === 2 && one.has_more === true, "single page + has_more");
  const all = await call("kanka_list", { campaign_id: "1", type: "note", all: true });
  ok(all.count === 5 && all.pages === 3, "all=true follows links.next");
  mock.st.badNext = true; const bad = await call("kanka_list", { campaign_id: "1", type: "note", all: true }); mock.st.badNext = false;
  ok(bad.error === "BAD_PATH", "off-host links.next refused");
  const s1 = await call("kanka_list", { campaign_id: "1", type: "note", all: true, use_saved_sync: true });
  ok(s1.count === 5 && JSON.parse(fs.readFileSync(process.env.KANKA_STATE_FILE)).hasOwnProperty("1:note"), "sync saved to state file");
  const target = [...mock.st.ents.values()].find((e) => e.name === "P3");
  const p = await call("kanka_update", { campaign_id: "1", type: "note", id: String(target.id), patch: { entry: "<p>x</p>" } });
  await call("kanka_update", { campaign_id: "1", type: "note", id: String(target.id), patch: { entry: "<p>x</p>" }, confirm_token: p.confirm_token });
  const s2 = await call("kanka_list", { campaign_id: "1", type: "note", all: true, use_saved_sync: true });
  ok(s2.count === 1 && s2.items[0].name === "P3" && s2.used_lastSync === s1.sync, "lastSync returns only changed rows");
  ok(mock.st.log.some((l) => l.url.includes("lastSync=")), "lastSync passed as query");
}

// 6. rate limiter (fake clock)
{
  let t = 0; const sl = async (ms) => { t += ms; };
  const rl = new RateLimiter({ limit: 30, now: () => t, sleep: sl });
  for (let i = 0; i < 27; i++) await rl.take();
  ok(t === 0, "27 immediate calls (30 with headroom)");
  await rl.take(); ok(t === 60000, "28th call waits for the window to roll");
  t = 0; const rs = new RateLimiter({ limit: 30, now: () => t, sleep: sl }); rs.syncRemaining(5); ok(rs.available === 3, "bucket syncs to x-ratelimit-remaining");
  ok(new RateLimiter({ limit: 30, override: 90 }).limit === 30, "override cannot speed up");
  ok(new RateLimiter({ limit: 30, override: 10 }).limit === 10, "override can slow down");
  const r2 = new RateLimiter({ limit: 30, override: 90 }); r2.setLimit(90); ok(r2.limit === 30 || r2.override === 90 && r2.limit === 90, "setLimit respects override");
  t = 0; const r3 = new RateLimiter({ limit: 30, minIntervalMs: 500, now: () => t, sleep: sl }); await r3.take(); await r3.take(); ok(t >= 500, "min interval slows");
}

// 7. push skill
{
  ok(!stripPrivate("a\n> [!secret] x\n> hidden\nb %%gm%% c").includes("hidden") && !stripPrivate("x %%gm%%").includes("gm"), "secret callouts + comments stripped");
  const h = mdToHtml("# T\n\n**b** and *i* [[X|y]]\n\n- a\n- b\n\n| a | b |\n|---|---|\n| 1 | 2 |", (t, a) => `[character:9]`).html;
  ok(h.includes("<h1>T</h1>") && h.includes("<strong>b</strong>") && h.includes("<em>i</em>") && h.includes("[character:9]") && h.includes("<ul><li>a</li>") === false && h.includes("<li>a</li>") && h.includes("<table>"), "markdown -> html");
  const vault = path.join(TMP, "vault"); fs.cpSync(path.join(HERE, "fixture-vault"), vault, { recursive: true });
  const c = mk();
  const dry = await push({ vault, campaign: "1", client: c });
  ok(dry.mode === "dry-run" && dry.publish === 4 && dry.created.length === 4 && dry.api_calls === 0, "dry-run: 4 of 5 notes, no calls");
  ok(fs.readFileSync(path.join(vault, "Hero.md"), "utf8") === fs.readFileSync(path.join(HERE, "fixture-vault/Hero.md"), "utf8"), "dry-run leaves vault untouched");
  let denied = ""; try { await push({ vault, campaign: "2", client: c, apply: true }); } catch (e) { denied = e.code; } ok(denied === "CAMPAIGN_NOT_ALLOWLISTED", "push needs allowlist");
  const r1 = await push({ vault, campaign: "1", client: c, apply: true });
  ok(r1.created.length === 4 && r1.errors.length === 0, "apply creates 4");
  const hero = [...mock.st.ents.values()].find((e) => e.name === "[tinkabot-test] Hero");
  const town = [...mock.st.ents.values()].find((e) => e.name === "[tinkabot-test] Town");
  const vil = [...mock.st.ents.values()].find((e) => e.name === "[tinkabot-test] Villain");
  ok(hero.is_private === true && hero.entry.includes(`[location:${town.entity_id}]`) && hero.entry.includes(`[character:${vil.entity_id}]`), "wikilinks -> entity_id mentions (incl. notes created in same run)");
  ok(!hero.entry.includes("sibling") && !town.entry.includes("bandits"), "GM content never pushed");
  ok(r1.unresolved_links["Session 1"]?.includes("Unknown Place"), "unresolved links reported");
  const r2 = await push({ vault, campaign: "1", client: c, apply: true });
  ok(r2.api_calls === 0 && r2.skipped_unchanged.length === 4 && r2.created.length + r2.updated.length === 0, "second run is idempotent (0 calls)");
  // local edit -> update
  fs.appendFileSync(path.join(vault, "Town.md"), "\nNew paragraph.\n");
  const r3 = await push({ vault, campaign: "1", client: c, apply: true });
  ok(r3.updated.length === 1 && town.entry.includes("New paragraph"), "local change -> PATCH");
  // remote edit + local edit -> conflict
  town.updated_at = "2099-01-01T00:00:00.000000Z"; fs.appendFileSync(path.join(vault, "Town.md"), "\nAnother.\n");
  const r4 = await push({ vault, campaign: "1", client: c, apply: true });
  ok(r4.conflicts.length === 1 && fs.existsSync(path.join(vault, "Town.conflict.md")) && !town.entry.includes("Another"), "remote change -> conflict file, no push");
  const before = mock.st.ents.size; fs.rmSync(path.join(vault, "Villain.md"));
  await push({ vault, campaign: "1", client: c, apply: true });
  ok(mock.st.ents.size === before && !mock.st.log.some((l) => l.method === "DELETE" && l.url.includes(String(vil.id))), "never deletes");
}

// 8. 0.1.1 review fixes
{
  const F = path.join(HERE, "fixtures");
  const rd = (f) => fs.readFileSync(path.join(F, f), "utf8");
  const sI = stripPrivate(rd("strip/indented.md")); ok(!sI.includes("hidden") && !sI.includes("[!secret]") && sI.includes("After indented"), "strip: indented callout");
  const sN = stripPrivate(rd("strip/nested.md")); ok(!sN.includes("hidden") && !sN.includes("[!gm]") && sN.includes("Quote ok") && sN.includes("back to depth one ok"), "strip: nested callout by quote depth");
  const sL = stripPrivate(rd("strip/list-item.md")); ok(!sL.includes("hidden") && !sL.includes("[!secret]") && sL.includes("item three"), "strip: callout inside list item");
  const sU = stripPrivate(rd("strip/unclosed-comment.md")); ok(!sU.includes("hidden") && !sU.includes("unclosed") && sU.includes("Visible start"), "strip: unclosed %% runs to EOF");
  // frontmatter patcher
  const nested = rd("nested-frontmatter.md");
  const pt = patchKankaKeys(nested, { kanka_id: "5", kanka_hash: "abc" });
  const fmOf = (t) => t.split(/\n---\n/)[0];
  ok(fmOf(nested).split("\n").every((l) => pt.includes(l)) && pt.includes("kanka_id: 5") && pt.endsWith("The harbour master of [[Town]].\n"), "patch keeps nested maps, lists, block text, body");
  const pt2 = patchKankaKeys(pt, { kanka_id: "6" }); ok(pt2 === pt.replace("kanka_id: 5", "kanka_id: 6"), "patch replaces existing key in place only");
  const crlf = patchKankaKeys("---\r\na: 1\r\n---\r\nbody", { kanka_id: "1" }); ok(crlf === "---\r\na: 1\r\nkanka_id: 1\r\n---\r\nbody", "patch preserves CRLF");
  ok(patchKankaKeys("body\n", { kanka_id: "1" }) === "---\nkanka_id: 1\n---\nbody\n", "patch adds frontmatter when missing");
  const refuse = (t, u = { kanka_id: "1" }) => { try { patchKankaKeys(t, u); return false; } catch (e) { return e.code === "UNSAFE_FRONTMATTER"; } };
  ok(refuse("---\na: 1\nbody without close\n"), "refuse unclosed frontmatter");
  ok(refuse("---\nkanka_id: |\n  5\n---\nx"), "refuse block kanka_* value");
  ok(refuse("---\nx:\n  kanka_id: 5\n---\nx"), "refuse nested kanka_* key");
  ok(refuse("---\nkanka_id: 1\nkanka_id: 2\n---\nx"), "refuse duplicate kanka_* key");
  ok(refuse("---\na: 1\n---\nx", { title: "x" }), "refuse non-kanka key");
  // push round-trip with nested frontmatter + unsafe note
  const vault = path.join(TMP, "vault2"); fs.mkdirSync(vault);
  fs.copyFileSync(path.join(F, "nested-frontmatter.md"), path.join(vault, "Harbour.md"));
  fs.writeFileSync(path.join(vault, "Broken.md"), "---\ntags: [kanka-publish]\nunclosed: yes\nbody #kanka-publish\n");
  const c = mk(); const n0 = mock.st.log.length;
  const r1 = await push({ vault, campaign: "1", client: c, apply: true });
  const after = fs.readFileSync(path.join(vault, "Harbour.md"), "utf8");
  ok(r1.created.length === 1 && fmOf(nested).split("\n").every((l) => after.includes(l)) && /kanka_id: \d+/.test(after) && after.includes("  Line two: keep this verbatim."), "push round-trip keeps nested frontmatter");
  ok(r1.errors.some((e) => e.note === "Broken" && e.error === "UNSAFE_FRONTMATTER") && fs.readFileSync(path.join(vault, "Broken.md"), "utf8") === "---\ntags: [kanka-publish]\nunclosed: yes\nbody #kanka-publish\n" && !mock.st.log.slice(n0).some((l) => l.body.includes("Broken")), "unsafe frontmatter: refused, untouched, no API write");
  const hm = [...mock.st.ents.values()].find((e) => e.name === "[tinkabot-test] Harbour Master"); ok(hm && !hm.entry.includes("hp"), "nested frontmatter not pushed as content");
  const r2 = await push({ vault, campaign: "1", client: c, apply: true }); ok(r2.api_calls === 0 && fs.readFileSync(path.join(vault, "Harbour.md"), "utf8") === after, "nested round-trip idempotent");
  // missing kanka_updated_at -> conflict
  fs.writeFileSync(path.join(vault, "Harbour.md"), after.replace(/kanka_updated_at: .*\n/, "") + "\nMore.\n");
  const r3 = await push({ vault, campaign: "1", client: c, apply: true }); ok(r3.conflicts.some((x) => x.note === "Harbour") && !hm.entry.includes("More"), "missing kanka_updated_at counts as conflict");
  // Retry-After cap + min interval cap
  waits.length = 0; mock.st.inject.push({ status: 429, headers: { "retry-after": "300" } });
  let rc = ""; try { await mk().get("profile"); } catch (e) { rc = e.code; } ok(rc === "RATE_LIMITED" && !waits.some((w) => w > 120000), "Retry-After over 120 s -> RATE_LIMITED, no long sleep");
  waits.length = 0; mock.st.inject.push({ status: 429, headers: { "retry-after": "100" } });
  await mk().get("profile"); ok(waits.some((w) => w >= 100000 && w < 101000), "Retry-After under cap honoured");
  ok(new RateLimiter({ minIntervalMs: 9e9 }).minIntervalMs === 60000, "KANKA_MIN_INTERVAL_MS capped at 60 s");
  // tool nits
  const loc = await call("kanka_create", { campaign_id: "1", type: "location", fields: { name: "Nit" } }); const L = (await call("kanka_create", { campaign_id: "1", type: "location", fields: { name: "Nit" }, confirm_token: loc.confirm_token })).item;
  const bad = await call("kanka_update", { campaign_id: "1", type: "location", id: String(L.id), patch: { campaign_id: 2 } }); ok(bad.error === "BAD_ARGS", "kanka_update field allowlist");
  const wpv = await call("kanka_update", { campaign_id: "1", type: "location", id: String(L.id), patch: { entry: "", is_private: false } });
  ok(wpv.status === "PREVIEW" && wpv.warnings?.length === 2, "warnings for entry:\"\" and is_private:false");
  const mp = await call("kanka_list", { campaign_id: "1", type: "note", all: true, max_pages: 0 }); ok(mp.pages >= 1 && !mp.error, "max_pages 0 clamped");
  const mp2 = await call("kanka_list", { campaign_id: "1", type: "note", all: true, max_pages: 1e6 }); ok(!mp2.error && mp2.pages <= 50, "max_pages huge clamped");
  const mp3 = await call("kanka_list", { campaign_id: "1", type: "note", all: true, max_pages: 1 }); ok(mp3.pages === 1, "max_pages respected");
  process.env.KANKA_ALLOW_DELETE = "1";
  const dp = await call("kanka_delete", { campaign_id: "1", kind: "entity", type: "location", id: String(L.id) });
  const dn = await call("kanka_delete", { campaign_id: "1", kind: "entity", type: "location", id: String(L.id), confirm_token: dp.confirm_token, confirm_name: ["Nit"] });
  ok(dn.error === "CONFIRM_NAME_MISMATCH" && mock.st.ents.has(L.entity_id), "non-string name echo refused");
  delete process.env.KANKA_ALLOW_DELETE;
  process.env.KANKA_CAMPAIGN_ALLOWLIST = " 1, 3 ";
  const lc = await call("kanka_list_campaigns", {}); ok(lc.campaigns.map((x) => x.write_allowlisted).join() === "true,false,true", "list_campaigns uses allowlist()");
  process.env.KANKA_CAMPAIGN_ALLOWLIST = "1";
}

// 9. 0.1.2: preflight every written key; callout metadata
{
  const F = path.join(HERE, "fixtures");
  const sM = stripPrivate(fs.readFileSync(path.join(F, "strip/callout-metadata.md"), "utf8"));
  ok(!sM.includes("hidden") && !sM.includes("[!secret") && sM.includes("Tail."), "strip: [!secret|wide] callout metadata");
  ok(!stripPrivate("> [!GM|left] x\n> gone\nok").includes("gone"), "strip: [!gm|...] case-insensitive");
  const cases = {
    "nested kanka_hash": "---\ntags: [kanka-publish]\nkanka_type: note\nmeta:\n  kanka_hash: abc\n---\nBody A\n",
    "kanka_id block": "---\ntags: [kanka-publish]\nkanka_type: note\nkanka_id: |\n  77\n---\nBody B\n",
    "kanka_id list": "---\ntags: [kanka-publish]\nkanka_id:\n  - 77\n---\nBody C\n",
    "kanka_entity_id map": "---\ntags: [kanka-publish]\nkanka_entity_id: {a: 1}\n---\nBody D\n",
    "kanka_updated_at folded": "---\ntags: [kanka-publish]\nkanka_id: 5\nkanka_updated_at: >\n  2026\n---\nBody E\n",
  };
  for (const [name, text] of Object.entries(cases)) {
    const vault = path.join(TMP, "pf-" + name.replace(/\W/g, "_")); fs.mkdirSync(vault); fs.writeFileSync(path.join(vault, "N.md"), text);
    const c = mk(); const n0 = mock.st.log.length; const e0 = mock.st.ents.size;
    const r1 = await push({ vault, campaign: "1", client: c, apply: true });
    const r2 = await push({ vault, campaign: "1", client: c, apply: true });
    ok(r1.api_calls === 0 && r2.api_calls === 0 && mock.st.log.length === n0 && mock.st.ents.size === e0 && r1.errors[0]?.error === "UNSAFE_FRONTMATTER" && fs.readFileSync(path.join(vault, "N.md"), "utf8") === text, `preflight refuses ${name}: zero API calls, no duplicates, file untouched`);
  }
  // quoted names with brackets are still fine
  const v2 = path.join(TMP, "pf-ok"); fs.mkdirSync(v2); fs.writeFileSync(path.join(v2, "Ok.md"), '---\ntags: [kanka-publish]\nkanka_name: "[tinkabot-test] Ok"\n---\nfine\n');
  const rk = await push({ vault: v2, campaign: "1", client: mk(), apply: true }); ok(rk.created.length === 1 && rk.errors.length === 0, "quoted bracket name passes preflight");
}

await mock.close(); fs.rmSync(TMP, { recursive: true, force: true });
console.log(`selftest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
