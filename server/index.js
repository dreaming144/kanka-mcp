#!/usr/bin/env node
// kanka-mcp: zero-dependency stdio MCP server for the Kanka API (https://api.kanka.io/1.0).
// stdout carries JSON-RPC only; every log line goes to stderr.
// Framing (inbound): NDJSON lines, OR "Content-Length: N" headers terminated by LF-LF or CRLF-CRLF.
// Outbound mirrors the request: NDJSON -> NDJSON; Content-Length (LF|CRLF) -> same terminator.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { log } from "./kanka.js";
import { TOOLS, callTool } from "./tools.js";

export const SERVER_NAME = "kanka-mcp";
export const VERSION = "0.1.2";
const LIMITS = { maxInboundBytes: 4 * 1024 * 1024 };
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export async function handleRpc(msg) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return { jsonrpc: "2.0", id: msg && typeof msg === "object" && "id" in msg ? msg.id : null, error: { code: -32600, message: "Invalid Request" } };
  }
  const isNote = !("id" in msg);
  const reply = (result) => (isNote ? null : { jsonrpc: "2.0", id: msg.id, result });
  const fail = (code, message) => (isNote ? null : { jsonrpc: "2.0", id: msg.id, error: { code, message } });
  const p = msg.params || {};
  switch (msg.method) {
    case "initialize": {
      const v = PROTOCOLS.includes(p.protocolVersion) ? p.protocolVersion : PROTOCOLS[0];
      return reply({ protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: { name: SERVER_NAME, version: VERSION },
        instructions: "Kanka worldbuilding API. Reads are free; every write is two-phase (preview -> confirm_token). New items are private/admin by default. Deletes are off unless KANKA_ALLOW_DELETE=1. Writes require KANKA_CAMPAIGN_ALLOWLIST." });
    }
    case "ping": return reply({});
    case "tools/list": return reply({ tools: TOOLS });
    case "tools/call": {
      if (typeof p.name !== "string") return fail(-32602, "Invalid params: name required");
      const r = await callTool(p.name, p.arguments);
      if (r.unknown) return fail(-32602, `Unknown tool: ${p.name.slice(0, 80)}`);
      return reply(r);
    }
    case "resources/list": return reply({ resources: [] });
    case "resources/templates/list": return reply({ resourceTemplates: [] });
    case "prompts/list": return reply({ prompts: [] });
    case "logging/setLevel": return reply({});
    default:
      if (msg.method.startsWith("notifications/")) return null;
      return fail(-32601, `Method not found: ${msg.method.slice(0, 80)}`);
  }
}

// --- Framing -----------------------------------------------------------------
/** Encode one outbound message. framing: "ndjson" | "cl"; term: "\n" | "\r\n" (cl only). */
export function encodeFrame(obj, framing = "ndjson", term = "\n") {
  const body = JSON.stringify(obj);
  if (framing === "cl") return Buffer.concat([Buffer.from(`Content-Length: ${Buffer.byteLength(body)}${term}${term}`, "latin1"), Buffer.from(body, "utf8")]);
  return Buffer.from(body + "\n", "utf8");
}

const CL_PREFIX = "content-length:";
/**
 * Incremental inbound parser. Accepts NDJSON lines and Content-Length frames (LF-LF or CRLF-CRLF) in any mix.
 * onMessage(parsed, framing, term); onParseError(framing, term, reason).
 */
export function createFrameParser(onMessage, onParseError) {
  let buf = Buffer.alloc(0);
  const parse = (bytes, framing, term) => {
    let obj;
    try { obj = JSON.parse(bytes.toString("utf8")); } catch { onParseError(framing, term, "Parse error"); return; }
    onMessage(obj, framing, term);
  };
  function drain(atEnd) {
    for (;;) {
      let i = 0;
      while (i < buf.length && (buf[i] === 0x0a || buf[i] === 0x0d || buf[i] === 0x20 || buf[i] === 0x09)) i++;
      if (i) buf = buf.subarray(i);
      if (!buf.length) return;
      const head = buf.subarray(0, CL_PREFIX.length).toString("latin1").toLowerCase();
      const maybeCl = head === CL_PREFIX || (buf.length < CL_PREFIX.length && CL_PREFIX.startsWith(head));
      if (maybeCl) {
        if (buf.length < CL_PREFIX.length) { if (atEnd) buf = Buffer.alloc(0); return; }
        const probe = buf.subarray(0, Math.min(buf.length, 8192)).toString("latin1");
        const m = /\r?\n\r?\n/.exec(probe);
        if (!m) {
          if (buf.length > 8192 || atEnd) { onParseError("cl", "\n", "Malformed headers"); buf = Buffer.alloc(0); }
          return;
        }
        const header = probe.slice(0, m.index);
        const term = m[0].includes("\r") ? "\r\n" : "\n";
        const lm = /^content-length:[ \t]*(\d{1,10})[ \t]*$/im.exec(header);
        const bodyStart = m.index + m[0].length;
        if (!lm) { onParseError("cl", term, "Missing or invalid Content-Length"); buf = buf.subarray(bodyStart); continue; }
        const len = Number(lm[1]);
        if (len > LIMITS.maxInboundBytes) { onParseError("cl", term, "Message too large"); buf = Buffer.alloc(0); return; }
        if (buf.length < bodyStart + len) return;
        const body = buf.subarray(bodyStart, bodyStart + len);
        buf = buf.subarray(bodyStart + len);
        parse(body, "cl", term);
        continue;
      }
      const nl = buf.indexOf(0x0a);
      if (nl === -1) {
        if (buf.length > LIMITS.maxInboundBytes) { onParseError("ndjson", "\n", "Message too large"); buf = Buffer.alloc(0); return; }
        if (atEnd) { const line = buf; buf = Buffer.alloc(0); parse(line, "ndjson", "\n"); }
        return;
      }
      let line = buf.subarray(0, nl);
      buf = buf.subarray(nl + 1);
      if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
      if (!line.length) continue;
      parse(line, "ndjson", "\n");
    }
  }
  return {
    push(chunk) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
      drain(false);
    },
    end() { drain(true); },
  };
}

export function startStdioServer({ input = process.stdin, output = process.stdout } = {}) {
  const inflight = new Set();
  const write = (obj, framing, term) => { try { output.write(encodeFrame(obj, framing, term)); } catch (e) { log("write failed", String(e?.code || e)); } };
  const handleOne = async (m) => {
    try { return await handleRpc(m); } catch (e) {
      log("handler error", String(e?.stack || e).slice(0, 400));
      return { jsonrpc: "2.0", id: m && typeof m === "object" && "id" in m ? m.id : null, error: { code: -32603, message: "Internal error" } };
    }
  };
  const parser = createFrameParser(
    (obj, framing, term) => {
      const job = (async () => {
        if (Array.isArray(obj)) {
          if (obj.length === 0) return write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }, framing, term);
          const rs = (await Promise.all(obj.map(handleOne))).filter(Boolean);
          if (rs.length) write(rs, framing, term);
          return;
        }
        const r = await handleOne(obj);
        if (r) write(r, framing, term);
      })();
      inflight.add(job);
      job.finally(() => inflight.delete(job));
    },
    (framing, term, reason) => write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: reason } }, framing, term),
  );
  input.on("data", (c) => parser.push(c));
  input.on("end", async () => {
    parser.end();
    await Promise.allSettled([...inflight]);
    process.exit(0);
  });
  input.on("error", (e) => { log("stdin error", String(e?.code || e)); process.exit(1); });
  log(`${SERVER_NAME} ${VERSION} ready (stdio)`);
}

// Run only when executed directly (the selftests import this module without starting the server).
const isMain = (() => {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) startStdioServer();
