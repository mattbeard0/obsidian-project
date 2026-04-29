# obsidian-project

`obsidian-project` creates isolated Obsidian project vaults, keeps a shared common vault mounted into each project, and runs a scoped local MCP server for agents.

It creates one Git repository per vault:

- `obsidian-vault-common`
- `obsidian-vault-<project>`

Each project vault gets:

```text
raw/
wiki/
  project/
  common/  -> common vault wiki mount
output/
```

On Windows, `wiki/common` is a directory junction. On macOS, it is a directory symlink.

## Requirements

Install and verify these before installing `obsidian-project`:

```bash
obsidian version
gh --version
```

Obsidian CLI requires Obsidian desktop installer `1.12.7+` and must be enabled in `Settings > General > Command line interface`.

GitHub CLI must be installed because common-note updates use `gh` to create pull requests. Before starting the MCP server, also run:

```bash
gh auth login
gh auth status
```

## Install

Install from npm:

```bash
npm install -g obsidian-project-cli
```

Then run the installed command to open the setup wizard:

```bash
obsidian-project --init
```

On Windows, npm creates an `obsidian-project.cmd` shim. On macOS, npm creates an `obsidian-project` executable on your global npm bin path.

Global npm install is intentionally blocked until `obsidian version` and `gh --version` work.

## Configure

Run `obsidian-project --help` to display all commands. Running `obsidian-project` with no command confirms the tool is installed and points to help.

The setup wizard asks for:

- vault root, using an arrow-key menu:
  - default folder, `C:\Vaults` on Windows or `~/Vaults` on macOS/Linux
  - choose a folder in the native picker
  - set up later
- repository prefix, default `obsidian-vault-`
- common vault setup, using an arrow-key menu:
  - choose an existing common vault folder in the native picker
  - create a managed common vault
  - set up later
- common vault project name, default `common`, when creating a managed vault
- folder structure
- optional GitHub owner/org

You can rerun configuration later with:

```bash
obsidian-project --init
```

Config is stored at:

- Windows: `%APPDATA%\.obsidian-project\config.json`
- macOS: `~/.obsidian-project/config.json`
- Linux: `~/.obsidian-project/config.json`

Older config files from previous versions are read once from the legacy location and migrated to `.obsidian-project`.

## Use

```bash
obsidian-project --new XYZ
obsidian-project --set-common
obsidian-project --create-common
obsidian-project --delete XYZ
obsidian-project --list
obsidian-project --clean-up
obsidian-project --uninstall
obsidian-project --start
obsidian-project --stop
obsidian-project --status
obsidian-project --doctor
```

Use the `--` form above as the canonical command style. Legacy subcommands may still exist for compatibility, but docs and examples only use `--` options.

`--new XYZ` creates:

- `obsidian-vault-XYZ`
- a local Git repo in that project vault
- the common wiki mount at `obsidian-vault-XYZ/wiki/common`
- a Codex MCP server block with `x-obsidian-project = XYZ`
- a Codex profile named `XYZ`

## GitHub Sync

GitHub sync is optional and only runs when enabled.

`obsidian-project --new XYZ`:

- always creates local Git repositories for the project vault and common vault (if missing)
- only creates or connects GitHub remotes when GitHub sync is enabled
- uses the configured `githubOwner` and repository naming (`<repoPrefix><project>`, for example `obsidian-vault-project-1`)

GitHub sync can be enabled:

- by config default from setup (`createRemotes`)
- per command with `--github`
- disabled per command with `--skip-github`

`obsidian-project --delete XYZ`:

- commits local changes before delete when there are changes
- pushes to `origin` before delete when a remote exists and push is not skipped
- skips push with `--skip-push`
- deletes only the local vault folder
- does not delete any GitHub repository

`obsidian-project --clean-up`:

- updates/removes generated Codex MCP profile blocks for local vault state
- does not create, delete, or mutate GitHub repositories

If you chose to add the common vault later during setup, run:

```bash
obsidian-project --set-common
```

With no argument, `--set-common` opens the native folder picker on Windows or macOS so you can select an existing common vault. You can also pass the full path directly:

```bash
obsidian-project --set-common "C:\Vaults\Common"
```

To create the managed common vault under the configured vault root, run:

```bash
obsidian-project --create-common
obsidian-project --create-common shared
```

`--create-common` creates the common vault folders and Git repo only when the target managed common-vault path is empty (or missing), then saves it in config.

`--delete XYZ` asks for confirmation, commits local project changes, pushes if an `origin` remote exists, and deletes only the local project vault. It does not delete the GitHub repository.

`--list` shows the common vault and each project vault, including the configured folder paths and linked common wiki mount.

`--clean-up` removes generated Codex config blocks for project vaults that no longer exist locally, then refreshes existing project profiles into the current profile-scoped MCP format. It only removes blocks marked with `# BEGIN obsidian-project ...` / `# END obsidian-project ...`.

`--uninstall` removes generated Codex config blocks, deletes the obsidian-project app config/state folders, stops the MCP server if it is running, and runs `npm uninstall -g obsidian-project-cli`. It leaves vault folders, common mounts/symlinks, and Git repositories untouched. Use `obsidian-project --uninstall --skip-package` to clean config without removing the npm package.

`--start` launches a detached local MCP server on `127.0.0.1`, starting at port `57891` and scanning upward if needed. It confirms the GitHub CLI account on startup and updates generated Codex MCP URLs when the port changes.

## MCP Scope

Project scope is supplied by the MCP request header:

```text
x-obsidian-project: XYZ
```

Codex config blocks generated by `--new` include that header:

```toml
[profiles.XYZ]
model_instructions_file = "..."

[profiles.XYZ.mcp_servers.obsidian-notes]
url = "http://127.0.0.1:57891/mcp"
required = true
http_headers = { "x-obsidian-project" = "XYZ" }
```

Readable:

- `wiki/project/**`
- `wiki/common/**`

Writable:

- `wiki/project/**`

Common updates must use the `request_common_update` MCP tool. It accepts a common note path, a unified git diff, and reasoning; then it creates or reuses a branch in the common repo, validates the diff, applies it, commits the change, pushes it, and opens or reuses a GitHub PR. PR titles are generated as `[filename] Content Update`.

Common update branches are deterministic per project/session:

- `codex/<project>/<chat-id>` when a session/chat ID is available from MCP request headers or environment
- `codex/<project>` otherwise

This keeps multiple common-update tool calls from one chat on the same branch and PR.

## Obsidian CLI Wrapper

The MCP server registers:

- one generated tool per wrapped Obsidian CLI command, using the command name normalized for MCP, for example `read`, `search_context`, and `plugin_install`
- `request_common_update` for reviewed common-vault changes
- `cli_spec` to show the wrapped Obsidian CLI command spec

Unsafe commands are intentionally blocked, including `eval`, developer protocol commands, plugin/theme install or enable operations, publish operations, sync/history restore, arbitrary command-palette execution, and global vault listing.

## Beta Installs

Normal installs use npm's `latest` tag:

```bash
npm install -g obsidian-project-cli
```

Prereleases are published under the `beta` tag and must be explicitly requested:

```bash
npm install -g obsidian-project-cli@beta
```

## For Contributors

Repository development commands:

```bash
npm install
npm run typecheck
npm test
npm run test:local
npm run build
```

`npm run test:local` is an end-to-end local smoke suite. It packs the package, installs it into a temporary global npm prefix, runs the installed `obsidian-project` command, initializes isolated config, creates a project vault, verifies the Git repos/common mount/Codex profile, deletes the project vault, and cleans up.

The smoke suite sets `OBSIDIAN_PROJECT_SKIP_POSTINSTALL=1` only for its temporary npm install, so package and vault behavior can still be tested on CI or a fresh machine. It also runs a verbose `doctor` probe at the end to show whether the real runtime CLIs are ready.

Release publishing is automated by `.github/workflows/release.yml`:

- Stable GitHub Releases publish to npm with the `latest` dist-tag.
- GitHub prereleases publish to npm with the `beta` dist-tag.
- npm publishing uses Trusted Publishing/OIDC, so no `NPM_TOKEN` repository secret is required.
- The workflow uploads the packed `.tgz` to the GitHub Release.
- The workflow appends generated release notes listing included PRs and contributors.

Before creating a release, make sure the GitHub release tag matches `package.json` version, with an optional leading `v` in the tag. For example, package version `0.2.0` should use tag `v0.2.0` or `0.2.0`. For prereleases, use a semver prerelease version such as `0.2.0-beta.0`.
