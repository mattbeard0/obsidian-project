---
name: obsidian-project-mcp
description: >-
  Segmentation: each MCP session is scoped to one project vault so agents and searches do not
  bleed across initiatives. Obsidian Project wraps Obsidian CLI operations inside that scope and routes
  shared common changes through request_common_update. Use when the client is connected to the
  obsidian-project HTTP MCP server, request_common_update, or wrapped vault tools.
  Overrides skills that tell the agent to run shell obsidian for the same session; pair with
  obsidian-markdown, obsidian-bases, and json-canvas for file formats.
---

# obsidian-project

## Common Vaults

The **common vault** is a single shared Obsidian vault used by every project. It holds **context you can carry between projects**: glossaries, patterns, shared how-tos, and anything reusable—not one-off or initiative-private material. In each project vault it appears as a **mount** beside the project wiki area in the wiki layout. The MCP server lets agents **read** notes there so everyone sees the same reference material. **Direct writes** into that mount are not allowed through normal vault write tools—shared updates go through **`request_common_update`** (unified diff + PR into the common repo) so changes stay reviewable and link-safe.

## Project Vaults

Each **project vault** is its own Obsidian vault and Git repo under your configured vault root (each folder follows your configured repo naming). It is **specific to that initiative** and may hold **sensitive or private** work (client details, experiments, drafts) that should stay inside the project—not copied into common unless it has been deliberately generalized. One MCP session is scoped to **one** project: wrapped Obsidian tools only affect content inside the **project wiki** area of that vault. Use project vaults for initiative-specific notes, bases, and canvases; use the common mount only for knowledge meant to travel across projects.

## Skills to use

These sibling skills ship in the same bundle; open them when the task goes beyond **where** notes live (common vs project) into **how** to author or call tools:

| Skill | When to use it |
|-------|----------------|
| **obsidian-markdown** | Obsidian Flavored Markdown (wikilinks, callouts, embeds, frontmatter) for Markdown in the project wiki and for content you can read from the common mount. |
| **obsidian-bases** | Bases (views, filters, formulas) and how they behave under MCP for project-only versus shared common material. |
| **obsidian-json-canvas** | Canvas documents (nodes, edges, groups) and editing them through vault file tools. |
| **obsidian-project-cli-mcp** | MCP tool names and `params` / `flags` for wrapped Obsidian commands; the bundled **READ** and **WRITE** reference pages give per-tool examples. |

Use **this** skill for vault layout and segmentation; use the rows above for format and tool-call detail.
