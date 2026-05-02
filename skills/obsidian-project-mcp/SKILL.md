---
name: obsidian-cli
description: >-
  Use vault operations through obsidian-project MCP: wrapped Obsidian CLI capabilities as MCP tools
  (params + flags), scoped to the active project vault. Use when reading or changing notes,
  bases, search, properties, links, tasks, or other allowed vault features. Also understand the two types of vaults, 'common' and 'project'.
---

# obsidian-project

## Common Vaults

The **common vault** is a single shared Obsidian vault used by every project. It holds **context you can carry between projects**: glossaries, patterns, shared how-tos, and anything reusable—not one-off or initiative-private material. In each project vault it appears as a **`common`** mount at the **vault root** (symlink or junction). The MCP server lets agents **read** notes there so everyone sees the same reference material. **Direct writes** into that mount are not allowed through normal vault write tools—shared updates go through **`request_common_update`** (unified diff + PR into the common repo) so changes stay reviewable and link-safe.

## Project Vaults

Each **project vault** is its own Obsidian vault and Git repo under your configured vault root (each folder follows your configured repo naming). It is **specific to that initiative** and may hold **sensitive or private** work (client details, experiments, drafts) that should stay inside the project—not copied into common unless it has been deliberately generalized. One MCP session is scoped to **one** project: wrapped Obsidian tools only affect content inside the **project wiki** area of that vault. Use project vaults for initiative-specific notes, bases, and canvases; use the common mount only for knowledge meant to travel across projects.

## Skills to use

These sibling skills ship in the same bundle; open them when the task goes beyond **where** notes live (common vs project) into **how** to author or call tools:

| Skill | When to use it |
|-------|----------------|
| **obsidian-markdown** | Obsidian Flavored Markdown (wikilinks, callouts, embeds, frontmatter) for Markdown in the project wiki and for content you can read from the common mount. |
| **obsidian-bases** | Bases (views, filters, formulas) and how they behave under MCP for project-only versus shared common material. |
| **json-canvas** | Canvas documents (nodes, edges, groups) and editing them through vault file tools. |
| **obsidian-project-mcp** | MCP tool names and `params` / `flags` for wrapped Obsidian commands; the bundled **READ** and **WRITE** reference pages give per-tool examples. |

Use **this** skill for vault layout and segmentation; use the rows above for format and tool-call detail.

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
