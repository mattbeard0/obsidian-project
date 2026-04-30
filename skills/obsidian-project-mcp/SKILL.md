---
name: obsidian-cli
description: >-
  Use vault operations through obsidian-project MCP: wrapped Obsidian CLI capabilities as MCP tools
  (params + flags), scoped to the active project vault. Use when reading or changing notes,
  bases, search, properties, links, tasks, or other allowed vault features.
---

# Vault tools (obsidian-project MCP)

Each **MCP tool** wraps one Obsidian CLI subcommand. The server injects `vault=` and path policy—you pass **vault-relative** paths only.

**Per-tool examples** (read vs write risk, matching the CLI surface exposed through MCP):

- [references/READ.md](references/READ.md) — all **read** tools with sample `params`
- [references/WRITE.md](references/WRITE.md) — all **write** tools that accept explicit paths with sample `params`

## How to call a tool

**Tool id:** Obsidian subcommand with `:` → `_` (e.g. `read`, `property_set`, `search_context`, `daily_read`).

**Arguments:**

```json
{
  "params": { "path": "wiki/project/Note.md", "content": "Line\n" },
  "flags": ["silent", "overwrite"]
}
```

- **`params`:** map to Obsidian CLI `key=value` arguments. See [Obsidian CLI](https://help.obsidian.md/cli) for names not listed in the reference tables.
- **`flags`:** optional array of boolean flag names (no values).

Use `\n` and `\t` inside strings for newlines and tabs.

**Writes:** include **`path`** (or **`path` + `to`** for `move`, or **`file` + `folder`** for `bookmark`) in `params` so changes stay inside the project vault.

## Quick map (tool → area)

| Area | Tool ids |
|------|----------|
| Meta | `help`, `version`, `vault` |
| Bases | `bases`, `base_views`, `base_query`, `base_create` |
| Files & notes | `files`, `folders`, `folder`, `file`, `open`, `read`, `create`, `append`, `prepend`, `move`, `rename`, `delete`, `diff`, `outline`, `wordcount` |
| Search | `search`, `search_context`, `search_open` |
| Daily (read) | `daily_path`, `daily_read` |
| Bookmarks | `bookmarks`, `bookmark` |
| Properties | `properties`, `property_read`, `property_set`, `property_remove`, `aliases` |
| Links & graph | `backlinks`, `links`, `unresolved`, `orphans`, `deadends` |
| Tasks & tags | `tasks`, `task`, `tags`, `tag` |
| History (read) | `history`, `history_list`, `history_read` |
| Sync (read) | `sync_status`, `sync_history`, `sync_read`, `sync_deleted` |
| Plugins / themes / snippets (read) | `plugins`, `plugins_enabled`, `plugin`, `themes`, `theme`, `snippets`, `snippets_enabled` |
| Templates (read) | `templates`, `template_read` |
| Workspace & UI (read) | `workspace`, `workspaces`, `tabs`, `commands`, `hotkeys`, `hotkey` |
| Random (read) | `random`, `random_read` |

## References

- [READ.md](references/READ.md) / [WRITE.md](references/WRITE.md) — copy-paste `params` patterns
- [Obsidian CLI](https://help.obsidian.md/cli)
- [obsidian-project](https://github.com/mattbeard0/obsidian-project)
