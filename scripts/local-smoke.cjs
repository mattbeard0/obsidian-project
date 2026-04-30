const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-project-local-'));
const npmPrefix = path.join(tempRoot, 'npm-prefix');
const configDir = path.join(tempRoot, '.obsidian-project');
const stateDir = path.join(tempRoot, '.obsidian-project-state');
const codexHome = path.join(tempRoot, 'codex');
const vaultRoot = path.join(tempRoot, 'vaults');
const projectName = 'project-1';

const env = {
  ...process.env,
  NPM_CONFIG_PREFIX: npmPrefix,
  OBSIDIAN_PROJECT_CONFIG_DIR: configDir,
  OBSIDIAN_PROJECT_STATE_DIR: stateDir,
  CODEX_HOME: codexHome,
  /** Isolated default vault parent (replaces removed config.json vaultRoot for tests). */
  OBSIDIAN_PROJECT_VAULT_PARENT: vaultRoot,
  OBSIDIAN_PROJECT_SKIP_POSTINSTALL: '1',
  /** Lets automated smoke run without Obsidian CLI / gh on PATH (doctor step still probes real CLIs). */
  OBSIDIAN_PROJECT_SKIP_EXTERNAL_CLI_CHECKS: '1',
  GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'obsidian-project local test',
  GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'obsidian-project@example.invalid',
  GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || 'obsidian-project local test',
  GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || 'obsidian-project@example.invalid'
};

let packedTarball;

try {
  printTopLevelCliWarning();

  step('build (pack uses dist/; must match current source)');
  runNpm(['run', 'build'], { cwd: repoRoot });

  step('pack npm package');
  packedTarball = runNpm(['pack', '--silent'], { cwd: repoRoot }).trim().split(/\r?\n/).pop();
  const tarballPath = path.join(repoRoot, packedTarball);
  assert(fs.existsSync(tarballPath), `Expected tarball to exist: ${tarballPath}`);

  step('install package into temporary npm prefix');
  runNpm(['install', '-g', '--prefix', npmPrefix, tarballPath], { cwd: repoRoot });

  const installed = installedCliPaths(npmPrefix);
  assert(fs.existsSync(installed.shim), `Expected installed CLI shim to exist: ${installed.shim}`);
  assert(fs.existsSync(installed.script), `Expected installed CLI script to exist: ${installed.script}`);

  step('run installed CLI');
  assert(runCli(installed, ['--version']).trim() === require('../package.json').version, 'Installed CLI version mismatch.');
  assert(runCli(installed, ['--help']).includes('new') && runCli(installed, ['--help']).includes('<project>'), 'Installed CLI help should document new <project>.');

  step('initialize isolated config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'vault-config.json'),
    `${JSON.stringify(
      {
        version: 1,
        folderStructure: {
          attachments: '_smoke_a',
          noteLibrary: '_smoke_b',
          publish: '_smoke_c',
          projectScope: '_smoke_d',
          sharedScope: '_smoke_e'
        }
      },
      null,
      2
    )}\n`,
    'utf8'
  );

  step('bootstrap with no subcommand (non-interactive flags)');
  const bootstrapOut = runCli(installed, ['--non-interactive', '--skip-github']);
  assert(bootstrapOut.includes('Init finished'), 'Default command should run bootstrap (Init finished).');
  assertFile(path.join(configDir, 'config.json'));
  const afterBootstrap = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'));
  assert(
    afterBootstrap.cliBootstrap && afterBootstrap.cliBootstrap.preferredPort,
    'First-time setup should persist cliBootstrap in config.'
  );

  step('github subcommand');
  assert(runCli(installed, ['--help']).includes('github'), 'Installed CLI help should document github.');
  const ghOut = runCli(installed, ['--skip-github', 'github']);
  assert(ghOut.includes('GitHub (obsidian-project):'), 'github should print config header.');
  assert(ghOut.includes('GitHub remote creation is disabled.'), 'github --skip-github should confirm remotes disabled.');

  step('agent-skill');
  assert(runCli(installed, ['--help']).includes('agent-skill'), 'help should document agent-skill.');
  const skillOut = runCli(installed, ['agent-skill']);
  assert(skillOut.includes(path.join(configDir, 'skills')), 'agent-skill should print canonical skills root.');
  assert(skillOut.includes(path.join(codexHome, 'skills')), 'agent-skill should print codex skills root.');
  for (const dir of ['obsidian-project-mcp', 'obsidian-markdown', 'obsidian-bases', 'json-canvas']) {
    assert(
      fs.existsSync(path.join(configDir, 'skills', dir, 'SKILL.md')),
      `SKILL.md should exist for ${dir} under isolated config.`
    );
  }

  step('verify project creation waits for common vault');
  const prematureNew = spawn(process.execPath, [installed.script, 'new', projectName]);
  assert(prematureNew.status !== 0, 'Project creation should fail before common vault is configured.');
  const preNewOut = `${prematureNew.stdout}\n${prematureNew.stderr}`;
  assert(
    /common vault|add-common|create-common/i.test(preNewOut),
    `Expected project creation failure to mention configuring a common vault; got:\n${preNewOut}`
  );

  step('register an existing common vault (must contain .obsidian)');
  const externalCommon = path.join(tempRoot, 'external-common');
  fs.mkdirSync(path.join(externalCommon, '.obsidian'), { recursive: true });
  const gitCommon = spawnSync('git', ['init'], { cwd: externalCommon, env, encoding: 'utf8' });
  assert(gitCommon.status === 0, `git init in common vault failed: ${gitCommon.stderr || gitCommon.stdout}`);
  runCli(installed, ['add-common-vault', '--path', externalCommon, '--name', 'common']);

  step('create isolated project vault');
  runCli(installed, ['new', projectName]);

  const commonVault = externalCommon;
  const projectVault = path.join(vaultRoot, `obsidian-vault-${projectName}`);
  const commonMount = path.join(projectVault, '_smoke_b', '_smoke_e');
  const codexConfig = path.join(codexHome, 'config.toml');

  assertDir(commonVault);
  assertDir(projectVault);
  assertPath(commonMount);
  assertDir(path.join(commonVault, '.git'));
  assertDir(path.join(projectVault, '.git'));
  assertFile(path.join(projectVault, '.obsidian-project.json'));
  assertFile(path.join(projectVault, '.obsidian-project', 'codex-instructions.md'));
  assertFile(codexConfig);

  step('list isolated project vaults');
  const listOutput = runCli(installed, ['list']);
  assert(listOutput.includes('Common: common'), 'Expected list output to include the common vault.');
  assert(listOutput.includes(`Project: ${projectName}`), 'Expected list output to include the project vault.');
  assert(listOutput.includes('common mount:'), 'Expected list output to include the common vault mount row.');

  const codexText = fs.readFileSync(codexConfig, 'utf8');
  assert(codexText.includes('[profiles.project-1.mcp_servers.obsidian-notes]'), 'Codex MCP server block missing.');
  assert(codexText.includes('"x-obsidian-project" = "project-1"'), 'Codex project header missing.');
  assert(codexText.includes('[profiles.project-1]'), 'Codex profile block missing.');

  step('show local status command');
  assert(runCli(installed, ['status']).includes('MCP server is not running.'), 'Expected status to report stopped server.');

  step('delete isolated project vault');
  runCli(installed, ['delete', projectName, '--yes', '--skip-push']);
  assert(!fs.existsSync(projectVault), 'Project vault should be deleted locally.');
  assert(fs.existsSync(commonVault), 'Common vault should remain after project delete.');

  step('clean stale Codex config');
  const cleanupOutput = runCli(installed, ['clean-up']);
  assert(cleanupOutput.includes(`Removed stale profiles: ${projectName}`), 'Expected cleanup to remove the deleted project profile.');
  const cleanedCodexText = fs.readFileSync(codexConfig, 'utf8');
  assert(!cleanedCodexText.includes('[profiles.project-1.mcp_servers.obsidian-notes]'), 'Codex MCP server block should be removed.');
  assert(!cleanedCodexText.includes('[profiles.project-1]'), 'Codex profile block should be removed.');

  step('external dependency probe');
  const doctor = spawn(process.execPath, [installed.script, 'doctor']);
  if (doctor.status === 0) {
    log('doctor passed: Obsidian CLI and GitHub CLI are installed and ready.');
    log(indent(doctor.stdout.trim()));
  } else {
    log('doctor did not pass. This does not fail the local package smoke suite.');
    log('The package install, vault creation, Git repos, Codex profile generation, and delete flow already passed.');
    log('');
    log('To use "obsidian-project start" and the MCP server, install and configure both external CLIs:');
    log('  - Obsidian CLI: install Obsidian desktop 1.12.7+, enable Settings > General > Command line interface, then verify "obsidian version". https://obsidian.md/cli');
    log('  - GitHub CLI: install gh (https://cli.github.com/), run "gh auth login", then verify "gh auth status".');
    log('');
    log('doctor output:');
    log(indent((doctor.stderr || doctor.stdout || '').trim() || '(no output)'));
  }

  step('clean uninstall (config + package from isolated npm prefix)');
  const uninstallOutput = runCli(installed, ['uninstall', '--yes']);
  assert(uninstallOutput.includes('Vaults, common mounts, and Git repositories were left untouched.'), 'Expected uninstall safety message.');
  assert(!fs.existsSync(path.join(configDir, 'config.json')), 'Config file should be removed by uninstall.');
  assert(fs.existsSync(commonVault), 'Common vault should remain after uninstall.');

  log('local smoke suite passed');
} finally {
  if (packedTarball) {
    fs.rmSync(path.join(repoRoot, packedTarball), { force: true });
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function installedCliPaths(prefix) {
  const packageDir =
    process.platform === 'win32'
      ? path.join(prefix, 'node_modules', 'obsidian-project-cli')
      : path.join(prefix, 'lib', 'node_modules', 'obsidian-project-cli');
  const shim = process.platform === 'win32' ? path.join(prefix, 'obsidian-project.cmd') : path.join(prefix, 'bin', 'obsidian-project');

  return {
    shim,
    script: path.join(packageDir, 'dist', 'cli', 'index.js')
  };
}

function runCli(installed, args) {
  return run(process.execPath, [installed.script, ...args]);
}

function runNpm(args, options = {}) {
  if (process.env.npm_execpath) {
    return run(process.execPath, [process.env.npm_execpath, ...args], options);
  }

  return run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, options);
}

function step(message) {
  log(`> ${message}`);
}

function printTopLevelCliWarning() {
  log('obsidian-project local test prerequisites');
  log('Global npm installs are blocked unless both external CLIs are installed:');
  log('  - Obsidian CLI: required because the MCP server wraps the real "obsidian" command.');
  log('  - GitHub CLI: required because common-note updates use "gh" to create PRs.');
  log('');
  log('This local smoke suite sets OBSIDIAN_PROJECT_SKIP_POSTINSTALL=1 during its temporary npm install.');
  log('That bypass lets package/vault behavior be tested on CI and fresh machines, then a doctor probe checks the real CLI state at the end.');
  log('');
}

function log(message) {
  console.log(message);
}

function indent(text) {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => `  ${line}`)
    .join('\n');
}

function run(command, args, options = {}) {
  const result = spawn(command, args, {
    cwd: options.cwd || repoRoot,
    env,
    encoding: 'utf8',
    shell: false,
    windowsHide: true
  });

  if (result.status !== 0) {
    throw new Error(
      [
        `Command failed: ${command} ${args.join(' ')}`,
        `status: ${result.status}`,
        result.error && `error:\n${result.error.message}`,
        result.stdout && `stdout:\n${result.stdout}`,
        result.stderr && `stderr:\n${result.stderr}`
      ]
        .filter(Boolean)
        .join('\n')
    );
  }

  return result.stdout;
}

function spawn(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env,
    encoding: 'utf8',
    shell: false,
    windowsHide: true
  });
}

function assert(value, message) {
  if (!value) {
    throw new Error(message);
  }
}

function assertPath(target) {
  assert(fs.existsSync(target), `Expected path to exist: ${target}`);
}

function assertFile(target) {
  assertPath(target);
  assert(fs.statSync(target).isFile(), `Expected file: ${target}`);
}

function assertDir(target) {
  assertPath(target);
  assert(fs.statSync(target).isDirectory(), `Expected directory: ${target}`);
}
