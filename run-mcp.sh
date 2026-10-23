#!/usr/bin/env bash
# Launch the kanka-mcp stdio MCP server. stdout = JSON-RPC only; logs go to stderr.
# Env:
#   KANKA_TOKEN               (required) personal access token from Kanka Profile > API. Never logged.
#   KANKA_CAMPAIGN_ALLOWLIST  comma-separated campaign ids that writes/deletes may touch (none = read-only)
#   KANKA_CAMPAIGN_ID         default campaign id for tools
#   KANKA_ALLOW_DELETE=1      enable single-item, name-echo deletes (off by default)
#   KANKA_RATE_LIMIT          lower the per-minute budget (can only slow down)
#   KANKA_MIN_INTERVAL_MS     minimum gap between calls (can only slow down)
#   KANKA_STATE_FILE          lastSync state file (default ~/.kanka-mcp/last-sync.json)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
cd "$ROOT/server"
exec node index.js
