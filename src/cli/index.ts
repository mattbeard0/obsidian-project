#!/usr/bin/env node
import { Command } from 'commander';
import { createRequire } from 'node:module';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { codexConfigPath } from '../functions/codex/config.js';
import { configExists, defaultVaultParentDirectory, loadConfig, readPersistedConfig, type AppConfig } from '../config/config.js';
import { errorMessage, UserError } from '../functions/errors.js';
import { assertGhReady, assertObsidianCliReady } from '../functions/dependency/dependencyCheck.js';
import {
  addCommonToProjectCommand,
  addProjectVaultCommand,
  deleteProject,
  ensureCliBootstrapIfNeeded,
  existingProjectNameSet,
  initConfig,
  listProjects,
  removeCommonFromProjectCommand,
  runGithubCommand,
  selectCommonVault,
  uninstallProjectTool
} from '../functions/projects/projects.js';
import { readServerState, runMcpHttpServer, startServer, stopServer } from '../mcp/mcp.js';
import { configPath, displayPath, serverLogPath } from '../functions/platform/paths.js';
import { formatCodexSkillLines, installCodexSkill } from '../functions/skills/index.js';
import { ensureMountsBeforeServerStart } from './interactive.js';

const program = new Command();
const require = createRequire(import.meta.url);
const packageJson = require('../../package.json') as { version: string };

const CLEANUP_CODEX_BEGIN = '# BEGIN obsidian-project ';
const CLEANUP_CODEX_END = '# END obsidian-project ';

/** Best-effort global npm bin path hint for doctor output. */
function globalNpmBinHint(): string {
  try {
    const prefix = execSync('npm prefix -g', { encoding: 'utf8' }).trim();
    return path.join(prefix, 'bin');
  } catch {
    return '(run "npm prefix -g" and append /bin on macOS/Linux, or check npm docs on Windows)';
  }
}

/** Escape dynamic text for use inside a RegExp pattern. */
function escapeCleanupRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Collapse excessive blank lines after removing Codex blocks. */
function collapseCleanupBlankLines(value: string): string {
  return value.replace(/\n{3,}/g, '\n\n');
}

/** Remove obsidian-project Codex profile blocks for projects that no longer exist. */
async function cleanupCodexProjectProfiles(
  config: AppConfig,
  existingProjects: Set<string>
): Promise<{ configPath: string; removedProjects: string[]; keptProjects: string[] }> {
  const file = config.codex.configPath ?? codexConfigPath();
  let current = '';
  try {
    current = await fs.readFile(file, 'utf8');
  } catch {
    return {
      configPath: file,
      removedProjects: [],
      keptProjects: []
    };
  }

  const removedProjects: string[] = [];
  const keptProjects: string[] = [];
  const pattern = new RegExp(
    `${escapeCleanupRegExp(CLEANUP_CODEX_BEGIN)}([^\\r\\n]+)\\r?\\n[\\s\\S]*?${escapeCleanupRegExp(CLEANUP_CODEX_END)}\\1\\r?\\n?`,
    'g'
  );
  const next = current.replace(pattern, (block, project: string) => {
    if (existingProjects.has(project)) {
      keptProjects.push(project);
      return block;
    }

    removedProjects.push(project);
    return '';
  });

  if (next !== current) {
    await fs.writeFile(file, collapseCleanupBlankLines(next), 'utf8');
  }

  return {
    configPath: file,
    removedProjects,
    keptProjects
  };
}

program
  .name('obsidian-project')
  .description(
    'Manage isolated Obsidian project vaults and a scoped local MCP server. With no subcommand, verifies CLIs, bootstraps config, and configures GitHub preferences.'
  )
  .version(packageJson.version)
  .showHelpAfterError()
  .option('--skip-github', 'Disable GitHub remotes in saved config (run "obsidian-project github" later)')
  .option('--owner <owner>', 'GitHub owner/org when enabling remotes')
  .option('--agent-skill', 'Install bundled Codex agent skills after checks (non-interactive; skips Y/n prompt)')
  .option('--port <port>', 'MCP preferred port (first-time setup; default 57891)')
  .option('--github-host <host>', 'GitHub hostname for gh and git remotes (default: github.com)');

program
  .command('add-common-vault')
  .description(
    'Register an existing common Obsidian vault (must contain .obsidian). After registration, finishes GitHub remote prefs (same as "github" subcommand); honors global --skip-github and --owner.'
  )
  .option('--path <path>', 'Path to the vault (omit to open folder picker on macOS/Windows)')
  .option('--name <name>', 'Logical name for this vault (default: derived from folder name)')
  .action(async (opts: Record<string, unknown>) => {
    const g = program.opts();
    await selectCommonVault({
      path: stringOption(opts.path),
      name: stringOption(opts.name),
      skipGithub: booleanOption(g.skipGithub),
      owner: stringOption(g.owner)
    });
  });

program
  .command('add-project-vault')
  .description(
    'Register an existing project Obsidian vault path. After registration, finishes GitHub remote prefs; honors global --skip-github and --owner.'
  )
  .option('--path <path>', 'Path to the vault (omit for folder picker on macOS/Windows)')
  .option('--name <name>', 'Project key (default: folder basename)')
  .action(async (opts: Record<string, unknown>) => {
    const g = program.opts();
    await addProjectVaultCommand({
      path: stringOption(opts.path),
      name: stringOption(opts.name),
      skipGithub: booleanOption(g.skipGithub),
      owner: stringOption(g.owner)
    });
  });

program
  .command('add-common-to-project')
  .description(
    'Link the registered common vault into <project>/common (interactive pickers, or pass --project and --common-path for scripts)'
  )
  .option('--project <name>', 'Registered project key (optional; use with --common-path when not interactive)')
  .option('--common-path <path>', 'Absolute path to the registered common vault (optional; use with --project when not interactive)')
  .action(async (opts: Record<string, unknown>) => {
    await addCommonToProjectCommand({
      project: stringOption(opts.project),
      commonPath: stringOption(opts.commonPath)
    });
  });

program
  .command('remove-common-from-project')
  .description('Remove the vault-root `common` symlink or junction from a project vault')
  .option('--project <name>', 'Registered project name')
  .option('--path <path>', 'Project vault path (infer project from registry)')
  .action(async (opts: Record<string, unknown>) => {
    await removeCommonFromProjectCommand({
      project: stringOption(opts.project),
      path: stringOption(opts.path)
    });
  });

program
  .command('github')
  .description('Show GitHub remote settings, or configure them (interactive if not set up)')
  .action(async () => {
    const opts = program.opts();
    const config = await loadConfig();
    await runGithubCommand(config, {
      skipGithub: booleanOption(opts.skipGithub),
      owner: stringOption(opts.owner)
    });
  });

program
  .command('agent-skill')
  .description('Install bundled Codex agent skills (MCP, Markdown, Bases, Canvas)')
  .action(async () => {
    const result = await installCodexSkill();
    console.log(formatCodexSkillLines(result));
  });

program
  .command('delete')
  .description('Commit and push latest local changes (when possible), then delete only the local project vault')
  .argument('<project>', 'Project name')
  .option('--skip-push', 'Commit but do not push before deleting locally')
  .action(async (project: string, opts: { skipPush?: boolean }) => {
    await deleteLocalProject(project, {
      skipPush: booleanOption(opts.skipPush)
    });
  });

program
  .command('list')
  .description('List configured Obsidian project vaults and folders')
  .action(async () => {
    await printProjectList();
  });

program
  .command('clean-up')
  .alias('cleanup')
  .description('Remove stale generated Codex config blocks for projects no longer present locally')
  .action(async () => {
    await cleanupCodexConfig();
  });

program
  .command('uninstall')
  .description('Remove obsidian-project config and uninstall the npm package')
  .action(async () => {
    await uninstallTool();
  });

program
  .command('start')
  .description('Start the persistent local MCP server')
  .option('--repair-mounts', 'Recreate common vault mounts without prompting')
  .action(async function (this: Command) {
    const opts = this.opts<{ repairMounts?: boolean }>();
    await startMcpServer({
      repairMounts: Boolean(opts.repairMounts)
    });
  });

program
  .command('stop')
  .description('Stop the persistent local MCP server')
  .action(async () => {
    await stopMcpServer();
  });

program
  .command('status')
  .description('Show MCP server status')
  .action(async () => {
    await printServerStatus();
  });

program
  .command('doctor')
  .description('Check external dependencies')
  .action(async () => {
    await runDoctor();
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
    console.log(`obsidian-project MCP server listening on 127.0.0.1:${options.port}`);
  });

program.hook('preAction', async (_thisCommand, actionCommand) => {
  const argv = process.argv;
  if (argv.includes('--help') || argv.includes('-h') || argv.includes('--version') || argv.includes('-V')) {
    return;
  }
  const name = actionCommand.name();
  if (name === 'uninstall' || name === 'serve') {
    return;
  }
  const opts = program.opts();
  await ensureCliBootstrapIfNeeded({
    skipGithub: booleanOption(opts.skipGithub),
    githubOwner: stringOption(opts.owner),
    preferredPort: numberOption(opts.port),
    githubHost: stringOption(opts.githubHost)
  });
});

program.action(async () => {
  const opts = program.opts();
  await initConfig({
    skipGithub: booleanOption(opts.skipGithub),
    githubOwner: stringOption(opts.owner),
    agentSkill: booleanOption(opts.agentSkill),
    preferredPort: numberOption(opts.port),
    githubHost: stringOption(opts.githubHost)
  });
});

program.parseAsync(process.argv).catch(error => {
  console.error(errorMessage(error));
  process.exit(error instanceof UserError ? 2 : 1);
});

/** Prompt for a single line (trimmed). */
async function confirm(question: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    return (await rl.question(`${question}: `)).trim();
  } finally {
    rl.close();
  }
}

/** Commit, push, and delete a project vault after the user types the project name. */
async function deleteLocalProject(project: string, options: { skipPush?: boolean }): Promise<void> {
  const config = await loadConfig();
  const confirmed = await confirm(`Delete local vault for "${project}" after committing and pushing latest changes? Type the project name to confirm`);
  if (confirmed !== project) {
    throw new UserError('Delete cancelled.');
  }

  const result = await deleteProject(config, project, { skipPush: options.skipPush });
  console.log(`Deleted local vault: ${displayPath(result.deletedPath)}`);
  console.log(`Committed latest changes: ${result.committed ? 'yes' : 'no changes'}`);
  console.log(`Pushed to origin: ${result.pushed ? 'yes' : options.skipPush ? 'skipped' : 'no remote'}`);
}

/** Print all registered vaults and key folder symlink status. */
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
    console.log(`  Vault: ${displayPath(item.vaultPath)}`);
    for (const folder of item.folders) {
      const state = folder.exists ? (folder.linked ? 'linked' : 'exists') : 'missing';
      const target = folder.target ? ` -> ${displayPath(folder.target)}` : '';
      console.log(`  - ${folder.label}: ${state} ${displayPath(folder.path)}${target}`);
    }
  }
}

/** Drop stale Codex profile blocks for projects no longer present locally. */
async function cleanupCodexConfig(): Promise<void> {
  const config = await loadConfig();
  const existingProjects = await existingProjectNameSet(config);
  const result = await cleanupCodexProjectProfiles(config, existingProjects);
  console.log(`Codex config: ${displayPath(result.configPath)}`);
  console.log(`Existing projects: ${existingProjects.size ? [...existingProjects].join(', ') : 'none'}`);
  console.log(`Removed stale profiles: ${result.removedProjects.length ? result.removedProjects.join(', ') : 'none'}`);
}

/** Remove app config, Codex snippets, stop server, and uninstall the global npm package. */
async function uninstallTool(): Promise<void> {
  const confirmed = await confirm(
    'Uninstall obsidian-project? This removes generated Codex config and obsidian-project app config, but leaves vaults, links, and Git repos untouched. Type "uninstall" to confirm'
  );
  if (confirmed !== 'uninstall') {
    throw new UserError('Uninstall cancelled.');
  }

  const result = await uninstallProjectTool();
  console.log(`Codex config cleaned: ${displayPath(result.codexConfigPath)}`);
  console.log(`Removed Codex profiles: ${result.removedCodexProjects.length ? result.removedCodexProjects.join(', ') : 'none'}`);
  console.log(
    `Removed app config paths: ${result.removedPaths.length ? result.removedPaths.map(displayPath).join(', ') : 'none'}`
  );
  console.log(`MCP server stopped: ${result.serverStopped ? 'yes' : 'not running'}`);
  console.log('npm package removed: yes');
  console.log('Vaults, common mounts, and Git repositories were left untouched.');
}

/** Load config, optionally repair mounts, spawn MCP HTTP server if needed. */
async function startMcpServer(options: { repairMounts?: boolean } = {}): Promise<void> {
  const config = await loadConfig();
  await ensureMountsBeforeServerStart(config, options);
  const result = await startServer(config);
  console.log(result.alreadyRunning ? 'MCP server already running.' : 'MCP server started.');
  console.log(`URL: http://${result.state.host}:${result.state.port}/mcp`);
  console.log(`PID: ${result.state.pid}`);
  console.log(`Obsidian: ${result.obsidianVersion}`);
  console.log(`GitHub account: ${result.account.login}${result.account.name ? ` (${result.account.name})` : ''}`);
  console.log(`Log: ${displayPath(serverLogPath())}`);
}

/** Stop the background MCP process using saved state. */
async function stopMcpServer(): Promise<void> {
  const stopped = await stopServer();
  console.log(stopped ? 'MCP server stopped.' : 'MCP server is not running.');
}

/** Print saved server URL/pid or that nothing is running. */
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

/** Verify external CLIs, print config paths, and where `obsidian-project` is on PATH. */
async function runDoctor(): Promise<void> {
  const obsidianVersion = await assertObsidianCliReady();
  let ghHost: string | undefined;
  if (await configExists()) {
    try {
      ghHost = (await readPersistedConfig()).github.hostname;
    } catch {
      ghHost = undefined;
    }
  }
  const account = await assertGhReady(ghHost);
  if (await configExists()) {
    try {
      await loadConfig();
      console.log(`Config: ${displayPath(configPath())}`);
      console.log(`Default vault parent: ${displayPath(defaultVaultParentDirectory())}`);
    } catch {
      console.log(`Config: ${displayPath(configPath())} (invalid or incomplete—fix config.json or re-run setup)`);
    }
  } else {
    console.log('obsidian-project is not configured yet. Run any obsidian-project command to create config and finish setup.');
  }
  console.log(`Obsidian CLI: ${obsidianVersion}`);
  console.log(`GitHub CLI account: ${account.login}${account.name ? ` (${account.name})` : ''}`);

  const shell = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
  const flag = process.platform === 'win32' ? '/c' : '-lc';
  const script = process.platform === 'win32' ? 'where obsidian-project 2>nul' : 'command -v obsidian-project 2>/dev/null || true';
  const which = spawnSync(shell, [flag, script], { encoding: 'utf8' });
  const line = which.stdout?.trim().split(/\r?\n/).filter(Boolean)[0];
  if (line) {
    console.log(`obsidian-project executable: ${line}`);
  } else {
    console.log('obsidian-project executable: not found on PATH');
    console.log(`Typical global npm bin directory: ${globalNpmBinHint()}`);
  }
}

/** Coerce unknown CLI option to string or undefined. */
function stringOption(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Coerce unknown CLI option to boolean or undefined. */
function booleanOption(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Coerce unknown CLI option to a finite number or undefined. */
function numberOption(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}
