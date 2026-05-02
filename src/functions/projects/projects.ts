import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { codexConfigPath } from '../codex/config.js';
import {
  codexSkillsRootDefault,
  formatCodexSkillLines,
  installCodexSkill
} from '../skills/index.js';
import {
  AppConfig,
  appConfigSchema,
  configExists,
  defaultPersistedBootstrap,
  defaultVaultParentDirectory,
  loadConfig,
  persistedAppConfigSchema,
  persistedNeedsCliBootstrap,
  projectNameFromVaultPath,
  readPersistedConfig,
  sanitizeProjectName,
  saveConfig,
  type PersistedAppConfig,
  writePersistedConfig
} from '../../config/config.js';
import { stopServer } from '../../mcp/mcp.js';
import { assertGhReady, assertObsidianCliReady } from '../dependency/dependencyCheck.js';
import { assertGithubOwnerCanCreateRepos, promptGithubOwnerFromMenu } from '../dependency/githubOwnerAccess.js';
import { UserError, errorMessage } from '../errors.js';
import {
  commitIfNeeded,
  ensureGithubRemoteRepoAndPush,
  isGitRepo,
  pushIfRemote,
  runVaultGitRegistrationInteractive,
  shouldProvisionGithubRepo
} from '../git/index.js';
import { chooseFolder, runRequired } from '../platform/shell.js';
import { configDir, displayPath, stateDir } from '../platform/paths.js';
import { createCommonMount } from '../symlinks/index.js';
import {
  assertObsidianVaultFolder,
  resolveCommonVaultPaths,
  resolveProjectVaultPaths
} from '../vaults/vaults.js';

const CODEX_PROFILE_BEGIN_PREFIX = '# BEGIN obsidian-project ';
const CODEX_PROFILE_END_PREFIX = '# END obsidian-project ';

function shouldSkipExternalCliChecks(): boolean {
  return (
    process.env.OBSIDIAN_PROJECT_SKIP_EXTERNAL_CLI_CHECKS === '1' ||
    process.env.OBSIDIAN_PROJECT_SKIP_EXTERNAL_CLI_CHECKS === 'true'
  );
}

/** When remotes are enabled, verify `gh` can access the namespace and SSH works to `git@<host>`. */
async function assertGithubOwnerIfRemotes(
  owner: string | undefined,
  createRemotes: boolean,
  githubHostname: string
): Promise<void> {
  if (!createRemotes || !owner?.trim() || shouldSkipExternalCliChecks()) {
    return;
  }
  await assertGithubOwnerCanCreateRepos(owner.trim(), githubHostname);
}

/** Escape regex metacharacters when stripping Codex blocks from config files. */
function escapeCodexProfileRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Collapse multiple blank lines after removing blocks from TOML. */
function collapseCodexProfileBlankLines(value: string): string {
  return value.replace(/\n{3,}/g, '\n\n');
}

/** Remove every obsidian-project profile block from Codex config. */
async function removeAllCodexProjectProfiles(configPath?: string): Promise<{ configPath: string; removedProjects: string[] }> {
  const file = configPath ?? codexConfigPath();
  let current = '';
  try {
    current = await fs.readFile(file, 'utf8');
  } catch {
    return {
      configPath: file,
      removedProjects: []
    };
  }

  const removedProjects: string[] = [];
  const pattern = new RegExp(
    `${escapeCodexProfileRegExp(CODEX_PROFILE_BEGIN_PREFIX)}([^\\r\\n]+)\\r?\\n[\\s\\S]*?${escapeCodexProfileRegExp(CODEX_PROFILE_END_PREFIX)}\\1\\r?\\n?`,
    'g'
  );
  const next = current.replace(pattern, (_block, project: string) => {
    removedProjects.push(project);
    return '';
  });

  if (next !== current) {
    await fs.writeFile(file, collapseCodexProfileBlankLines(next), 'utf8');
  }

  return {
    configPath: file,
    removedProjects
  };
}

/** Delete symlink to common notes or an empty directory at the mount path. */
async function removeCommonMountPath(mountPath: string): Promise<void> {
  const stat = await fs.lstat(mountPath).catch(() => undefined);
  if (!stat) {
    return;
  }
  if (stat.isSymbolicLink()) {
    await fs.unlink(mountPath);
    return;
  }
  if (stat.isDirectory()) {
    const entries = await fs.readdir(mountPath);
    if (entries.length > 0) {
      throw new UserError(`Mount path is a non-empty directory; remove its contents first: ${mountPath}`);
    }
    await fs.rmdir(mountPath);
    return;
  }
  throw new UserError(`Mount path exists and is not a symlink or directory: ${mountPath}`);
}

// --- GitHub remote preferences (used by CLI `github` and bootstrap) ---

/** True when GitHub section says remotes should be created and an owner is set. */
function isGithubRemoteFromSection(github: AppConfig['github']): boolean {
  return github.createRemotes === true && Boolean(github.owner?.trim());
}

/** True if config is set to create remotes and an owner/org is configured. */
export function isGithubRemoteSyncConfigured(config: AppConfig): boolean {
  return isGithubRemoteFromSection(config.github);
}

/**
 * When `github.owner` and `github.hostname` are set, create/link `origin` on GitHub and push (best-effort).
 * Pass `allowRemote: false` when the user kept an existing local repo without re-bootstrapping (no GitHub step).
 */
async function tryProvisionGithubRemoteAfterVaultPrefs(
  allowRemote: boolean,
  config: AppConfig,
  vaultPath: string,
  repoName: string,
  label: string
): Promise<void> {
  if (!allowRemote) {
    return;
  }
  if (!shouldProvisionGithubRepo(config.github)) {
    return;
  }
  if (!(await isGitRepo(vaultPath))) {
    console.warn(`Skipping GitHub repo for ${label}: not a git repository at ${displayPath(vaultPath)}.`);
    return;
  }
  try {
    await ensureGithubRemoteRepoAndPush(vaultPath, config.github, repoName);
  } catch (error) {
    console.warn(`Could not create or push ${label} to GitHub: ${errorMessage(error)}`);
  }
}

/** Human-readable summary of GitHub settings for console output. */
export function formatGithubConfig(config: Pick<AppConfig, 'github'>): string {
  return [
    'GitHub (obsidian-project):',
    `  Host: ${config.github.hostname}`,
    `  Owner/org: ${config.github.owner ?? '(not set)'}`,
    '  New repos: always private',
    `  Create remotes when adding projects: ${config.github.createRemotes ? 'yes' : 'no'}`
  ].join('\n');
}

interface GithubCommandOptions {
  skipGithub?: boolean;
  owner?: string;
}

/** Return a new config with GitHub owner/createRemotes overridden (validated). */
function patchGithub(config: AppConfig, patch: { owner?: string; createRemotes: boolean }): AppConfig {
  return appConfigSchema.parse({
    ...config,
    github: {
      ...config.github,
      owner: patch.owner,
      createRemotes: patch.createRemotes
    }
  });
}

/** Same as `patchGithub` for persisted config without folder layout. */
function patchGithubPersisted(
  config: PersistedAppConfig,
  patch: { owner?: string; createRemotes: boolean }
): PersistedAppConfig {
  return persistedAppConfigSchema.parse({
    ...config,
    github: {
      ...config.github,
      owner: patch.owner,
      createRemotes: patch.createRemotes
    }
  });
}

/** Interactive and flag-driven GitHub remote setup; persists via `saveConfig`. */
export async function runGithubCommand(config: AppConfig, options: GithubCommandOptions = {}): Promise<void> {
  console.log(formatGithubConfig(config));

  if (options.skipGithub) {
    const next = patchGithub(config, {
      owner: undefined,
      createRemotes: false
    });
    await saveConfig(next);
    console.log('GitHub remote creation is disabled. Run `obsidian-project github` anytime to change this.');
    return;
  }

  if (options.owner?.trim()) {
    await assertGhReady(config.github.hostname);
    await assertGithubOwnerIfRemotes(options.owner.trim(), true, config.github.hostname);
    const next = patchGithub(config, {
      owner: options.owner.trim(),
      createRemotes: true
    });
    await saveConfig(next);
    console.log('GitHub settings saved.');
    return;
  }

  if (isGithubRemoteFromSection(config.github)) {
    return;
  }

  const interactive = input.isTTY && output.isTTY;
  if (!interactive) {
    throw new UserError(
      'GitHub is not fully configured. Pass --owner <org>, or use --skip-github to disable remotes.'
    );
  }

  const rl = readline.createInterface({ input, output });
  try {
    const enable = (await rl.question('Create GitHub remotes when adding new projects? (Y/n): ')).trim().toLowerCase();
    if (enable === 'n' || enable === 'no') {
      const next = patchGithub(config, {
        owner: undefined,
        createRemotes: false
      });
      await saveConfig(next);
      console.log('GitHub remote creation is disabled.');
      return;
    }
  } finally {
    rl.close();
  }

  await assertGhReady(config.github.hostname);
  const owner = await promptGithubOwnerFromMenu(config.github.hostname, {
    savedOwnerHint: config.github.owner ?? ''
  });
  await assertGithubOwnerIfRemotes(owner, true, config.github.hostname);

  const next = patchGithub(config, { owner, createRemotes: true });
  await saveConfig(next);
  console.log('GitHub settings saved.');
}

/** Same as `runGithubCommand` but only `config.json` is available (no vault layout yet). */
export async function runGithubOnPersistedOnly(
  persisted: PersistedAppConfig,
  options: GithubCommandOptions = {}
): Promise<void> {
  console.log(formatGithubConfig({ github: persisted.github }));

  if (options.skipGithub) {
    const next = patchGithubPersisted(persisted, {
      owner: undefined,
      createRemotes: false
    });
    await writePersistedConfig(next);
    console.log('GitHub remote creation is disabled. Run `obsidian-project github` anytime to change this.');
    return;
  }

  if (options.owner?.trim()) {
    await assertGhReady(persisted.github.hostname);
    await assertGithubOwnerIfRemotes(options.owner.trim(), true, persisted.github.hostname);
    const next = patchGithubPersisted(persisted, {
      owner: options.owner.trim(),
      createRemotes: true
    });
    await writePersistedConfig(next);
    console.log('GitHub settings saved.');
    return;
  }

  if (isGithubRemoteFromSection(persisted.github)) {
    return;
  }

  const interactive = input.isTTY && output.isTTY;
  if (!interactive) {
    throw new UserError(
      'GitHub is not fully configured. Pass --owner <org>, or use --skip-github to disable remotes.'
    );
  }

  const rl = readline.createInterface({ input, output });
  try {
    const enable = (await rl.question('Create GitHub remotes when adding new projects? (Y/n): ')).trim().toLowerCase();
    if (enable === 'n' || enable === 'no') {
      const next = patchGithubPersisted(persisted, {
        owner: undefined,
        createRemotes: false
      });
      await writePersistedConfig(next);
      console.log('GitHub remote creation is disabled.');
      return;
    }
  } finally {
    rl.close();
  }

  await assertGhReady(persisted.github.hostname);
  const owner = await promptGithubOwnerFromMenu(persisted.github.hostname, {
    savedOwnerHint: persisted.github.owner ?? ''
  });
  await assertGithubOwnerIfRemotes(owner, true, persisted.github.hostname);

  const next = patchGithubPersisted(persisted, { owner, createRemotes: true });
  await writePersistedConfig(next);
  console.log('GitHub settings saved.');
}

// --- Common vault (managed or register existing) ---

interface SetCommonVaultOptions {
  vaultPath?: string;
  name?: string;
}

interface CommonVaultResult {
  commonProjectName: string;
  commonVaultPath: string;
  created: boolean;
}

/** Point config at an existing common vault folder and logical project name. */
async function setCommonVault(config: AppConfig, options: SetCommonVaultOptions = {}): Promise<CommonVaultResult> {
  const commonVaultPath = await assertObsidianVaultFolder(
    path.resolve(options.vaultPath ?? (await chooseFolder('Select the common Obsidian vault folder'))),
    'Common vault'
  );
  const stat = await fs.stat(commonVaultPath).catch(() => undefined);
  if (!stat?.isDirectory()) {
    throw new UserError(`Common vault folder does not exist: ${commonVaultPath}`);
  }

  const commonProjectName = sanitizeProjectName(
    options.name ?? projectNameFromVaultPath(commonVaultPath, config.repoPrefix)
  );
  const nextConfig = {
    ...config,
    commonProjectName,
    commonConfigured: true,
    commonVaultPath
  };
  await saveConfig(nextConfig);

  return {
    commonProjectName,
    commonVaultPath,
    created: false
  };
}

// --- List / inventory ---

interface FolderStatus {
  label: string;
  path: string;
  exists: boolean;
  linked: boolean;
  target?: string;
}

interface ProjectInventoryItem {
  project: string;
  repoName: string;
  vaultPath: string;
  kind: 'common' | 'project';
  folders: FolderStatus[];
}

/** Union of registry keys and default-parent folders matching `repoPrefix` (excluding common name). */
export async function discoverProjectNames(config: AppConfig): Promise<string[]> {
  const fromRegistry = Object.keys(config.projectVaults);
  const fromDisk: string[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(defaultVaultParentDirectory());
  } catch {
    return [...new Set(fromRegistry)].sort((a, b) => a.localeCompare(b));
  }

  for (const entry of entries.sort((a, b) => a.localeCompare(b))) {
    if (!entry.startsWith(config.repoPrefix)) {
      continue;
    }

    const project = entry.slice(config.repoPrefix.length);
    if (!project || project === config.commonProjectName) {
      continue;
    }

    const layout = resolveProjectVaultPaths(config, project);
    const stat = await fs.stat(layout.vaultPath).catch(() => undefined);
    if (stat?.isDirectory()) {
      fromDisk.push(project);
    }
  }

  return [...new Set([...fromRegistry, ...fromDisk])].sort((a, b) => a.localeCompare(b));
}

/** Inventory of common + project vaults with folder existence/link info. */
export async function listProjects(config: AppConfig): Promise<ProjectInventoryItem[]> {
  const projects = await discoverProjectNames(config);
  const items: ProjectInventoryItem[] = [];

  if (config.commonConfigured) {
    const common = resolveCommonVaultPaths(config);
    items.push({
      project: common.project,
      repoName: common.repoName,
      vaultPath: common.vaultPath,
      kind: 'common',
      folders: await inspectFolders([
        ['vault', common.vaultPath],
        ['git', path.join(common.vaultPath, '.git')]
      ])
    });
  }

  for (const project of projects) {
    const layout = resolveProjectVaultPaths(config, project);
    items.push({
      project,
      repoName: layout.repoName,
      vaultPath: layout.vaultPath,
      kind: 'project',
      folders: await inspectFolders([
        ['vault', layout.vaultPath],
        ['common mount', layout.sharedMountPath],
        ['git', path.join(layout.vaultPath, '.git')]
      ])
    });
  }

  return items;
}

/** Set of all known project names (for Codex cleanup, etc.). */
export async function existingProjectNameSet(config: AppConfig): Promise<Set<string>> {
  return new Set(await discoverProjectNames(config));
}

/** Run `inspectFolder` in parallel for labeled paths. */
async function inspectFolders(entries: Array<[string, string]>): Promise<FolderStatus[]> {
  return await Promise.all(entries.map(([label, folderPath]) => inspectFolder(label, folderPath)));
}

/** Whether a path exists and, if a symlink, its resolved target. */
async function inspectFolder(label: string, folderPath: string): Promise<FolderStatus> {
  const stat = await fs.lstat(folderPath).catch(() => undefined);
  if (!stat) {
    return {
      label,
      path: folderPath,
      exists: false,
      linked: false
    };
  }

  const linked = stat.isSymbolicLink();
  const target = linked ? await resolveLinkTarget(folderPath) : undefined;
  return {
    label,
    path: folderPath,
    exists: true,
    linked,
    target
  };
}

/** Best-effort realpath; fall back to readlink or original path. */
async function resolveLinkTarget(folderPath: string): Promise<string> {
  try {
    return await fs.realpath(folderPath);
  } catch {
    return await fs.readlink(folderPath).catch(() => folderPath);
  }
}

// --- Delete project vault ---

interface DeleteProjectOptions {
  skipPush?: boolean;
}

interface DeleteProjectResult {
  project: string;
  deletedPath: string;
  committed: boolean;
  pushed: boolean;
}

/** Commit, optionally push, remove vault folder, and drop registry entry when present. */
export async function deleteProject(
  config: AppConfig,
  requestedProject: string,
  options: DeleteProjectOptions = {}
): Promise<DeleteProjectResult> {
  const project = sanitizeProjectName(requestedProject);
  if (project === config.commonProjectName) {
    throw new UserError('Refusing to delete the common vault with the project delete command.');
  }

  const layout = resolveProjectVaultPaths(config, project);
  await assertAllowedDeletePath(config, project, layout.vaultPath);

  try {
    await fs.access(layout.vaultPath);
  } catch {
    throw new UserError(`Project vault does not exist: ${layout.vaultPath}`);
  }

  let committed = false;
  let pushed = false;
  if (await isGitRepo(layout.vaultPath)) {
    committed = await commitIfNeeded(layout.vaultPath, `Archive ${layout.repoName} before local delete`);
    if (!options.skipPush) {
      pushed = await pushIfRemote(layout.vaultPath);
    }
  }

  await fs.rm(layout.vaultPath, { recursive: true, force: false });

  if (config.projectVaults[project]) {
    const next = appConfigSchema.parse({
      ...config,
      projectVaults: Object.fromEntries(Object.entries(config.projectVaults).filter(([k]) => k !== project))
    });
    await saveConfig(next);
  }

  return {
    project,
    deletedPath: layout.vaultPath,
    committed,
    pushed
  };
}

/** Ensure delete target is the explicit registered path or under the default vault parent. */
async function assertAllowedDeletePath(config: AppConfig, project: string, target: string): Promise<void> {
  const resolvedTarget = path.resolve(target);
  const explicit = config.projectVaults[project];
  if (explicit && path.resolve(explicit) === resolvedTarget) {
    return;
  }
  await assertPathInsideRoot(defaultVaultParentDirectory(), target);
}

/** Fail unless `target` is strictly inside `root` (not root itself). */
async function assertPathInsideRoot(root: string, target: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative === '') {
    throw new UserError(`Refusing to delete path outside the default vault parent directory: ${resolvedTarget}`);
  }
}

// --- Uninstall CLI package ---

interface UninstallResult {
  codexConfigPath: string;
  removedCodexProjects: string[];
  removedPaths: string[];
  serverStopped: boolean;
}

/** Strip Codex profiles, stop MCP, remove config dirs, `npm uninstall -g`. */
export async function uninstallProjectTool(): Promise<UninstallResult> {
  const config = await loadConfig().catch(() => undefined);
  const codex = await removeAllCodexProjectProfiles(config?.codex.configPath);
  const serverStopped = await stopServer();
  const removedPaths = await removeProjectConfigPaths(config);

  const prefix = process.env.NPM_CONFIG_PREFIX?.trim();
  const npmArgs =
    prefix && prefix.length > 0
      ? ['--prefix', prefix, 'uninstall', '-g', 'obsidian-project-cli']
      : ['uninstall', '-g', 'obsidian-project-cli'];
  await runRequired(npmCommand(), npmArgs, { timeoutMs: 120_000 });

  return {
    codexConfigPath: codex.configPath,
    removedCodexProjects: codex.removedProjects,
    removedPaths,
    serverStopped
  };
}

/** Delete obsidian-project config and state directories when uninstalling. */
async function removeProjectConfigPaths(config: AppConfig | undefined): Promise<string[]> {
  const candidates = new Set<string>([configDir(), stateDir()]);
  if (config?.codex.configPath) {
    candidates.delete(path.dirname(config.codex.configPath));
  }

  const removed: string[] = [];
  for (const target of [...candidates].sort((a, b) => b.length - a.length)) {
    if (await removeIfExists(target)) {
      removed.push(target);
    }
  }

  return removed;
}

/** Delete a path if it exists; return whether anything was removed. */
async function removeIfExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    await fs.rm(target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** `npm` executable name for the current platform. */
function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

// --- CLI vault workflows (register vaults, common mount, bootstrap) ---

interface PathOrPickerOptions {
  path?: string;
  pickerTitle?: string;
}

/** Resolve an explicit path or open the folder picker. */
async function resolvePathOrPicker(options: PathOrPickerOptions): Promise<string> {
  if (options.path) {
    return path.resolve(options.path);
  }
  return path.resolve(await chooseFolder(options.pickerTitle ?? 'Select a folder'));
}

function pathsEquivalentNormalized(a: string, b: string): boolean {
  const left = path.normalize(a);
  const right = path.normalize(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function resolvedVaultPathsEqual(a: string, b: string): Promise<boolean> {
  const ra = await fs.realpath(path.resolve(a)).catch(() => path.resolve(a));
  const rb = await fs.realpath(path.resolve(b)).catch(() => path.resolve(b));
  return pathsEquivalentNormalized(ra, rb);
}

/** Interactive menu: registered project keys (excludes common vault name). */
async function pickRegisteredProjectInteractive(
  config: AppConfig,
  opts?: { verb?: 'link' | 'unlink' }
): Promise<string> {
  const all = await discoverProjectNames(config);
  const projects = all.filter(p => p !== config.commonProjectName);
  if (projects.length === 0) {
    throw new UserError('No project vaults registered. Run add-project-vault first.');
  }
  if (projects.length === 1) {
    return projects[0]!;
  }

  const rl = readline.createInterface({ input, output });
  try {
    console.log('');
    const title =
      opts?.verb === 'unlink'
        ? 'Select a project vault to remove the common mount from:'
        : 'Select a project vault to link with the common vault:';
    console.log(title);
    projects.forEach((p, i) => console.log(`  ${i + 1}) ${p}`));
    const ans = (await rl.question(`Enter number 1–${projects.length}: `)).trim();
    const n = Number(ans);
    if (!Number.isInteger(n) || n < 1 || n > projects.length) {
      throw new UserError('Invalid choice.');
    }
    return projects[n - 1]!;
  } finally {
    rl.close();
  }
}

/** Confirm the user picked the registered common vault (folder picker on macOS/Windows; path prompt on Linux). */
async function confirmRegisteredCommonVaultInteractive(registeredCommonPath: string): Promise<void> {
  let picked: string;
  if (process.platform === 'darwin' || process.platform === 'win32') {
    picked = await chooseFolder('Select the common Obsidian vault folder (must match the one you registered)');
  } else {
    const rl = readline.createInterface({ input, output });
    try {
      const hint = displayPath(registeredCommonPath);
      const raw = (await rl.question(`Path to the registered common vault (${hint}): `)).trim();
      picked = raw === '' ? path.resolve(registeredCommonPath) : path.resolve(raw);
    } finally {
      rl.close();
    }
  }

  const resolved = await assertObsidianVaultFolder(picked, 'Common vault');
  if (!(await resolvedVaultPathsEqual(resolved, registeredCommonPath))) {
    throw new UserError(
      `Selected vault does not match the registered common vault.\n  Registered: ${displayPath(registeredCommonPath)}\n  Selected:  ${displayPath(resolved)}`
    );
  }
}

/** Register the common vault path/name and run GitHub prefs flow. */
export async function selectCommonVault(
  opts: { path?: string; name?: string; skipGithub?: boolean; owner?: string } = {}
): Promise<void> {
  const config = await loadConfig();
  const resolved = await assertObsidianVaultFolder(
    await resolvePathOrPicker({ path: opts.path, pickerTitle: 'Select the common Obsidian vault folder' }),
    'Common vault'
  );
  const name = opts.name ? sanitizeProjectName(opts.name) : projectNameFromVaultPath(resolved, config.repoPrefix);

  await runGithubCommand(config, { skipGithub: opts.skipGithub, owner: opts.owner });

  const result = await setCommonVault(await loadConfig(), { vaultPath: resolved, name });
  console.log(`Common vault registered: ${result.commonProjectName}`);
  console.log(`Path: ${displayPath(result.commonVaultPath)}`);

  const synced = await loadConfig();
  const gitOutcome = await runVaultGitRegistrationInteractive(result.commonVaultPath);
  const common = resolveCommonVaultPaths(synced);
  await tryProvisionGithubRemoteAfterVaultPrefs(
    gitOutcome.kind === 'fresh_bootstrap',
    synced,
    result.commonVaultPath,
    common.repoName,
    'common vault'
  );
}

/** Register a project vault path and optional GitHub prefs. */
export async function addProjectVaultCommand(
  opts: { path?: string; name?: string; skipGithub?: boolean; owner?: string } = {}
): Promise<void> {
  const config = await loadConfig();
  const resolved = await assertObsidianVaultFolder(
    await resolvePathOrPicker({ path: opts.path, pickerTitle: 'Select the project Obsidian vault folder' }),
    'Project vault'
  );
  const project = opts.name ? sanitizeProjectName(opts.name) : sanitizeProjectName(path.basename(resolved));
  if (project === config.commonProjectName) {
    throw new UserError('Project name cannot match the common vault project name.');
  }

  await runGithubCommand(config, { skipGithub: opts.skipGithub, owner: opts.owner });

  const fresh = await loadConfig();
  const next = appConfigSchema.parse({
    ...fresh,
    projectVaults: { ...fresh.projectVaults, [project]: resolved }
  });
  await saveConfig(next);
  console.log(`Project vault registered: ${project}`);
  console.log(`Path: ${displayPath(resolved)}`);

  const synced = await loadConfig();
  const gitOutcome = await runVaultGitRegistrationInteractive(resolved);
  const layout = resolveProjectVaultPaths(synced, project);
  await tryProvisionGithubRemoteAfterVaultPrefs(
    gitOutcome.kind === 'fresh_bootstrap',
    synced,
    resolved,
    layout.repoName,
    `project vault "${project}"`
  );
}

/**
 * Link the registered common vault into `<project>/common` (symlink or junction).
 * Interactive: pick project, then confirm common vault (folder picker or path prompt).
 * Non-interactive: pass both `--project` and `--common-path` matching the registered common vault.
 */
export async function addCommonToProjectCommand(opts: { project?: string; commonPath?: string }): Promise<void> {
  const config = await loadConfig();
  if (!config.commonConfigured || !config.commonVaultPath) {
    throw new UserError('Common vault is not registered. Run add-common-vault first.');
  }
  const common = resolveCommonVaultPaths(config);
  const registeredCommon = common.vaultPath;

  let project: string;
  const hasProject = Boolean(opts.project?.trim());
  const hasCommonPath = Boolean(opts.commonPath?.trim());

  if (hasProject !== hasCommonPath) {
    throw new UserError('For non-interactive use, pass both --project <name> and --common-path <path> together.');
  }

  if (hasProject && hasCommonPath) {
    project = sanitizeProjectName(opts.project!.trim());
    const given = path.resolve(opts.commonPath!.trim());
    if (!(await resolvedVaultPathsEqual(given, registeredCommon))) {
      throw new UserError(`--common-path must match the registered common vault: ${displayPath(registeredCommon)}`);
    }
    const layout = resolveProjectVaultPaths(config, project);
    try {
      await fs.access(layout.vaultPath);
    } catch {
      throw new UserError(`Unknown project vault: ${project}`);
    }
  } else if (!input.isTTY || !output.isTTY) {
    throw new UserError('Run in an interactive terminal, or pass --project and --common-path for scripting.');
  } else {
    project = await pickRegisteredProjectInteractive(config, { verb: 'link' });
    await confirmRegisteredCommonVaultInteractive(registeredCommon);
  }

  const layout = resolveProjectVaultPaths(config, project);
  await createCommonMount(layout.sharedMountPath, common.vaultPath, { forceReplace: true });
  console.log(`Linked common vault into project “${project}”.`);
  console.log(`  Mount: ${displayPath(layout.sharedMountPath)}`);
  console.log(`  → ${displayPath(common.vaultPath)}`);
}

/** Remove the vault-root `common` symlink or junction from a project vault. */
export async function removeCommonFromProjectCommand(opts: { project?: string; path?: string }): Promise<void> {
  const config = await loadConfig();
  if (opts.project) {
    const project = sanitizeProjectName(opts.project);
    const layout = resolveProjectVaultPaths(config, project);
    await removeCommonMountPath(layout.sharedMountPath);
    console.log(`Removed common mount for project “${project}”.`);
    return;
  }
  if (opts.path) {
    const resolved = path.resolve(opts.path);
    const match = Object.entries(config.projectVaults).find(([, p]) => path.resolve(p) === resolved);
    let project: string;
    if (match) {
      project = match[0];
    } else {
      const base = sanitizeProjectName(path.basename(resolved));
      if (config.projectVaults[base] && path.resolve(config.projectVaults[base]) === resolved) {
        project = base;
      } else {
        throw new UserError('Could not infer project from --path. Pass --project <name>.');
      }
    }
    const layout = resolveProjectVaultPaths(config, project);
    await removeCommonMountPath(layout.sharedMountPath);
    console.log(`Removed common mount for project “${project}”.`);
    return;
  }

  if (input.isTTY && output.isTTY) {
    const project = await pickRegisteredProjectInteractive(config, { verb: 'unlink' });
    const layout = resolveProjectVaultPaths(config, project);
    await removeCommonMountPath(layout.sharedMountPath);
    console.log(`Removed common mount for project “${project}”.`);
    return;
  }

  const picked = path.resolve(await chooseFolder('Select the project vault folder'));
  const match = Object.entries(config.projectVaults).find(([, p]) => path.resolve(p) === picked);
  const project = match?.[0];
  if (!project) {
    throw new UserError('Selected folder is not a registered project vault. Run add-project-vault first.');
  }
  const layout = resolveProjectVaultPaths(config, project);
  await removeCommonMountPath(layout.sharedMountPath);
  console.log(`Removed common mount for project “${project}”.`);
}

interface CliBootstrapArgv {
  skipGithub?: boolean;
  githubOwner?: string;
  preferredPort?: number;
  githubHost?: string;
}

/**
 * Set when `ensureCliBootstrapIfNeeded` finishes the first-time wizard (writes `cliBootstrap`).
 * Cleared by {@link takeCliBootstrapWizardJustFinished}. Commander runs bootstrap in `preAction`
 * before `initConfig`, so we cannot infer first-run from config reads alone.
 */
let cliBootstrapWizardJustFinished = false;

/** Whether the CLI bootstrap wizard completed in the preceding `ensureCliBootstrapIfNeeded` call (consumes flag). */
function takeCliBootstrapWizardJustFinished(): boolean {
  const v = cliBootstrapWizardJustFinished;
  cliBootstrapWizardJustFinished = false;
  return v;
}

/** Runs first-time port + GitHub host + remote prefs until `cliBootstrap` exists in config.json. */
export async function ensureCliBootstrapIfNeeded(opts: CliBootstrapArgv = {}): Promise<void> {
  const persisted = (await configExists()) ? await readPersistedConfig() : defaultPersistedBootstrap();
  if (!persistedNeedsCliBootstrap(persisted)) {
    return;
  }

  const skipExternalCli =
    process.env.OBSIDIAN_PROJECT_SKIP_EXTERNAL_CLI_CHECKS === '1' ||
    process.env.OBSIDIAN_PROJECT_SKIP_EXTERNAL_CLI_CHECKS === 'true';
  if (!skipExternalCli) {
    await assertObsidianCliReady();
  }

  const interactive = input.isTTY && output.isTTY;

  let port: number;
  if (opts.preferredPort !== undefined) {
    port = opts.preferredPort;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new UserError('Port must be an integer between 1024 and 65535.');
    }
  } else if (!interactive) {
    port = persisted.server.preferredPort;
  } else {
    const rl = readline.createInterface({ input, output });
    try {
      const def = persisted.server.preferredPort;
      const ans = (await rl.question(`MCP preferred port (${def}): `)).trim();
      port = ans === '' ? def : Number(ans);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        throw new UserError('Port must be an integer between 1024 and 65535.');
      }
    } finally {
      rl.close();
    }
  }

  let githubHostname: string;
  if (opts.githubHost?.trim()) {
    githubHostname = opts.githubHost.trim().replace(/^https?:\/\//i, '').split('/')[0]?.trim() || 'github.com';
  } else if (!interactive) {
    githubHostname = persisted.github.hostname;
  } else {
    const rl = readline.createInterface({ input, output });
    try {
      const def = persisted.github.hostname || 'github.com';
      const ans = (await rl.question(`GitHub hostname (${def}): `)).trim();
      githubHostname = (ans === '' ? def : ans).replace(/^https?:\/\//i, '').split('/')[0]?.trim() || 'github.com';
    } finally {
      rl.close();
    }
  }

  let createRemotes = false;
  let owner: string | undefined;

  if (opts.skipGithub) {
    createRemotes = false;
    owner = undefined;
  } else if (opts.githubOwner?.trim()) {
    if (!skipExternalCli) {
      await assertGhReady(githubHostname);
    }
    createRemotes = true;
    owner = opts.githubOwner.trim();
  } else if (!interactive) {
    throw new UserError(
      'First-time setup from a non-interactive environment requires --skip-github or --owner <org>. Optional: --port <n>, --github-host <host>.'
    );
  } else {
    let enableRemotes = false;
    const rl = readline.createInterface({ input, output });
    try {
      const enable = (await rl.question('Create GitHub remotes when adding new projects? (Y/n): ')).trim().toLowerCase();
      if (enable !== 'n' && enable !== 'no') {
        enableRemotes = true;
      }
    } finally {
      rl.close();
    }
    if (enableRemotes) {
      if (!skipExternalCli) {
        await assertGhReady(githubHostname);
      }
      owner = await promptGithubOwnerFromMenu(githubHostname, {
        savedOwnerHint: persisted.github.owner ?? ''
      });
      createRemotes = true;
    } else {
      createRemotes = false;
      owner = undefined;
    }
  }

  if (createRemotes && owner) {
    await assertGithubOwnerIfRemotes(owner, true, githubHostname);
  }

  const next = persistedAppConfigSchema.parse({
    ...persisted,
    server: { ...persisted.server, preferredPort: port },
    github: {
      ...persisted.github,
      hostname: githubHostname,
      owner: createRemotes ? owner : undefined,
      createRemotes
    },
    cliBootstrap: {
      preferredPort: port,
      githubHostname,
      createRemotes,
      owner: createRemotes ? owner : undefined
    }
  });
  await writePersistedConfig(next);
  cliBootstrapWizardJustFinished = true;
}

/** Default `obsidian-project` run: ensure bootstrap, then GitHub prefs and optional agent skill. */
export async function initConfig(opts: {
  skipGithub?: boolean;
  githubOwner?: string;
  agentSkill?: boolean;
  preferredPort?: number;
  githubHost?: string;
}): Promise<void> {
  const skipExternalCli =
    process.env.OBSIDIAN_PROJECT_SKIP_EXTERNAL_CLI_CHECKS === '1' ||
    process.env.OBSIDIAN_PROJECT_SKIP_EXTERNAL_CLI_CHECKS === 'true';
  if (!skipExternalCli) {
    await assertObsidianCliReady();
  }

  /** `preAction` already ran `ensureCliBootstrapIfNeeded`; capture whether that call completed the wizard. */
  const completedBootstrapWizard = takeCliBootstrapWizardJustFinished();

  let config: AppConfig | undefined;
  try {
    config = await loadConfig();
  } catch {
    config = undefined;
  }

  const persisted = await readPersistedConfig();
  const skipRepeatGithub = persisted.cliBootstrap !== undefined;

  if (!skipRepeatGithub) {
    if (config) {
      await runGithubCommand(config, {
        skipGithub: opts.skipGithub,
        owner: opts.githubOwner
      });
    } else {
      await runGithubOnPersistedOnly(persisted, {
        skipGithub: opts.skipGithub,
        owner: opts.githubOwner
      });
    }
  }

  const interactive = input.isTTY && output.isTTY;

  if (opts.agentSkill) {
    const result = await installCodexSkill();
    console.log(formatCodexSkillLines(result));
  } else if (interactive && completedBootstrapWizard) {
    const rl = readline.createInterface({ input, output });
    try {
      const skillAns = (await rl.question('Install bundled Codex agent skills? (Y/n): '))
        .trim()
        .toLowerCase();
      if (skillAns !== 'n' && skillAns !== 'no') {
        const defaultCodex = codexSkillsRootDefault();
        const pathAns = (await rl.question(`Codex skills directory (${displayPath(defaultCodex)}): `)).trim();
        const result = await installCodexSkill(pathAns ? { codexSkillsRoot: pathAns } : undefined);
        console.log(formatCodexSkillLines(result));
      }
    } finally {
      rl.close();
    }
  }

  console.log('Init finished (CLI checks, GitHub preferences, optional agent skill).');
  console.log('Next: add-common-vault, add-project-vault; link with add-common-to-project.');
}
