#!/usr/bin/env node
// One-way Obsidian -> Kanka push for notes tagged #kanka-publish (or frontmatter `kanka: publish`).
// Dry-run by default; --apply writes. Hash-skip, conflict detection, never deletes. Zero dependencies.
// Usage: node push.mjs --vault <dir> --campaign <id> [--apply] [--json]
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { KankaClient, endpointFor, requireAllowed, redact } from "../../server/kanka.js";

// ---------- frontmatter ----------
export function parseNote(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const fm = {}; const order = [];
  if (m) {
    let curList = null;
    for (const line of m[1].split(/\r?\n/)) {
      const li = /^\s*-\s+(.*)$/.exec(line);
      if (li && curList) { fm[curList].push(unq(li[1])); continue; }
      const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
      if (!kv) continue;
      const [, k, v] = kv; order.push(k); curList = null;
      if (v === "") { fm[k] = []; curList = k; }
      else if (/^\[.*\]$/.test(v)) fm[k] = v.slice(1, -1).split(",").map((x) => unq(x.trim())).filter(Boolean);
      else fm[k] = unq(v);
    }
  }
  return { fm, order, body: m ? text.slice(m[0].length) : text };
}
const unq = (s) => String(s).replace(/^(["'])(.*)\1$/, "$2");
/**
 * Patch only kanka_* keys in the raw note text; every other byte of the frontmatter is kept.
 * Refuses (throws UNSAFE_FRONTMATTER) when the frontmatter can't be patched safely: unclosed block,
 * a kanka_* key that is nested, repeated, or has a block/multi-line value.
 */
export function patchKankaKeys(raw, updates) {
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const fmLine = (k, v) => `${k}: ${/^[\w .\-/:+]*$/.test(String(v)) && String(v) !== "" && String(v).trim() === String(v) ? v : JSON.stringify(String(v))}`;
  for (const k of Object.keys(updates)) if (!/^kanka_[a-z_]+$/.test(k)) throw Object.assign(new Error(`refusing to write non-kanka key ${k}`), { code: "UNSAFE_FRONTMATTER" });
  if (!/^---\r?\n/.test(raw)) {
    if (/^\s*---/.test(raw)) throw Object.assign(new Error("frontmatter start is not at byte 0"), { code: "UNSAFE_FRONTMATTER" });
    return `---${eol}${Object.entries(updates).map(([k, v]) => fmLine(k, v)).join(eol)}${eol}---${eol}${raw}`;
  }
  const m = /^---\r?\n([\s\S]*?)(\r?\n)---[ \t]*(\r?\n|$)/.exec(raw) || /^---\r?\n()---[ \t]*(\r?\n|$)/.exec(raw);
  if (!m) throw Object.assign(new Error("frontmatter is not closed"), { code: "UNSAFE_FRONTMATTER" });
  const lines = m[1] === "" ? [] : m[1].split(/\r?\n/);
  for (const k of Object.keys(updates)) {
    const idx = lines.map((l, i) => [l, i]).filter(([l]) => new RegExp(`^\\s*${k}\\s*:`).test(l));
    if (idx.length > 1) throw Object.assign(new Error(`${k} appears more than once`), { code: "UNSAFE_FRONTMATTER" });
    if (!idx.length) { lines.push(fmLine(k, updates[k])); continue; }
    const [l, i] = idx[0];
    if (/^\s/.test(l)) throw Object.assign(new Error(`${k} is nested`), { code: "UNSAFE_FRONTMATTER" });
    const v = l.replace(/^[^:]*:\s*/, "");
    if (v === "" || /^[|>]/.test(v) || /^\s/.test(lines[i + 1] ?? "x") || /^["'[{]/.test(v) && !/^(["']).*\1\s*$|^\[.*\]\s*$|^\{.*\}\s*$/.test(v))
      throw Object.assign(new Error(`${k} has a block or multi-line value`), { code: "UNSAFE_FRONTMATTER" });
    lines[i] = fmLine(k, updates[k]);
  }
  const close = m[0].slice(m[0].lastIndexOf("---"));
  return `---${eol}${lines.join(eol)}${lines.length ? eol : ""}${close}${raw.slice(m[0].length)}`;
}

// ---------- markdown -> HTML ----------
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function inline(s, link) {
  s = esc(s);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_, t, alias) => link(t.trim(), alias?.trim()));
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>").replace(/(^|\W)_([^_]+)_(?=\W|$)/g, "$1<em>$2</em>");
  return s;
}
/** Remove GM-only material: [!secret] / [!gm] callouts at any indent, quote depth or inside list items
 *  (everything quoted at that depth or deeper is dropped), %% comments %% (an unclosed %% runs to EOF),
 *  and the publish tag. */
const QUOTE = /^\s*(?:(?:[-*+]|\d+[.)])\s+)?((?:>\s*)+)/;
export function stripPrivate(md) {
  const out = []; let depth = 0;
  for (const line of md.replace(/%%[\s\S]*?(?:%%|$)/g, "").split(/\r?\n/)) {
    const q = QUOTE.exec(line); const d = q ? (q[1].match(/>/g) || []).length : 0;
    if (depth) { if (d >= depth) continue; depth = 0; }
    if (/^\s*(?:(?:[-*+]|\d+[.)])\s+)?(>\s*)+\[!(secret|gm)(?:\|[^\]]*)?\]/i.test(line)) { depth = d; continue; }
    out.push(line);
  }
  return out.join("\n").replace(/(^|\s)#kanka-publish\b/g, "$1").trim();
}
export function mdToHtml(md, link) {
  const lines = md.split(/\r?\n/); const html = []; let para = []; let list = null; const unsupported = [];
  const flush = () => { if (para.length) html.push(`<p>${inline(para.join(" "), link)}</p>`); para = []; };
  const close = () => { if (list) { html.push(`</${list}>`); list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if (!l.trim()) { flush(); close(); continue; }
    if ((m = /^(#{1,6})\s+(.*)$/.exec(l))) { flush(); close(); html.push(`<h${m[1].length}>${inline(m[2], link)}</h${m[1].length}>`); continue; }
    if ((m = /^\s*[-*+]\s+(.*)$/.exec(l)) || (m = /^\s*\d+[.)]\s+(.*)$/.exec(l))) {
      flush(); const t = /^\s*\d/.test(l) ? "ol" : "ul"; if (list !== t) { close(); html.push(`<${t}>`); list = t; }
      html.push(`<li>${inline(m[1], link)}</li>`); continue;
    }
    if (/^\|.*\|\s*$/.test(l)) {
      flush(); close(); const rows = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]); i--;
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      if (rows.length >= 2 && /^[\s|:-]+$/.test(rows[1])) {
        const [h, , ...b] = rows;
        html.push(`<table><thead><tr>${cells(h).map((c) => `<th>${inline(c, link)}</th>`).join("")}</tr></thead><tbody>${b.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c, link)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      } else { unsupported.push("table"); html.push(`<pre>${esc(rows.join("\n"))}</pre>`); }
      continue;
    }
    if ((m = /^>\s?(.*)$/.exec(l))) { flush(); close(); html.push(`<blockquote>${inline(m[1], link)}</blockquote>`); continue; }
    close(); para.push(l.trim());
  }
  flush(); close();
  return { html: html.join("\n"), unsupported };
}

// ---------- vault ----------
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith(".md") && !e.name.endsWith(".conflict.md")) out.push(p);
  }
  return out;
}
const isPublish = (n) => (Array.isArray(n.fm.tags) ? n.fm.tags : [n.fm.tags]).some((t) => String(t).replace(/^#/, "") === "kanka-publish") || n.fm.kanka === "publish" || /(^|\s)#kanka-publish\b/.test(n.body);
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

export function loadVault(vault) {
  return walk(vault).map((file) => { const raw = fs.readFileSync(file, "utf8"); const n = parseNote(raw); return { file, title: path.basename(file, ".md"), ...n, publish: isPublish(n) }; });
}

export function buildPayload(note, byTitle) {
  const unresolved = [];
  const link = (target, alias) => {
    const t = byTitle.get(target.toLowerCase());
    if (t && t.publish && t.fm.kanka_entity_id && t.fm.kanka_type) return `[${t.fm.kanka_type}:${t.fm.kanka_entity_id}]`;
    unresolved.push(target); return esc(alias || target);
  };
  const { html, unsupported } = mdToHtml(stripPrivate(note.body), link);
  const name = note.fm.kanka_name || note.fm.title || note.title;
  const type = endpointFor(note.fm.kanka_type || "note").code;
  const hash = sha(JSON.stringify({ name, type, entry: html }));
  return { name, type, entry: html, hash, unresolved, unsupported };
}

function save(note, updates) {
  const raw = fs.readFileSync(note.file, "utf8");
  const text = patchKankaKeys(raw, updates); // throws before writing if unsafe
  fs.writeFileSync(note.file, text);
  Object.assign(note.fm, updates);
}

const WRITE_KEYS = ["kanka_type", "kanka_id", "kanka_entity_id", "kanka_hash", "kanka_updated_at", "kanka_synced_at"];

export async function push({ vault, campaign, apply = false, client = new KankaClient(), now = () => new Date().toISOString() }) {
  const cid = requireAllowed(campaign);
  const notes = loadVault(vault);
  const byTitle = new Map(notes.map((n) => [n.title.toLowerCase(), n]));
  const report = { mode: apply ? "apply" : "dry-run", campaign: cid, scanned: notes.length, publish: 0, created: [], updated: [], skipped_unchanged: [], conflicts: [], missing_remote: [], untagged_but_synced: [], unresolved_links: {}, unsupported: {}, errors: [], api_calls: 0 };
  const start = client.calls;
  for (const n of notes) if (!n.publish && n.fm.kanka_entity_id) report.untagged_but_synced.push(n.title);
  const pub = notes.filter((n) => n.publish); report.publish = pub.length;

  // Preflight: never create remotely what we can't record locally.
  // Test-patch every key push may write, and refuse any parsed kanka_* value that isn't a plain scalar.
  for (const n of pub) {
    try {
      for (const [k, v] of Object.entries(n.fm)) {
        if (!k.startsWith("kanka_")) continue;
        if (typeof v !== "string" || /^[|>{]/.test(v)) throw new Error(`${k} is not a plain scalar`);
      }
      patchKankaKeys(fs.readFileSync(n.file, "utf8"), Object.fromEntries(WRITE_KEYS.map((k) => [k, "x"])));
      n.safe = true;
    } catch (e) { n.safe = false; report.errors.push({ note: n.title, error: "UNSAFE_FRONTMATTER", message: e.message }); }
  }
  // Phase A: create new entities (so links between new notes resolve in the same run).
  const fresh = pub.filter((n) => !n.fm.kanka_id && n.safe);
  for (const n of fresh) {
    const p = buildPayload(n, byTitle);
    if (!apply) { report.created.push({ note: n.title, type: p.type, private: true }); continue; }
    try {
      const { path: ep } = endpointFor(p.type);
      const d = (await client.request("POST", `campaigns/${cid}/${ep}`, { body: { name: p.name, entry: p.entry, is_private: true } })).data;
      n._sentEntry = p.entry; save(n, { kanka_type: p.type, kanka_id: String(d.id), kanka_entity_id: String(d.entity_id), kanka_hash: p.hash, kanka_updated_at: d.updated_at, kanka_synced_at: now() });
      report.created.push({ note: n.title, type: p.type, id: d.id, entity_id: d.entity_id });
    } catch (e) { report.errors.push({ note: n.title, error: e.code || "ERR", message: redact(e.message, client.token) }); }
  }
  // Phase B: update changed notes (hash-skip; conflict if the remote changed since our last push).
  for (const n of pub) {
    if (!n.fm.kanka_id || !n.safe) continue; // dry-run new note or unsafe
    const p = buildPayload(n, byTitle);
    if (p.unresolved.length) report.unresolved_links[n.title] = [...new Set(p.unresolved)];
    if (p.unsupported.length) report.unsupported[n.title] = p.unsupported;
    if (n.fm.kanka_hash === p.hash) { if (!n._sentEntry) report.skipped_unchanged.push(n.title); continue; }
    if (!apply) { report.updated.push({ note: n.title, reason: "content changed" }); continue; }
    const { path: ep } = endpointFor(n.fm.kanka_type || p.type);
    const u = `campaigns/${cid}/${ep}/${n.fm.kanka_id}`;
    try {
      if (!n._sentEntry) {
        let remote;
        try { remote = (await client.get(u)).data; } catch (e) { if (e.status === 404) { report.missing_remote.push(n.title); continue; } throw e; }
        if (!n.fm.kanka_updated_at || remote.updated_at !== n.fm.kanka_updated_at) {
          const cf = n.file.replace(/\.md$/, ".conflict.md");
          fs.writeFileSync(cf, `# Conflict: ${n.title}\n\nKanka was edited at ${remote.updated_at} after the last push (${n.fm.kanka_updated_at || "no kanka_updated_at baseline recorded"}). Nothing was pushed.\nResolve by editing the note, then set kanka_updated_at to ${remote.updated_at} to accept the remote baseline.\n\n## Remote entry (HTML)\n\n${remote.entry || ""}\n`);
          report.conflicts.push({ note: n.title, remote_updated_at: remote.updated_at, file: path.relative(vault, cf) });
          continue;
        }
      }
      const d = (await client.request("PATCH", u, { body: { name: p.name, entry: p.entry } })).data;
      save(n, { kanka_hash: p.hash, kanka_updated_at: d.updated_at, kanka_synced_at: now() });
      if (!n._sentEntry) report.updated.push({ note: n.title, id: n.fm.kanka_id });
    } catch (e) { report.errors.push({ note: n.title, error: e.code || "ERR", message: redact(e.message, client.token) }); }
  }
  report.api_calls = client.calls - start;
  return report;
}

const isMain = (() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  const argv = process.argv.slice(2); const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const vault = opt("--vault"); const campaign = opt("--campaign") || process.env.KANKA_CAMPAIGN_ID;
  if (!vault || !campaign) { process.stderr.write("usage: push.mjs --vault <dir> --campaign <id> [--apply]\n"); process.exit(2); }
  push({ vault: path.resolve(vault), campaign, apply: argv.includes("--apply") })
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + "\n"); process.exit(r.errors.length ? 1 : 0); })
    .catch((e) => { process.stderr.write(`push: ${e.code || "ERR"}: ${redact(e.message, process.env.KANKA_TOKEN)}\n`); process.exit(1); });
}
