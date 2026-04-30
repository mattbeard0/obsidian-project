# obsidian-project-cli

**npm:** [`obsidian-project-cli`](https://www.npmjs.com/package/obsidian-project-cli) · **CLI:** `obsidian-project`

Cross-platform helper for **registering** Obsidian vaults, **linking** a shared common vault’s note library into each project vault (symlink or Windows junction), and running a **scoped local MCP server** that wraps the [Obsidian CLI](https://obsidian.md/cli). Optional **GitHub** integration uses `gh` for reviewed updates to the common vault via pull requests.

Stack: TypeScript (Node **≥ 20**), Commander, Express + `@modelcontextprotocol/sdk`, Zod, Vitest.

## What you get

1. **Common vault** — one shared vault (registered path) whose note library is the source of truth for shared notes.
2. **Project vaults** — separate Obsidian vaults per initiative; each can mount the common note library inside your configured layout.
3. **`vault-config.json`** — you define directory names for attachments, note library, publish area, project-only scope, and shared mount (no built-in folder names).
4. **MCP HTTP server** — listens on `127.0.0.1` at `config.server.preferredPort` (default **57891**), path `/mcp`. Clients send `x-obsidian-project: <project>` to scope tools to one project vault.
5. **Bundled Codex skills** — copying `skills/*` into your Codex skills directory (MCP usage, Markdown, Bases, JSON Canvas).

The tool does **not** create new Obsidian vaults inside the app for you. You create vaults in Obsidian, then **register** paths and **link** the common library when you are ready.

### Layout (conceptual)

Paths are whatever you set in `vault-config.json` (all five keys are required):

```text
<project vault>/
  <attachments>/      # from vault-config
  <noteLibrary>/       # wiki root
    <projectScope>/    # project-only
    <sharedScope>/     # mount → common vault’s <noteLibrary>
  <publish>/
```

On Windows the shared mount is a **directory junction**; on macOS and Linux it is a **symlink**.

## Requirements

- **Node.js** 20 or newer (for the CLI package).
- **Obsidian CLI** — desktop **1.12.7+**, enabled under *Settings → General → Command line interface*. Verify: `obsidian version`. Docs: [Obsidian CLI](https://obsidian.md/cli).
- **GitHub CLI** (`gh`) — needed if you use GitHub remotes or the `request_common_update` MCP tool (PR flow). Verify: `gh --version`. For hosts other than github.com, set preferences at first run (`--github-host`) or in config; authenticate with `gh auth login` / `gh auth status`.

Global `npm install -g` runs a **postinstall** check: missing `obsidian` or `gh` is reported but does not fail the install. Use `obsidian-project doctor` after fixing PATH.

Optional env overrides (see source: `src/functions/platform/paths.ts`, `src/config/config.ts`):

- `OBSIDIAN_PROJECT_CONFIG_DIR` — config and `vault-config.json`.
- `OBSIDIAN_PROJECT_STATE_DIR` — server pid, log, `server.json`.
- `OBSIDIAN_PROJECT_VAULT_PARENT` — default parent for vault folders named `<repoPrefix><project>` when a project is not listed in `projectVaults` (default: `~/Vaults`, or a `Vaults` folder at the root of your home drive on Windows, e.g. `C:\Vaults`).
- `OBSIDIAN_PROJECT_SKIP_EXTERNAL_CLI_CHECKS` — set to `1` or `true` to skip Obsidian/`gh` checks (e.g. CI).
- `OBSIDIAN_PROJECT_SKIP_POSTINSTALL` — skip postinstall prerequisite messages.

## Install

```bash
npm install -g obsidian-project-cli
```

Prereleases:

```bash
npm install -g obsidian-project-cli@beta
```

**PATH:** On Windows, npm adds `obsidian-project.cmd`. On macOS/Linux, ensure the global npm `bin` directory (from `npm prefix -g`, usually `…/bin`) is on your `PATH`.

From a git checkout:

```bash
npm install
npm run build      # emits dist/
npm test
npm run dev        # tsx src/cli/index.ts …
```

## First run (no subcommand)

Running **`obsidian-project`** with **no subcommand** (after any command’s `preAction` bootstrap) checks the Obsidian CLI, completes **first-time wizard** fields once (`cliBootstrap` in `config.json`: MCP port, GitHub hostname, whether to create remotes and which owner), then finishes GitHub preference prompts and optionally installs bundled Codex skills.

**Global options** (apply before the subcommand when combined, e.g. `obsidian-project --skip-github github`):

| Flag | Purpose |
|------|---------|
| `--skip-github` | Disable creating GitHub remotes; save “remotes off” |
| `--owner <name>` | GitHub user or org when remotes are enabled |
| `--port <n>` | MCP preferred port (1024–65535; default 57891) |
| `--github-host <host>` | Host for `gh` / `git` (default `github.com`) |
| `--agent-skill` | Non-interactive: install all bundled Codex skills after setup |

**Non-interactive environments** (no TTY): first-time bootstrap **must** include either `--skip-github` or `--owner`; you may also pass `--port` and `--github-host`. There is **no** `--non-interactive` flag—behavior follows TTY and these options.

After init, the CLI prints next steps: register common and project vaults, then link.

## `vault-config.json`

Stored next to `config.json` (see [Config locations](#config-locations)). Defines **roles** for folder names (you choose the strings):

```json
{
  "version": 1,
  "folderStructure": {
    "attachments": "…",
    "noteLibrary": "…",
    "publish": "…",
    "projectScope": "…",
    "sharedScope": "…"
  }
}
```

If the file is missing or incomplete, commands that need it run an **interactive folder-structure wizard** when stdin/stdout are TTYs (copy from another vault, derive from the common vault, create names, etc.). In CI or pipes, create or edit `vault-config.json` manually first.

## Typical workflow

1. Run **`obsidian-project`** once to create `config.json` and complete bootstrap (and optionally `--agent-skill`). This does **not** require `vault-config.json` yet.
2. **`obsidian-project add-common-vault`** — if `vault-config.json` is still missing, an **interactive** terminal runs the folder-structure wizard first; then pick or pass `--path` to an existing vault that contains `.obsidian`. Optional `--name` for the logical common key. **Without a TTY**, create **`vault-config.json`** manually before this step.
3. **`obsidian-project add-project-vault`** — register each project vault (`--path`, optional `--name` as project key).
4. **`obsidian-project add-common-to-project --project <name>`** — create the mount from the common note library into that project’s `sharedScope` under `noteLibrary`. Optional `--path` to a folder inside the common vault for validation.

**Undo the mount only:** `obsidian-project remove-common-from-project --project <name>` (or `--path` to infer the project).

**GitHub-only prefs** (no vault config required for the persisted slice): `obsidian-project github` — honors `--skip-github` / `--owner` from the global options.

## Commands

| Command | Description |
|---------|-------------|
| *(none)* | Bootstrap: CLIs, `config.json` / `cliBootstrap`, GitHub prefs, optional skills prompt |
| `add-common-vault` | Register existing common vault; then GitHub prefs |
| `add-project-vault` | Register existing project vault; initializes Git in that folder if needed |
| `add-common-to-project` | **Requires** `--project`; links common note library into project shared scope |
| `remove-common-from-project` | Remove the shared-scope mount (`--project` or `--path`) |
| `github` | Show or configure GitHub remote settings |
| `agent-skill` | Install bundled Codex skills (same bundle as `--agent-skill` on bootstrap) |
| `delete <project>` | After typing the project name to confirm: commit, optional push, delete **local** project vault folder only |
| `list` | List common + projects, paths, and folder/link status |
| `clean-up` | Alias `cleanup` — remove stale generated Codex blocks; refresh MCP URLs for remaining profiles |
| `uninstall` | Type `uninstall` to confirm — strip Codex blocks, remove app config/state, stop server, `npm uninstall -g obsidian-project-cli` |
| `start` | Start detached MCP server; `--repair-mounts` to fix mounts without prompts |
| `stop` | Stop server using saved state |
| `status` | Show URL, pid, start time if running |
| `doctor` | Check `obsidian` / `gh`, print config paths, resolve `obsidian-project` on PATH |

`delete` options: `--skip-push` — commit but do not push before removing the local folder. **GitHub repos are never deleted** by this tool.

## Config locations

| File / dir | macOS / Linux | Windows |
|------------|---------------|---------|
| `config.json`, `vault-config.json`, `skills/` copies | `~/.obsidian-project/` | `%APPDATA%\.obsidian-project\` |
| Server state, log | `~/.obsidian-project/state/` | `%LOCALAPPDATA%\.obsidian-project\` |

Override with `OBSIDIAN_PROJECT_CONFIG_DIR` / `OBSIDIAN_PROJECT_STATE_DIR` if needed.

`config.json` holds `repoPrefix` (default `obsidian-vault-`), `commonProjectName` (default `common`), `projectVaults` map, GitHub and server settings, optional Codex paths. **`vault-config.json` is the only place for `folderStructure`.**

## GitHub behavior

- **Remotes** are optional. Enable via first-run / `github` / `--owner`; disable with `--skip-github` on bootstrap or through `github`.
- **`add-common-vault`** and **`add-project-vault`** run the same GitHub preference flow after registration (respecting global `--skip-github` / `--owner`).
- **`delete <project>`** commits local changes, pushes to `origin` when present (unless `--skip-push`), deletes **only** the local vault directory.
- **`clean-up`** removes generated Codex profile blocks for projects that no longer exist locally (markers `# BEGIN obsidian-project …` / `# END obsidian-project …`), then refreshes MCP URLs for remaining blocks.
- **`uninstall`** does not remove vault folders, mounts, or Git data.

## MCP server

- **URL:** `http://127.0.0.1:<port>/mcp` (port from running server or `config.server.preferredPort`).
- **Scope header:** `x-obsidian-project: <project>` — must name a **project** vault whose directory exists (registered path or default `<vaultParent>/<repoPrefix><project>`).
- **Tools:** one MCP tool per allowed Obsidian CLI command (names use `_` instead of `:`), plus **`request_common_update`** for reviewed common-vault edits (unified diff → branch → PR via `gh`), and **`cli_spec`** for the wrapped CLI surface.
- **Blocked:** unsafe or global operations (e.g. eval, arbitrary command palette, plugin/theme install, publish, destructive sync, vault listing outside scope)—see `src/mcp/obsidianCommandRuntime.ts` and related policy.

**Readable (typical):** paths under project `noteLibrary` / `projectScope` and the mounted shared common area. **Writable:** project scope; common writes go through **`request_common_update`**.

**Common-update branches** (deterministic): `codex/<project>/<chat-id>` when a session id is available from headers/env, else `codex/<project>`.

## Codex `config.toml` snippets

The CLI can maintain marked **`[profiles.<name>]`** blocks pointing at the local MCP URL and `x-obsidian-project`. Regeneration / port refresh (`start`, `clean-up`) scans the default vault parent directory for folders whose names start with your configured `repoPrefix`, and for each inferred project updates the block if **`<that-vault>/.obsidian-project/codex-instructions.md`** exists. Add that file yourself if you want automatic profile sync for a vault living under that parent.

Profile name defaults to `profileNamePrefix` + project; MCP server key defaults to `obsidian-notes`. Both are configurable in `config.json` under `codex`.

## Bundled Codex skills

`obsidian-project agent-skill` (or bootstrap with `--agent-skill`) copies every folder under the package **`skills/`** that contains a `SKILL.md` into:

- a canonical copy under **`~/.obsidian-project/skills/`** (or your config dir), and  
- **`$CODEX_HOME/skills`** if set, else **`~/.codex/skills`**.

Current bundle includes **obsidian-project-mcp**, **obsidian-markdown**, **obsidian-bases**, and **json-canvas** (see each `SKILL.md`).

## License

MIT. Repository: [github.com/mattbeard0/obsidian-project](https://github.com/mattbeard0/obsidian-project).
