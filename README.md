# kanka-mcp

A zero-dependency stdio MCP server and Agent Plugin for the [Kanka](https://kanka.io) worldbuilding API, plus a
one-way Obsidian to Kanka push skill.

- 13 read tools and 8 gated write tools (see `skills/kanka-api/SKILL.md`).
- Every write is two-phase: a preview with a `confirm_token` bound to the payload hash, then the confirmed call.
- New entities and attributes are private; new posts and relations use visibility 3 (admin).
- Writes only touch campaigns in `KANKA_CAMPAIGN_ALLOWLIST`. Deletes are off unless `KANKA_ALLOW_DELETE=1`,
  take one item, and need the item's exact name echoed back.
- The token is read from `KANKA_TOKEN`, sent only as a Bearer header, never logged or put in a URL, and shown
  as a sha256 prefix only.
- Client-side token bucket (90% of `profile.rate_limit`, synced to `x-ratelimit-remaining`) with 429 backoff.
  `KANKA_RATE_LIMIT` / `KANKA_MIN_INTERVAL_MS` can only slow it down.
- Not wrapped on purpose: transfer, transform, recover, permissions, campaign settings and members.

## Install
Requires Node 18+. No `npm install`.

```
export KANKA_TOKEN=...                 # Kanka > Profile > API (expires after 365 days)
export KANKA_CAMPAIGN_ALLOWLIST=12345  # campaigns writes may touch
./run-mcp.sh                           # stdio MCP server (NDJSON or Content-Length framing)
```

`mcp.json` registers the server as `kanka`. See `run-mcp.sh` for every env var.

## Obsidian push
```
node skills/obsidian-kanka-push/push.mjs --vault ~/Vault --campaign 12345          # dry-run
node skills/obsidian-kanka-push/push.mjs --vault ~/Vault --campaign 12345 --apply  # write
```
Details in `skills/obsidian-kanka-push/SKILL.md`.

## Tests
```
node test/selftest.js                                   # offline, against a local mock server
KANKA_LIVE_CAMPAIGN=<throwaway id> KANKA_CAMPAIGN_ALLOWLIST=<same id> node test/live-test.js
```
The live test only runs against a throwaway campaign; it prefixes everything it creates with
`[tinkabot-test]` and deletes it at the end.

## Repository
The repository URL in `plugin.json` (github.com/dreaming144/kanka-mcp) is still to be created.

## Licence
MIT, Chris R.
