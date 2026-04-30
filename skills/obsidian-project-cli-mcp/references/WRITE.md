# Write tools — MCP `params` examples

Risk level **write** in the Obsidian CLI map, limited to tools that accept an explicit **project path** (or `file`+`folder` for bookmarks) so the MCP server can enforce vault scope. MCP tool id = CLI command with `:` → `_`.

| MCP tool | Example `params` |
|----------|------------------|
| `base_create` | `{ "path": "wiki/project/Index.base", "name": "New row", "content": "{}" }` *(fields per CLI)* |
| `bookmark` | `{ "file": "Meeting Notes", "folder": "wiki/project" }` |
| `create` | `{ "path": "wiki/project/New.md", "content": "# Title\n" }` |
| `append` | `{ "path": "wiki/project/Log.md", "content": "- line\n" }` |
| `prepend` | `{ "path": "wiki/project/Log.md", "content": "# Priority\n" }` |
| `move` | `{ "path": "wiki/project/Old.md", "to": "wiki/project/Renamed.md" }` |
| `rename` | `{ "path": "wiki/project/Note.md", "name": "New Title.md" }` |
| `delete` | `{ "path": "wiki/project/Trash.md" }` |
| `property_set` | `{ "path": "wiki/project/Note.md", "name": "status", "value": "done" }` |
| `property_remove` | `{ "path": "wiki/project/Note.md", "name": "draft" }` |
| `task` | `{ "path": "wiki/project/Note.md", "line": 12, "text": "- [x] Done" }` *(keys per CLI)* |

## Full call examples (write)

Create or replace a note:

```json
{
  "params": {
    "path": "wiki/project/Draft.md",
    "content": "# Draft\n\nBody.\n"
  },
  "flags": ["silent", "overwrite"]
}
```

Tool: `create`.

Append to daily-style log under project wiki:

```json
{
  "params": {
    "path": "wiki/project/Changelog.md",
    "content": "## 2026-04-30\n- shipped feature\n"
  }
}
```

Tool: `append`.

## See also

- [READ.md](READ.md) — read-risk tools
- [Obsidian CLI](https://help.obsidian.md/cli) — authoritative parameter names beyond these samples
