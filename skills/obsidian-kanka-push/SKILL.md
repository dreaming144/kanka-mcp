---
name: obsidian-kanka-push
description: >
  Use after a TTRPG session when the user wants to publish Obsidian notes to Kanka: a one-way push of
  notes tagged #kanka-publish (or frontmatter `kanka: publish`) into an allowlisted Kanka campaign,
  dry-run first. Obsidian stays the source of truth. Do not use for: pulling Kanka into Obsidian,
  two-way sync, deleting Kanka entities, or publishing GM-only notes.
---

# Obsidian to Kanka push

Script: `skills/obsidian-kanka-push/push.mjs` (zero dependencies, uses the plugin's Kanka client and the
same env: `KANKA_TOKEN`, `KANKA_CAMPAIGN_ALLOWLIST`).

```
node skills/obsidian-kanka-push/push.mjs --vault <vault dir> --campaign <id>            # dry-run report
node skills/obsidian-kanka-push/push.mjs --vault <vault dir> --campaign <id> --apply    # write
```

## Steps
1. Run the dry-run. Show the user the report: notes to create, notes to update, unresolved links, conflicts.
2. Only after they agree, run with `--apply`. It prints the same JSON report with the ids written.

## What gets pushed
- Only notes tagged `kanka-publish` (frontmatter `tags`, inline `#kanka-publish`, or `kanka: publish`).
- Frontmatter: `kanka_type` (default `note`; e.g. character, location), optional `kanka_name`
  (default: title or file name). The script writes back `kanka_id`, `kanka_entity_id`, `kanka_hash`,
  `kanka_updated_at`, `kanka_synced_at`.
- Stripped before pushing: `> [!secret]` and `> [!gm]` callouts, `%% comments %%`, the publish tag.
- Markdown to HTML: headings, paragraphs, bold/italic, inline code, links, bullet and numbered lists,
  simple pipe tables, blockquotes. Anything else stays as text.
- `[[Note]]` / `[[Note|alias]]` become `[type:entity_id]` mentions when the target note is published and
  has an id (including notes created in the same run). Kanka shows the target's name, not the alias.
  Unresolved links stay as plain text and are listed in the report.

## Safety
- New entities are created with `is_private: true`.
- Hash skip: unchanged notes make zero API calls, so a second run is a no-op.
- Conflicts: if Kanka's `updated_at` differs from the stored `kanka_updated_at`, nothing is pushed for that
  note; `<Note>.conflict.md` is written next to it with the remote HTML. Resolve, then set
  `kanka_updated_at` to the remote value to accept it as the new baseline.
- Never deletes. Notes removed or untagged in Obsidian are only reported (`untagged_but_synced`);
  a remote 404 is reported as `missing_remote` and not recreated.
- Only `name` and `entry` are updated on existing entities.
