const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const isGlobalInstall = process.env.npm_config_global === 'true' || process.env.npm_config_global === '1';
const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const cli = path.resolve(__dirname, '..', 'dist', 'cli', 'index.js');

if (process.env.OBSIDIAN_PROJECT_SKIP_POSTINSTALL === '1' || !isGlobalInstall || !fs.existsSync(cli)) {
  process.exit(0);
}

printPrerequisiteHeader();
const missing = checkInstallPrerequisites();
if (missing.length > 0) {
  process.stderr.write('\nobsidian-project install cannot continue.\n');
  process.stderr.write('Install and enable the required CLIs, then rerun npm install.\n\n');
  for (const item of missing) {
    process.stderr.write(`- ${item}\n`);
  }
  process.stderr.write('\n');
  process.exit(1);
}

if (!isInteractive) {
  process.stderr.write(
    'Required CLIs found. obsidian-project installed. Rerun with "--foreground-scripts" for install-time configuration, or run "obsidian-project init".\n'
  );
  process.exit(0);
}

spawnSync(process.execPath, [cli, 'init', '--if-missing'], {
  stdio: 'inherit'
});

function printPrerequisiteHeader() {
  process.stderr.write('\nobsidian-project install prerequisites\n');
  process.stderr.write('This package requires two external CLIs before global npm install can complete:\n');
  process.stderr.write('- Obsidian CLI: the MCP server wraps the real "obsidian" command.\n');
  process.stderr.write('- GitHub CLI: common-note updates use "gh" to create PRs.\n\n');
}

function checkInstallPrerequisites() {
  const missing = [];
  const obsidian = run('obsidian', ['version']);
  if (obsidian.status !== 0) {
    missing.push(
      'Obsidian CLI was not found or is not enabled. Install Obsidian desktop 1.12.7+, enable Settings > General > Command line interface, then verify "obsidian version".'
    );
  }

  const gh = run('gh', ['--version']);
  if (gh.status !== 0) {
    missing.push('GitHub CLI was not found. Install gh, then verify "gh --version".');
  }

  return missing;
}

function run(command, args) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    shell: false,
    windowsHide: true
  });
}
