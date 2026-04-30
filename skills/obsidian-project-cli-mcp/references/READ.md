# Read tools — MCP `params` examples

Risk level **read** in the Obsidian CLI map. MCP tool id = CLI command with `:` → `_`. Call shape: `{ "params": { ... }, "flags": [] }` (flags optional).

| MCP tool | Example `params` |
|----------|------------------|
| `help` | `{}` |
| `version` | `{}` |
| `vault` | `{}` |
| `bases` | `{}` |
| `base_views` | `{ "path": "wiki/project/Index.base" }` |
| `base_query` | `{ "path": "wiki/project/Index.base" }` |
| `bookmarks` | `{}` |
| `commands` | `{}` |
| `hotkeys` | `{}` |
| `hotkey` | `{ "id": "app:open-settings" }` *(use the id your vault needs)* |
| `daily_path` | `{}` |
| `daily_read` | `{}` |
| `diff` | `{ "path": "wiki/project/Note.md" }` |
| `history` | `{ "path": "wiki/project/Note.md" }` |
| `history_list` | `{}` |
| `history_read` | `{ "path": "wiki/project/Note.md", "time": "2024-01-01 12:00:00" }` *(time per CLI)* |
| `file` | `{ "path": "wiki/project/Note.md" }` |
| `files` | `{ "folder": "wiki/project" }` *(omit `folder` to use server default wiki root)* |
| `folder` | `{ "path": "wiki/project" }` |
| `folders` | `{ "folder": "wiki/project" }` |
| `open` | `{ "path": "wiki/project/Note.md" }` |
| `read` | `{ "path": "wiki/project/Note.md" }` |
| `backlinks` | `{ "path": "wiki/project/Note.md" }` |
| `links` | `{ "path": "wiki/project/Note.md" }` |
| `unresolved` | `{}` |
| `orphans` | `{}` |
| `deadends` | `{}` |
| `outline` | `{ "path": "wiki/project/Note.md" }` |
| `plugins` | `{}` |
| `plugins_enabled` | `{}` |
| `plugin` | `{ "id": "calendar" }` |
| `aliases` | `{ "path": "wiki/project/Note.md" }` |
| `properties` | `{ "path": "wiki/project/Note.md" }` |
| `property_read` | `{ "path": "wiki/project/Note.md", "name": "status" }` |
| `random` | `{ "folder": "wiki/project" }` |
| `random_read` | `{ "folder": "wiki/project" }` |
| `search` | `{ "path": "wiki/project", "query": "deadline" }` *(omit `path` to search allowed folders per server)* |
| `search_context` | `{ "path": "wiki/project", "query": "deadline" }` |
| `search_open` | `{}` |
| `sync_status` | `{}` |
| `sync_history` | `{ "path": "wiki/project/Note.md" }` |
| `sync_read` | `{ "path": "wiki/project/Note.md", "time": "…" }` |
| `sync_deleted` | `{}` |
| `tags` | `{ "path": "wiki/project/Note.md" }` |
| `tag` | `{ "name": "project/active" }` *(shape per [Obsidian CLI](https://help.obsidian.md/cli))* |
| `tasks` | `{ "path": "wiki/project/Note.md" }` |
| `templates` | `{}` |
| `template_read` | `{ "name": "Meeting" }` *(or keys your CLI expects)* |
| `themes` | `{}` |
| `theme` | `{}` |
| `snippets` | `{}` |
| `snippets_enabled` | `{}` |
| `workspace` | `{}` |
| `workspaces` | `{}` |
| `tabs` | `{}` |
| `wordcount` | `{ "path": "wiki/project/Note.md" }` |

## Full call examples (read)

```json
{
  "params": { "path": "wiki/project/Readme.md" }
}
```

Tool: `read`.

Search without scoping to one folder (server runs allowed folders):

```json
{
  "params": { "query": "TODO" }
}
```

Tool: `search`.

List files under wiki (explicit folder):

```json
{
  "params": { "folder": "wiki/project" }
}
```

Tool: `files`.

## See also

- [WRITE.md](WRITE.md) — write-risk tools
- [Obsidian CLI](https://help.obsidian.md/cli) — authoritative parameter names beyond these samples
