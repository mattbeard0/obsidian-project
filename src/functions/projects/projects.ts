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
import { ensureFolderStructureInteractive } from './folderStructureInteractive.js';
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
import { UserError } from '../errors.js';
import { commitIfNeeded, ensureGitRepo, isGitRepo, pushIfRemote } from '../git/index.js';
import { chooseFolder, runRequired } from '../platform/shell.js';
import { configDir, displayPath, stateDir } from '../platform/paths.js';
import { createCommonMount } from '../symlinks/index.js';
import {
  assertObsidianVaultFolder,
  assertPathInsideDirectory,
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
  const commonVaultPath = path.resolve(options.vaultPath ?? (await chooseFolder()));
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
        ['attachments', common.attachmentsPath],
        ['note library', common.noteLibraryPath],
        ['publish', common.publishPath],
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
        ['attachments', layout.attachmentsPath],
        ['note library', layout.noteLibraryPath],
        ['project scope', layout.projectScopePath],
        ['common mount', layout.sharedMountPath],
        ['publish', layout.publishPath],
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

/** Register the common vault path/name and run GitHub prefs flow. */
export async function selectCommonVault(
  opts: { path?: string; name?: string; skipGithub?: boolean; owner?: string } = {}
): Promise<void> {
  await ensureFolderStructureInteractive();
  const config = await loadConfig();
  const resolved = await assertObsidianVaultFolder(
    await resolvePathOrPicker({ path: opts.path, pickerTitle: 'Select the common Obsidian vault folder' }),
    'Common vault'
  );
  const name = opts.name ? sanitizeProjectName(opts.name) : projectNameFromVaultPath(resolved, config.repoPrefix);
  const result = await setCommonVault(config, { vaultPath: resolved, name });
  console.log(`Common vault registered: ${result.commonProjectName}`);
  console.log(`Path: ${displayPath(result.commonVaultPath)}`);

  const after = await loadConfig();
  await runGithubCommand(after, { skipGithub: opts.skipGithub, owner: opts.owner });
}

/** Register a project vault path and optional GitHub prefs. */
export async function addProjectVaultCommand(
  opts: { path?: string; name?: string; skipGithub?: boolean; owner?: string } = {}
): Promise<void> {
  await ensureFolderStructureInteractive();
  const config = await loadConfig();
  const resolved = await assertObsidianVaultFolder(
    await resolvePathOrPicker({ path: opts.path, pickerTitle: 'Select the project Obsidian vault folder' }),
    'Project vault'
  );
  const project = opts.name ? sanitizeProjectName(opts.name) : sanitizeProjectName(path.basename(resolved));
  if (project === config.commonProjectName) {
    throw new UserError('Project name cannot match the common vault project name.');
  }
  const next = appConfigSchema.parse({
    ...config,
    projectVaults: { ...config.projectVaults, [project]: resolved }
  });
  await saveConfig(next);
  await ensureGitRepo(resolved, `Initialize ${next.repoPrefix}${project}`).catch(() => undefined);
  console.log(`Project vault registered: ${project}`);
  console.log(`Path: ${displayPath(resolved)}`);

  const after = await loadConfig();
  await runGithubCommand(after, { skipGithub: opts.skipGithub, owner: opts.owner });
}

/** Symlink the common note library into a project’s shared-scope folder. */
export async function addCommonToProjectCommand(opts: { project?: string; path?: string }): Promise<void> {
  const config = await loadConfig();
  if (!config.commonConfigured || !config.commonVaultPath) {
    throw new UserError('Common vault is not registered. Run add-common-vault first.');
  }
  if (!opts.project) {
    throw new UserError('Pass --project <name> (registered project vault).');
  }
  const project = sanitizeProjectName(opts.project);
  const commonRoot = path.resolve(config.commonVaultPath);
  const picked = await resolvePathOrPicker({
    path: opts.path,
    pickerTitle: 'Select a folder inside the common vault (for validation)'
  });
  await assertPathInsideDirectory(commonRoot, picked);

  const common = resolveCommonVaultPaths(config);
  const layout = resolveProjectVaultPaths(config, project);
  await createCommonMount(layout.sharedMountPath, common.noteLibraryPath, { forceReplace: true });
  console.log(`Linked common note library into project “${project}”.`);
  console.log(`  Mount: ${displayPath(layout.sharedMountPath)}`);
  console.log(`  → ${displayPath(common.noteLibraryPath)}`);
}

/** Remove the shared-scope symlink/junction from a project vault. */
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
