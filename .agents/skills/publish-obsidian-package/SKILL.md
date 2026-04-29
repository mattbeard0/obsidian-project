---
name: publish-obsidian-package
description: End-to-end release workflow for this obsidian-project-cli npm package. Use when asked to publish, release, tag, verify, or run the full npm/GitHub release process for obsidian-project-cli, including cleanup, version bump, GitHub Release, action monitoring, and npm install verification.
---

# Publish Obsidian Package

Use this skill to publish `obsidian-project-cli` from the `obsidian-project` repository.

## Preconditions

- Work from the repository root.
- Confirm the branch is `main`.
- Confirm the working tree state before destructive or release steps.
- Use npm Trusted Publishing through the GitHub Release workflow. Do not add or require `NPM_TOKEN`.
- Release tags must match `package.json` version, with optional leading `v`.

## Standard Release Workflow

1. Inspect local state:

```powershell
git status --short
git branch --show-current
node -p "require('./package.json').version"
```

2. If requested, delete the local default vault root. Verify the resolved path before deleting:

```powershell
$target = Resolve-Path -LiteralPath 'C:\Vaults' -ErrorAction Stop
if ($target.Path -ne 'C:\Vaults') { throw "Unexpected delete target: $($target.Path)" }
Remove-Item -LiteralPath $target.Path -Recurse -Force
```

3. If requested, uninstall the currently installed global package:

```powershell
npm.cmd uninstall -g obsidian-project-cli
```

4. Bump only the patch version unless the user asks otherwise:

```powershell
npm.cmd version 0.1.2 --no-git-tag-version
```

Use the next patch version, not necessarily `0.1.2`.

5. Run local verification:

```powershell
npm.cmd run typecheck
npm.cmd run build
npm.cmd test
npm.cmd run local:test
npm.cmd pack --dry-run
```

On Windows, `npm.cmd test`, `npm.cmd run local:test`, and `npm.cmd pack --dry-run` may require escalated execution because they spawn helper processes or access npm/network state.

6. Commit the release:

```powershell
git add README.md package-lock.json package.json scripts src .github
git commit -m "Release <version>"
```

Adjust the `git add` paths to the actual changed files. Do not stage unrelated user changes.

7. Push `main`:

```powershell
git push origin main
```

8. Create and push the release tag:

```powershell
git tag v<version>
git push origin v<version>
```

9. Create the GitHub Release, which triggers the publish workflow:

```powershell
gh release create v<version> --title "v<version>" --notes "Release <version>"
```

10. Watch the GitHub Actions release workflow:

```powershell
gh run list --workflow Release --limit 5
gh run watch <run-id> --exit-status
```

If the workflow fails, inspect logs with:

```powershell
gh run view <run-id> --log-failed
```

11. Confirm npm has the new version:

```powershell
npm.cmd view obsidian-project-cli version
```

12. Install the package from npm and verify the CLI:

```powershell
npm.cmd install -g obsidian-project-cli
obsidian-project --version
obsidian-project
```

Expected:

- `obsidian-project --version` prints the released version.
- `obsidian-project` prints that it is installed/configured and points to `obsidian-project --help`, or prints installed status if not configured.

13. Final checks:

```powershell
git status --short
git tag --points-at HEAD
```

Report:

- deleted local vault path, if any
- package uninstall result
- release commit hash
- pushed branch and tag
- GitHub Release URL
- workflow result
- npm published version
- installed CLI verification
- final git status

## Failure Notes

- npm Trusted Publishing provenance requires `package.json.repository.url` to match the GitHub repository. For this repo it should be:

```json
"repository": {
  "type": "git",
  "url": "git+https://github.com/mattbeard0/obsidian-project.git"
}
```

- The GitHub workflow needs:

```yaml
permissions:
  contents: write
  id-token: write
```

- Do not manually run `npm publish` locally for normal releases. The GitHub Release workflow publishes to npm.
