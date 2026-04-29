#!/usr/bin/env node
import { Command } from 'commander';
import { createRequire } from 'node:module';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { cleanupCodexProjectProfiles, codexProfileName, refreshCodexProfilesForPort } from '../codex/config.js';
import { configExists, ensureConfig, initConfig, loadConfig } from '../config/load.js';
import { errorMessage, UserError } from '../errors.js';
import { assertGhReady } from '../github/gh.js';
import { assertObsidianCliReady } from '../obsidian/cli.js';
import { createCommonVault, setCommonVault } from '../projects/common.js';
import { createProject } from '../projects/createProject.js';
import { deleteProject } from '../projects/deleteProject.js';
import { existingProjectNameSet, listProjects } from '../projects/list.js';
import { uninstallProjectTool } from '../projects/uninstall.js';
import { readServerState, startServer, stopServer } from '../server/lifecycle.js';
import { runMcpHttpServer } from '../server/http.js';
import { configPath, serverLogPath } from '../platform/paths.js';

const program = new Command();
const require = createRequire(import.meta.url);
const packageJson = require('../../package.json') as { version: string };

program
  .name('obsidian-project')
  .description('Manage isolated Obsidian project vaults and a scoped MCP server. Use --commands (for example, --new, --delete, --list).')
  .version(packageJson.version)
  .showHelpAfterError()
  .option('--init', 'Open the setup wizard')
  .option('--vault-root <path>', 'Vault root directory for --init')
  .option('--common <name>', 'Common vault project name for --init or --create-common')
  .option('--common-path <path>', 'Existing common vault folder for --init')
  .option('--common-mode <mode>', 'Common vault setup for --init: existing, create, or later')
  .option('--common-later', 'Configure vault root now and add the common vault later')
  .option('--repo-prefix <prefix>', 'Repository prefix for --init')
  .option('--github-owner <owner>', 'GitHub owner/org for remote creation')
  .option('--create-remotes', 'Create GitHub remotes by default')
  .option('--new <project>', 'Create a new project vault; local Git repos are always created, GitHub remotes are optional')
  .option('--github', 'With --new, create/connect GitHub repositories using gh')
  .option('--skip-github', 'With --new, disable GitHub remote creation for this run')
  .option('--delete <project>', 'Commit and push latest local changes (when possible), then delete only the local project vault')
  .option('--yes', 'Skip confirmation prompts')
  .option('--skip-push', 'Commit but do not push before deleting locally')
  .option('--set-common [path]', 'Select an existing common vault folder')
  .option('--create-common [name]', 'Create or reuse the managed common vault')
  .option('--list', 'List configured Obsidian project vaults and folders')
  .option('--clean-up', 'Remove stale generated Codex config blocks for projects no longer present locally')
  .option('--cleanup', 'Alias for --clean-up')
  .option('--uninstall', 'Remove obsidian-project config and uninstall the npm package')
  .option('--skip-package', 'With --uninstall, clean config only and keep the npm package')
  .option('--start', 'Start the persistent local MCP server')
  .option('--stop', 'Stop the persistent local MCP server')
  .option('--status', 'Show MCP server status')
  .option('--doctor', 'Check external dependencies');

program.action(async () => {
  await dispatchTopLevelCommand(program.opts());
});

program
  .command('serve', { hidden: true })
  .description('Internal MCP server process.')
  .option('--port <port>', 'Port to listen on', value => Number(value))
  .option('--token <token>', 'Shutdown token')
  .action(async (options: { port?: number; token?: string }) => {
    if (!options.port || !options.token) {
      throw new UserError('Internal serve command requires --port and --token.');
    }
    const config = await loadConfig();
    await runMcpHttpServer(config, { port: options.port, shutdownToken: options.token });
    console.log(`obsidian-project MCP server listening on ${config.server.host}:${options.port}`);
  });

program.parseAsync(process.argv).catch(error => {
  console.error(errorMessage(error));
  process.exit(error instanceof UserError ? 2 : 1);
});

async function confirm(question: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    return (await rl.question(`${question}: `)).trim();
  } finally {
    rl.close();
  }
}

async function dispatchTopLevelCommand(options: Record<string, unknown>): Promise<void> {
  const selected = [
    options.init && '--init',
    options.new && '--new',
    options.delete && '--delete',
    options.setCommon !== undefined && '--set-common',
    options.createCommon !== undefined && '--create-common',
    options.list && '--list',
    (options.cleanUp || options.cleanup) && '--clean-up',
    options.uninstall && '--uninstall',
    options.start && '--start',
    options.stop && '--stop',
    options.status && '--status',
    options.doctor && '--doctor'
  ].filter(Boolean);

  if (selected.length > 1) {
    throw new UserError(`Choose one command at a time. Received: ${selected.join(', ')}`);
  }

  if (options.init) {
    await configureProject({
      vaultRoot: stringOption(options.vaultRoot),
      commonProjectName: stringOption(options.common),
      commonMode: options.commonLater ? 'later' : commonModeOption(options.commonMode),
      commonVaultPath: stringOption(options.commonPath),
      repoPrefix: stringOption(options.repoPrefix),
      githubOwner: stringOption(options.githubOwner),
      createRemotes: booleanOption(options.createRemotes),
      yes: booleanOption(options.yes)
    });
    return;
  }

  if (typeof options.new === 'string') {
    await createNewProject(options.new, {
      github: booleanOption(options.github),
      skipGithub: booleanOption(options.skipGithub)
    });
    return;
  }

  if (typeof options.delete === 'string') {
    await deleteLocalProject(options.delete, {
      yes: booleanOption(options.yes),
      skipPush: booleanOption(options.skipPush)
    });
    return;
  }

  if (options.setCommon !== undefined) {
    await selectCommonVault(typeof options.setCommon === 'string' ? options.setCommon : undefined);
    return;
  }

  if (options.createCommon !== undefined) {
    await createManagedCommonVault(
      typeof options.createCommon === 'string' ? options.createCommon : stringOption(options.common) ?? 'common'
    );
    return;
  }

  if (options.list) {
    await printProjectList();
    return;
  }

  if (options.cleanUp || options.cleanup) {
    await cleanupCodexConfig();
    return;
  }

  if (options.uninstall) {
    await uninstallTool({
      yes: booleanOption(options.yes),
      skipPackage: booleanOption(options.skipPackage)
    });
    return;
  }

  if (options.start) {
    await startMcpServer();
    return;
  }

  if (options.stop) {
    await stopMcpServer();
    return;
  }

  if (options.status) {
    await printServerStatus();
    return;
  }

  if (options.doctor) {
    await runDoctor();
    return;
  }

  const configured = await configExists();
  console.log(configured ? 'obsidian-project is installed and configured.' : 'obsidian-project is installed.');
  console.log('Run "obsidian-project --help" to see available commands.');
}

async function configureProject(options: Parameters<typeof initConfig>[0] = {}): Promise<void> {
  const config = await initConfig(options);
  const common = config.commonConfigured
    ? config.commonVaultPath
      ? await setCommonVault(config, { vaultPath: config.commonVaultPath, name: config.commonProjectName })
      : await createCommonVault(config, { name: config.commonProjectName })
    : undefined;

  console.log(`Config written: ${configPath()}`);
  console.log(`Vault root: ${config.vaultRootConfigured ? config.vaultRoot : 'set up later with "obsidian-project --init"'}`);
  console.log(`Common vault: ${common ? common.commonVaultPath : 'add later with "obsidian-project --set-common" or "obsidian-project --create-common"'}`);
}

async function selectCommonVault(vaultPath?: string): Promise<void> {
  const config = await loadConfig();
  const result = await setCommonVault(config, { vaultPath });
  console.log(`Common vault configured: ${result.commonProjectName}`);
  console.log(`Common vault path: ${result.commonVaultPath}`);
}

async function createManagedCommonVault(name = 'common'): Promise<void> {
  const config = await loadConfig();
  const result = await createCommonVault(config, { name });
  console.log(`Common vault configured: ${result.commonProjectName}`);
  console.log(`Common vault path: ${result.commonVaultPath}`);
  console.log(`Created folders: ${result.created ? 'yes' : 'already existed'}`);
}

async function createNewProject(project: string, options: { github?: boolean; skipGithub?: boolean }): Promise<void> {
  const config = await ensureConfig();
  const createRemote = options.skipGithub ? false : options.github ? true : undefined;
  const result = await createProject(config, project, { createRemote });
  console.log(`Created project: ${result.project}`);
  console.log(`Project vault: ${result.projectVaultPath}`);
  console.log(`Common vault: ${result.commonVaultPath}`);
  console.log(`Codex config updated: ${result.codexConfigPath}`);
  console.log(`Codex profile: ${codexProfileName(config, result.project)}`);
}

async function deleteLocalProject(project: string, options: { yes?: boolean; skipPush?: boolean }): Promise<void> {
  const config = await loadConfig();
  if (!options.yes) {
    const confirmed = await confirm(`Delete local vault for "${project}" after committing and pushing latest changes? Type the project name to confirm`);
    if (confirmed !== project) {
      throw new UserError('Delete cancelled.');
    }
  }

  const result = await deleteProject(config, project, { skipPush: options.skipPush });
  console.log(`Deleted local vault: ${result.deletedPath}`);
  console.log(`Committed latest changes: ${result.committed ? 'yes' : 'no changes'}`);
  console.log(`Pushed to origin: ${result.pushed ? 'yes' : options.skipPush ? 'skipped' : 'no remote'}`);
}

async function printProjectList(): Promise<void> {
  const config = await loadConfig();
  const items = await listProjects(config);
  if (items.length === 0) {
    console.log('No obsidian-project vaults found.');
    return;
  }

  for (const item of items) {
    console.log(`${item.kind === 'common' ? 'Common' : 'Project'}: ${item.project}`);
    console.log(`  Repo: ${item.repoName}`);
    console.log(`  Vault: ${item.vaultPath}`);
    for (const folder of item.folders) {
      const state = folder.exists ? (folder.linked ? 'linked' : 'exists') : 'missing';
      const target = folder.target ? ` -> ${folder.target}` : '';
      console.log(`  - ${folder.label}: ${state} ${folder.path}${target}`);
    }
  }
}

async function cleanupCodexConfig(): Promise<void> {
  const config = await loadConfig();
  const existingProjects = await existingProjectNameSet(config);
  const result = await cleanupCodexProjectProfiles(config, existingProjects);
  const state = await readServerState();
  await refreshCodexProfilesForPort(config, state?.port ?? config.server.preferredPort);
  console.log(`Codex config: ${result.configPath}`);
  console.log(`Existing projects: ${existingProjects.size ? [...existingProjects].join(', ') : 'none'}`);
  console.log(`Removed stale profiles: ${result.removedProjects.length ? result.removedProjects.join(', ') : 'none'}`);
  console.log('Refreshed existing project profiles: yes');
}

async function uninstallTool(options: { yes?: boolean; skipPackage?: boolean }): Promise<void> {
  if (!options.yes) {
    const confirmed = await confirm(
      'Uninstall obsidian-project? This removes generated Codex config and obsidian-project app config, but leaves vaults, links, and Git repos untouched. Type "uninstall" to confirm'
    );
    if (confirmed !== 'uninstall') {
      throw new UserError('Uninstall cancelled.');
    }
  }

  const result = await uninstallProjectTool({ removePackage: !options.skipPackage });
  console.log(`Codex config cleaned: ${result.codexConfigPath}`);
  console.log(`Removed Codex profiles: ${result.removedCodexProjects.length ? result.removedCodexProjects.join(', ') : 'none'}`);
  console.log(`Removed app config paths: ${result.removedPaths.length ? result.removedPaths.join(', ') : 'none'}`);
  console.log(`MCP server stopped: ${result.serverStopped ? 'yes' : 'not running'}`);
  console.log(`npm package removed: ${result.packageRemoved ? 'yes' : 'skipped'}`);
  console.log('Vaults, common mounts, and Git repositories were left untouched.');
}

async function startMcpServer(): Promise<void> {
  const config = await loadConfig();
  const result = await startServer(config);
  console.log(result.alreadyRunning ? 'MCP server already running.' : 'MCP server started.');
  console.log(`URL: http://${result.state.host}:${result.state.port}/mcp`);
  console.log(`PID: ${result.state.pid}`);
  console.log(`Obsidian: ${result.obsidianVersion}`);
  console.log(`GitHub account: ${result.account.login}${result.account.name ? ` (${result.account.name})` : ''}`);
  console.log(`Log: ${serverLogPath()}`);
}

async function stopMcpServer(): Promise<void> {
  const stopped = await stopServer();
  console.log(stopped ? 'MCP server stopped.' : 'MCP server is not running.');
}

async function printServerStatus(): Promise<void> {
  const state = await readServerState();
  if (!state) {
    console.log('MCP server is not running.');
    return;
  }
  console.log(`MCP server state: http://${state.host}:${state.port}/mcp`);
  console.log(`PID: ${state.pid}`);
  console.log(`Started: ${state.startedAt}`);
}

async function runDoctor(): Promise<void> {
  const config = await loadConfig();
  const obsidianVersion = await assertObsidianCliReady();
  const account = await assertGhReady();
  console.log(`Config: ${configPath()}`);
  console.log(`Vault root: ${config.vaultRoot}`);
  console.log(`Obsidian CLI: ${obsidianVersion}`);
  console.log(`GitHub CLI account: ${account.login}${account.name ? ` (${account.name})` : ''}`);
}

function stringOption(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function booleanOption(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function commonModeOption(value: unknown): 'create' | 'existing' | 'later' | undefined {
  if (value === 'create' || value === 'existing' || value === 'later') {
    return value;
  }
  return undefined;
}
