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
  const helpOut = runCli(installed, ['--help']);
  assert(
    helpOut.includes('add-common-vault') && helpOut.includes('add-project-vault'),
    'Installed CLI help should document vault registration commands.'
  );

  step('initialize isolated config');
  fs.mkdirSync(configDir, { recursive: true });

  step('bootstrap with no subcommand (non-interactive flags)');
  const bootstrapOut = runCli(installed, ['--skip-github']);
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

  step('verify add-common-to-project waits for common vault');
  const prematureLink = spawn(process.execPath, [installed.script, 'add-common-to-project']);
  assert(prematureLink.status !== 0, 'Linking should fail before common vault is configured.');
  const preLinkOut = `${prematureLink.stdout}\n${prematureLink.stderr}`;
  assert(
    /common vault|add-common/i.test(preLinkOut),
    `Expected link failure to mention configuring a common vault; got:\n${preLinkOut}`
  );

  step('register an existing common vault (must contain .obsidian)');
  const externalCommon = path.join(tempRoot, 'external-common');
  fs.mkdirSync(path.join(externalCommon, '.obsidian'), { recursive: true });
  runCli(installed, ['--skip-github', 'add-common-vault', '--path', externalCommon, '--name', 'common']);

  step('create isolated project vault');
  const projectVault = path.join(vaultRoot, `obsidian-vault-${projectName}`);
  fs.mkdirSync(path.join(projectVault, '.obsidian'), { recursive: true });
  runCli(installed, ['--skip-github', 'add-project-vault', '--path', projectVault, '--name', projectName]);
  runCli(installed, ['add-common-to-project', '--project', projectName, '--common-path', externalCommon]);

  const commonVault = externalCommon;
  const commonMount = path.join(projectVault, 'common');

  assertDir(commonVault);
  assertDir(projectVault);
  assertPath(commonMount);
  assertDir(path.join(commonVault, '.git'));
  assertDir(path.join(projectVault, '.git'));

  step('list isolated project vaults');
  const listOutput = runCli(installed, ['list']);
  assert(listOutput.includes('Common: common'), 'Expected list output to include the common vault.');
  assert(listOutput.includes(`Project: ${projectName}`), 'Expected list output to include the project vault.');
  assert(listOutput.includes('common mount:'), 'Expected list output to include the common vault mount row.');

  step('show local status command');
  assert(runCli(installed, ['status']).includes('MCP server is not running.'), 'Expected status to report stopped server.');

  step('delete isolated project vault');
  const del = spawnSync(process.execPath, [installed.script, 'delete', projectName, '--skip-push'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    input: `${projectName}\n`
  });
  assert(del.status === 0, `delete failed: ${del.stderr || del.stdout}`);
  assert(!fs.existsSync(projectVault), 'Project vault should be deleted locally.');
  assert(fs.existsSync(commonVault), 'Common vault should remain after project delete.');

  step('clean stale Codex config');
  const cleanupOutput = runCli(installed, ['clean-up']);
  assert(cleanupOutput.includes('Removed stale profiles:'), 'Expected cleanup to report stale profile removal line.');

  step('external dependency probe');
  const doctor = spawn(process.execPath, [installed.script, 'doctor']);
  if (doctor.status === 0) {
    log('doctor passed: Obsidian CLI and GitHub CLI are installed and ready.');
    log(indent(doctor.stdout.trim()));
  } else {
    log('doctor did not pass. This does not fail the local package smoke suite.');
    log('The package install, vault creation, Git repos, and delete flow already passed.');
    log('');
    log('To use "obsidian-project start" and the MCP server, install and configure both external CLIs:');
    log('  - Obsidian CLI: install Obsidian desktop 1.12.7+, enable Settings > General > Command line interface, then verify "obsidian version". https://obsidian.md/cli');
    log('  - GitHub CLI: install gh (https://cli.github.com/), run "gh auth login", then verify "gh auth status".');
    log('');
    log('doctor output:');
    log(indent((doctor.stderr || doctor.stdout || '').trim() || '(no output)'));
  }

  step('clean uninstall (config + package from isolated npm prefix)');
  const un = spawnSync(process.execPath, [installed.script, 'uninstall'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    input: `uninstall\n`
  });
  assert(un.status === 0, `uninstall failed: ${un.stderr || un.stdout}`);
  const uninstallOutput = `${un.stdout}\n${un.stderr}`;
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
  const result = spawnSync(command, args, {
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
