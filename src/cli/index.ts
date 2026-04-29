#!/usr/bin/env node
import { Command } from 'commander';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { codexProfileName } from '../codex/config.js';
import { ensureConfig, initConfig, loadConfig } from '../config/load.js';
import { errorMessage, UserError } from '../errors.js';
import { assertGhReady } from '../github/gh.js';
import { assertObsidianCliReady } from '../obsidian/cli.js';
import { createProject } from '../projects/createProject.js';
import { deleteProject } from '../projects/deleteProject.js';
import { readServerState, startServer, stopServer } from '../server/lifecycle.js';
import { runMcpHttpServer } from '../server/http.js';
import { configPath, serverLogPath } from '../platform/paths.js';

const program = new Command();

program
  .name('obsidian-project')
  .description('Manage isolated Obsidian project vaults and a scoped MCP server.')
  .version('0.1.0');

program
  .command('init')
  .description('Create or replace obsidian-project global configuration.')
  .option('--vault-root <path>', 'Vault root directory')
  .option('--common <name>', 'Common vault project name', 'common')
  .option('--repo-prefix <prefix>', 'Repository prefix', 'obsidian-vault-')
  .option('--github-owner <owner>', 'GitHub owner/org for remote creation')
  .option('--create-remotes', 'Create GitHub remotes by default')
  .option('--if-missing', 'Do nothing when config already exists')
  .option('--yes', 'Use defaults for any missing answers')
  .action(async options => {
    const config = await initConfig({
      vaultRoot: options.vaultRoot,
      commonProjectName: options.common,
      repoPrefix: options.repoPrefix,
      githubOwner: options.githubOwner,
      createRemotes: options.createRemotes,
      yes: options.yes,
      ifMissing: options.ifMissing
    });
    console.log(`Config written: ${configPath()}`);
    console.log(`Vault root: ${config.vaultRoot}`);
  });

program
  .command('new')
  .description('Create a new project vault, repository, common mount, and Codex profile.')
  .argument('<project>', 'Project name, e.g. project-1')
  .option('--github', 'Create/connect GitHub repositories using gh')
  .option('--skip-github', 'Do not create GitHub repositories, even if configured by default')
  .action(async (project: string, options: { github?: boolean; skipGithub?: boolean }) => {
    const config = await ensureConfig();
    const createRemote = options.skipGithub ? false : options.github ? true : undefined;
    const result = await createProject(config, project, { createRemote });
    console.log(`Created project: ${result.project}`);
    console.log(`Project vault: ${result.projectVaultPath}`);
    console.log(`Common vault: ${result.commonVaultPath}`);
    console.log(`Codex config updated: ${result.codexConfigPath}`);
    console.log(`Codex profile: ${codexProfileName(config, result.project)}`);
  });

program
  .command('delete')
  .description('Commit/push latest project changes and delete the local project vault only.')
  .argument('<project>', 'Project name')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--skip-push', 'Commit but do not push before deleting locally')
  .action(async (project: string, options: { yes?: boolean; skipPush?: boolean }) => {
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
  });

program
  .command('start')
  .description('Start the persistent local MCP server.')
  .action(async () => {
    const config = await loadConfig();
    const result = await startServer(config);
    console.log(result.alreadyRunning ? 'MCP server already running.' : 'MCP server started.');
    console.log(`URL: http://${result.state.host}:${result.state.port}/mcp`);
    console.log(`PID: ${result.state.pid}`);
    console.log(`Obsidian: ${result.obsidianVersion}`);
    console.log(`GitHub account: ${result.account.login}${result.account.name ? ` (${result.account.name})` : ''}`);
    console.log(`Log: ${serverLogPath()}`);
  });

program
  .command('stop')
  .description('Stop the persistent local MCP server.')
  .action(async () => {
    const stopped = await stopServer();
    console.log(stopped ? 'MCP server stopped.' : 'MCP server is not running.');
  });

program
  .command('status')
  .description('Show MCP server status.')
  .action(async () => {
    const state = await readServerState();
    if (!state) {
      console.log('MCP server is not running.');
      return;
    }
    console.log(`MCP server state: http://${state.host}:${state.port}/mcp`);
    console.log(`PID: ${state.pid}`);
    console.log(`Started: ${state.startedAt}`);
  });

program
  .command('doctor')
  .description('Check external dependencies.')
  .action(async () => {
    const config = await loadConfig();
    const obsidianVersion = await assertObsidianCliReady();
    const account = await assertGhReady();
    console.log(`Config: ${configPath()}`);
    console.log(`Vault root: ${config.vaultRoot}`);
    console.log(`Obsidian CLI: ${obsidianVersion}`);
    console.log(`GitHub CLI account: ${account.login}${account.name ? ` (${account.name})` : ''}`);
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
