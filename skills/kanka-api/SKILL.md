---
name: kanka-api
description: >
  Use when the user wants to read or change their Kanka (kanka.io) TTRPG campaign: list or look up
  characters, locations, notes and other entities, read posts, attributes, relations and mentions,
  fetch only what changed since the last sync, or create/update entities, posts, attributes and
  relations. Writes are two-phase and private/admin by default. Do not use for: transferring,
  transforming, recovering or changing permissions of entities (not wrapped), campaign settings or
  members, image uploads, or other campaign tools (World Anvil, LegendKeeper, D&D Beyond).
---

# Kanka API (kanka-mcp)

## Setup
- `KANKA_TOKEN`: personal access token (Kanka > Profile > API). It expires 365 days after creation and has
  no scopes: it can do anything the user can. Never print it; `kanka_whoami` shows a sha256 prefix only.
- `KANKA_CAMPAIGN_ALLOWLIST`: comma-separated campaign ids writes may touch. Unset = read-only.
- `KANKA_CAMPAIGN_ID`: optional default campaign for every tool.
- `KANKA_ALLOW_DELETE=1`: enables single-item deletes. Leave unset unless the user asked.

## Ids (verified live)
- `id` / `child_id` is the record in its type table (`characters/{id}`).
- `entity_id` is the shared entity id used by posts, attributes, relations, mentions and `entities/{entity_id}`.
- Mentions in HTML entries are `[<type_code>:<entity_id>]`, e.g. `[location:10066396]`. Using the child id
  renders "Unknown". `kanka_resolve` returns the ready-made mention string.

## Tools
Reads: `kanka_whoami`, `kanka_list_campaigns`, `kanka_list_entity_types`, `kanka_list`, `kanka_get`,
`kanka_get_entity`, `kanka_resolve`, `kanka_recent`, `kanka_list_posts`, `kanka_get_post`,
`kanka_list_attributes`, `kanka_list_relations`, `kanka_list_mentions`.

Writes (two-phase): `kanka_create`, `kanka_update`, `kanka_update_entity`, `kanka_create_post`,
`kanka_update_post`, `kanka_set_attribute`, `kanka_create_relation`, `kanka_delete`.

## Write protocol
1. Call the write tool without `confirm_token`. It returns `status: PREVIEW`, the exact body or a diff
   against the current record, and a `confirm_token` bound to the sha256 of the payload (10 min, single use).
2. Show the preview to the user. Only after they agree, call again with the same arguments plus `confirm_token`.
   Any change to the arguments gives `CONFIRM_MISMATCH`.
- Defaults: entities and attributes `is_private: true`; posts and relations `visibility_id: 3` (admin).
  Only override when the user explicitly wants players to see it; the preview warns.
- `kanka_delete` (one item): preview returns the item's name; the confirm call must pass
  `confirm_name` equal to that exact name.

## Incremental reads
`kanka_list` with `use_saved_sync: true` stores the response `sync` per campaign+type and sends it as
`lastSync` next time, returning only changed rows. Deletions never appear in lastSync results: run a full
`kanka_list` with `all: true` to spot removed entities.

## Rate limits
30 calls/min per user (90 for subscribers), shared by all of a user's tokens. The client uses a token bucket at
90% of `profile.rate_limit`, syncs to `x-ratelimit-remaining`, and on 429 (which carries no Retry-After or
rate headers) backs off 2/4/8/16/32 s. Every result reports `api_calls`. `KANKA_RATE_LIMIT` and
`KANKA_MIN_INTERVAL_MS` can only slow it down.

## Not available
Bulk create (`POST entities` returns 405), transfer, transform, recover, permissions, search, image/asset
upload, campaign settings/members. Mentions (`kanka_list_mentions`) may return nothing right after an edit.
