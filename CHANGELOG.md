# Changelog

## 0.1.2 (2026-10-21)
- Push preflight now test-patches every key push may write (kanka_type, kanka_id, kanka_entity_id,
  kanka_hash, kanka_updated_at, kanka_synced_at) and refuses any parsed kanka_* value that isn't a plain
  scalar (block `|`/`>`, list, map), all before any API call. Fixes duplicate entities being created on every
  run when a kanka_* key was nested under another key.
- Callouts with Obsidian metadata (`> [!secret|wide]`, `> [!gm|...]`) are now stripped.

## 0.1.1 (2026-10-21)
- Push: `--apply` now patches only `kanka_*` keys in the raw frontmatter (nested maps, lists and block text
  are kept byte for byte) and refuses notes whose frontmatter can't be patched safely, before any API call.
- Push: `[!secret]`/`[!gm]` callouts are stripped at any indent, quote depth, or inside list items; an
  unclosed `%%` comment runs to the end of the note.
- Push: a note with a Kanka id but no `kanka_updated_at` is treated as a conflict.
- Client: Retry-After over 120 s returns RATE_LIMITED instead of sleeping; KANKA_MIN_INTERVAL_MS capped at 60 s.
- Tools: `kanka_update` field allowlist plus warnings for `entry: ""` and `is_private: false`; `max_pages`
  clamped to 1..50; delete name echo must be a string; `kanka_list_campaigns` uses the shared allowlist parser.

## 0.1.0 (2026-10-21)
- First release: 21 tools (13 reads, 8 two-phase writes including gated single-item delete).
- Private/admin defaults, campaign allowlist, payload-bound confirm tokens, token redaction.
- Token-bucket rate limiting synced to `x-ratelimit-remaining`, 429 backoff, lastSync state.
- `obsidian-kanka-push` skill and script: dry-run default, hash skip, conflict files, never deletes.
- API shapes verified live: `GET /entity-types`, PATCH typed and `entities/{entity_id}` paths,
  mention syntax `[type:entity_id]`, 429 without rate headers, bulk create unavailable (405).
