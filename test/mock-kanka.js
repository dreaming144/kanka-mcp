// In-memory mock of the Kanka API subset used by kanka-mcp (shapes copied from live responses, 21 Oct 2026).
import http from "node:http";
export function startMock({ token = "test-token-0123456789abcdef", perPage = 2 } = {}) {
  const st = { seq: 100, eseq: 5000, ents: new Map(), posts: [], attrs: [], rels: [], log: [], inject: [], clock: 0 };
  const ts = () => new Date(Date.UTC(2026, 9, 21, 0, 0, st.clock++)).toISOString().replace(/\.\d+Z$/, ".000000Z");
  const PL = { characters: "character", locations: "location", notes: "note", items: "item" };
  const srv = http.createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    const u = new URL(req.url, "http://x"); const p = u.pathname.replace(/^\/1\.0\//, "");
    st.log.push({ method: req.method, url: req.url, auth: req.headers.authorization, accept: req.headers.accept, ctype: req.headers["content-type"], body });
    const send = (code, obj, h = {}) => { res.writeHead(code, { "content-type": "application/json", "x-ratelimit-limit": "600", "x-ratelimit-remaining": "500", ...h }); res.end(obj === undefined ? "" : JSON.stringify(obj)); };
    if (st.inject.length) { const i = st.inject.shift(); return send(i.status, i.body ?? { message: "Too Many Attempts." }, i.headers || {}); }
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { message: "Unauthenticated." });
    const j = body ? JSON.parse(body) : {};
    const page = (arr, base) => {
      const pg = +(u.searchParams.get("page") || 1); const last = Math.max(1, Math.ceil(arr.length / perPage));
      const nextUrl = st.badNext ? "http://evil.example/1.0/x?page=2" : `http://${req.headers.host}/1.0/${base}?page=${pg + 1}`;
      return { data: arr.slice((pg - 1) * perPage, pg * perPage), sync: ts(), links: { next: pg < last ? nextUrl : null }, meta: { current_page: pg, last_page: last, per_page: perPage, total: arr.length } };
    };
    let m;
    if (p === "profile") return send(200, { data: { id: 7, name: "Tester", rate_limit: 600, default_pagination: 0, is_patreon: false } });
    if (p === "campaigns") return send(200, page([{ id: 1, name: "Mock A", locale: "en" }, { id: 2, name: "Mock B" }, { id: 3, name: "Mock C" }], "campaigns"));
    if (p === "entity-types") return send(200, { data: [{ id: 1, code: "character", plural: "Characters", is_enabled: true }, { id: 3, code: "location", plural: "Locations", is_enabled: true }] });
    if (p === "echo-token") return send(422, { message: `bad token ${token} Bearer ${token}` });
    if ((m = /^campaigns\/(\d+)\/(characters|locations|notes|items)(?:\/(\d+))?$/.exec(p))) {
      const [, cid, ep, id] = m; const list = [...st.ents.values()].filter((e) => e.campaign === cid && e.ep === ep);
      if (!id && req.method === "GET") { const ls = u.searchParams.get("lastSync"); return send(200, page(ls ? list.filter((e) => e.updated_at > ls) : list, `campaigns/${cid}/${ep}`)); }
      if (!id && req.method === "POST") { if (!j.name) return send(422, { message: "The given data was invalid.", errors: { name: ["The name field is required."] } }); const e = { id: ++st.seq, entity_id: ++st.eseq, campaign: cid, ep, name: j.name, entry: j.entry ?? "", is_private: j.is_private ?? false, updated_at: ts() }; st.ents.set(e.entity_id, e); return send(201, { data: e }); }
      const e = list.find((x) => x.id === +id); if (!e) return send(404, { error: "Page not found" });
      if (req.method === "GET") return send(200, { data: e });
      if (req.method === "PATCH") { Object.assign(e, j, { updated_at: ts() }); return send(200, { data: e }); }
      if (req.method === "PUT") return send(405, { code: 405, error: "use PATCH in mock" });
      if (req.method === "DELETE") { st.ents.delete(e.entity_id); return send(204); }
    }
    if ((m = /^campaigns\/(\d+)\/entities\/(\d+)$/.exec(p))) { const e = st.ents.get(+m[2]); if (!e) return send(404, { error: "Page not found" }); if (req.method === "PATCH") { Object.assign(e, j, { updated_at: ts() }); } return send(200, { data: { id: e.entity_id, name: e.name, type: PL[e.ep], child_id: e.id, is_private: e.is_private, updated_at: e.updated_at } }); }
    if ((m = /^campaigns\/(\d+)\/entities\/(\d+)\/(posts|attributes|relations|mentions)(?:\/(\d+))?$/.exec(p))) {
      const [, , eid, kind, id] = m; const arr = kind === "posts" ? st.posts : kind === "attributes" ? st.attrs : kind === "relations" ? st.rels : [];
      const mine = arr.filter((x) => (x.entity_id ?? x.owner_id) === +eid);
      if (!id && req.method === "GET") return send(200, page(mine, `campaigns/${m[1]}/entities/${eid}/${kind}`));
      if (!id && req.method === "POST") { const x = { id: ++st.seq, entity_id: +eid, ...j, updated_at: ts() }; if (kind === "relations") { delete x.entity_id; arr.push(x); return send(200, { data: [x] }); } arr.push(x); return send(201, { data: x }); }
      const x = mine.find((y) => y.id === +id); if (!x) return send(404, { error: "Page not found" });
      if (req.method === "GET") return send(200, { data: x });
      if (req.method === "PATCH") { Object.assign(x, j); return send(200, { data: x }); }
      if (req.method === "DELETE") { arr.splice(arr.indexOf(x), 1); return send(204); }
    }
    return send(404, { error: "Page not found" });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, st, token, base: `http://127.0.0.1:${srv.address().port}/1.0`, close: () => new Promise((z) => srv.close(z)) })));
}
