# obsidian-project-cli

**npm:** [`obsidian-project-cli`](https://www.npmjs.com/package/obsidian-project-cli) · **CLI:** `obsidian-project`

Cross-platform helper for **registering** Obsidian vaults, **linking** a shared common vault into each project vault at **`common`** in the vault root (symlink or Windows junction), and running a **scoped local MCP server** that wraps the [Obsidian CLI](https://obsidian.md/cli). Optional **GitHub** integration uses `gh` for reviewed updates to the common vault via pull requests.

Stack: TypeScript (Node **≥ 20**), Commander, Express + `@modelcontextprotocol/sdk`, Zod, Vitest.

## What you get

1. **Common vault** — one shared vault (registered path) you pick in Finder / Explorer or via `--path`; it must contain a `.obsidian` folder.
2. **Project vaults** — separate Obsidian vaults per initiative; each can mount the **entire** common vault at `<project vault>/common`.
3. **`config.json`** — stores `repoPrefix`, `commonProjectName`, `commonVaultPath`, `projectVaults`, GitHub and server settings, optional Codex paths, and bootstrap metadata.
4. **MCP HTTP server** — listens on `127.0.0.1` at `config.server.preferredPort` (default **57891**), path `/mcp`. Clients send `x-obsidian-project: <project>` to scope tools to one project vault.
5. **Bundled Codex skills** — copying `skills/*` into your Codex skills directory (MCP usage, Markdown, Bases, JSON Canvas).

The tool does **not** create new Obsidian vaults inside the app for you. You create vaults in Obsidian, then **register** paths and **link** the common vault when you are ready.

### Layout (fixed mount path)

The only path this tool creates inside a project vault is the **`common`** entry at the vault root:

```text
<project vault>/
  common/          # symlink or junction → entire registered common vault
```

On Windows the shared mount is a **directory junction**; on macOS and Linux it is a **symlink**. Everything else in each vault is yours; the CLI does not configure or validate attachments, publish folders, or note-library layout.

## Requirements

- **Node.js** 20 or newer (for the CLI package).
- **Obsidian CLI** — desktop **1.12.7+**, enabled under *Settings → General → Command line interface*. Verify: `obsidian version`. Docs: [Obsidian CLI](https://obsidian.md/cli).
- **GitHub CLI** (`gh`) — needed if you use GitHub remotes or the `request_common_update` MCP tool (PR flow). Verify: `gh --version`. For hosts other than github.com, set preferences at first run (`--github-host`) or in config; authenticate with `gh auth login` / `gh auth status`.

Global `npm install -g` runs a **postinstall** check: missing `obsidian` or `gh` is reported but does not fail the install. Use `obsidian-project doctor` after fixing PATH.

Optional env overrides (see source: `src/functions/platform/paths.ts`, `src/config/config.ts`):

- `OBSIDIAN_PROJECT_CONFIG_DIR` — `config.json` and bundled skill copies under that directory.
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

After init, the CLI prints next steps: register common and project vaults, then link with `add-common-to-project`.

## Typical workflow

1. Run **`obsidian-project`** once to create `config.json` and complete bootstrap (and optionally `--agent-skill`).
2. **`obsidian-project add-common-vault`** — opens a folder picker (macOS/Windows) or use `--path` to an existing vault that contains `.obsidian`. Optional `--name` for the logical common key.
3. **`obsidian-project add-project-vault`** — same for each project vault (`--path`, optional `--name` as project key).
4. **`obsidian-project add-common-to-project`** — interactive: pick a registered project, then confirm the common vault (folder picker on macOS/Windows, path prompt on Linux). For scripts, pass **`--project <name>`** and **`--common-path <path>`** together (path must match the registered common vault).

**Undo the mount only:** `obsidian-project remove-common-from-project` — interactive project menu when run in a terminal with no flags, or use `--project` / `--path` to a registered vault folder.

**GitHub-only prefs:** `obsidian-project github` — honors `--skip-github` / `--owner` from the global options.

## Commands

| Command | Description |
|---------|-------------|
| *(none)* | Bootstrap: CLIs, `config.json` / `cliBootstrap`, GitHub prefs, optional skills prompt |
| `add-common-vault` | Register existing common vault; initializes Git if needed; then GitHub prefs |
| `add-project-vault` | Register existing project vault; initializes Git in that folder if needed |
| `add-common-to-project` | Link common vault into `<project>/common` (interactive pickers, or `--project` + `--common-path`) |
| `remove-common-from-project` | Remove the vault-root `common` mount (`--project`, `--path`, or interactive menu) |
| `github` | Show or configure GitHub remote settings |
| `agent-skill` | Install bundled Codex skills (same bundle as `--agent-skill` on bootstrap) |
| `delete <project>` | After typing the project name to confirm: commit, optional push, delete **local** project vault folder only |
| `list` | List common + projects, paths, and folder/link status |
| `clean-up` | Alias `cleanup` — remove stale generated Codex profile blocks for deleted projects |
| `uninstall` | Type `uninstall` to confirm — strip Codex blocks, remove app config/state, stop server, `npm uninstall -g obsidian-project-cli` |
| `start` | Start detached MCP server; `--repair-mounts` to fix mounts without prompts |
| `stop` | Stop server using saved state |
| `status` | Show URL, pid, start time if running |
| `doctor` | Check `obsidian` / `gh`, print config paths, resolve `obsidian-project` on PATH |

`delete` options: `--skip-push` — commit but do not push before removing the local folder. **GitHub repos are never deleted** by this tool.

## Config locations

| File / dir | macOS / Linux | Windows |
|------------|---------------|---------|
| `config.json`, `skills/` copies | `~/.obsidian-project/` | `%APPDATA%\.obsidian-project\` |
| Server state, log | `~/.obsidian-project/state/` | `%LOCALAPPDATA%\.obsidian-project\` |

Override with `OBSIDIAN_PROJECT_CONFIG_DIR` / `OBSIDIAN_PROJECT_STATE_DIR` if needed.

`config.json` holds `repoPrefix` (default `obsidian-vault-`), `commonProjectName` (default `common`), optional `commonVaultPath`, `projectVaults` map, GitHub and server settings, and optional Codex paths.

## GitHub behavior

- **Remotes** are optional. Enable via first-run / `github` / `--owner`; disable with `--skip-github` on bootstrap or through `github`.
- **`add-common-vault`** and **`add-project-vault`** run the same GitHub preference flow after registration (respecting global `--skip-github` / `--owner`). When **`github.owner`** and **`github.hostname`** are both set, the CLI runs **`gh repo create`** (private repo named `owner/<repoPrefix><logical-name>`) from the vault folder, adds **`origin`** when needed, and **pushes** current commits. If the repo already exists on GitHub, it links **`origin`** and pushes instead.
- **`delete <project>`** commits local changes, pushes to `origin` when present (unless `--skip-push`), deletes **only** the local vault directory.
- **`clean-up`** removes generated Codex profile blocks for projects that no longer exist locally (markers `# BEGIN obsidian-project …` / `# END obsidian-project …`).
- **`uninstall`** does not remove vault folders, mounts, or Git data.

## MCP server

- **URL:** `http://127.0.0.1:<port>/mcp` (port from running server or `config.server.preferredPort`).
- **Scope header:** `x-obsidian-project: <project>` — must name a **project** vault whose directory exists (registered path or default `<vaultParent>/<repoPrefix><project>`).
- **Tools:** one MCP tool per allowed Obsidian CLI command (names use `_` instead of `:`), plus **`request_common_update`** for reviewed common-vault edits (unified diff → branch → PR via `gh`), and **`cli_spec`** for the wrapped CLI surface.
- **Blocked:** unsafe or global operations (e.g. eval, arbitrary command palette, plugin/theme install, publish, destructive sync, vault listing outside scope)—see `src/mcp/obsidianCommandRuntime.ts` and related policy.

**Readable:** any vault-relative path in the project vault except where blocked by the Obsidian command allowlist. Paths under **`common/`** (the mount at the vault root) are treated as the common vault (read-only through normal write tools). **Writable:** anywhere in the project vault outside that mount; common edits go through **`request_common_update`**.

**Common-update branches** (deterministic): `codex/<project>/<chat-id>` when a session id is available from headers/env, else `codex/<project>`.

## Codex `config.toml` snippets

The package library can still **parse and strip** marked `# BEGIN obsidian-project` / `# END obsidian-project` blocks (for example `clean-up` and `uninstall`). It does **not** auto-generate or refresh profile entries from vault files; add MCP profile snippets to Codex yourself if you use Codex with this server.

## Bundled Codex skills

`obsidian-project agent-skill` (or bootstrap with `--agent-skill`) copies every folder under the package **`skills/`** that contains a `SKILL.md` into:

- a canonical copy under **`~/.obsidian-project/skills/`** (or your config dir), and  
- **`$CODEX_HOME/skills`** if set, else **`~/.codex/skills`**.

Current bundle includes **obsidian-project-mcp**, **obsidian-markdown**, **obsidian-bases**, and **json-canvas** (see each `SKILL.md`).

## License

MIT. Repository: [github.com/mattbeard0/obsidian-project](https://github.com/mattbeard0/obsidian-project).
