const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const isGlobalInstall = process.env.npm_config_global === 'true' || process.env.npm_config_global === '1';
const cli = path.resolve(__dirname, '..', 'dist', 'cli', 'index.js');

if (process.env.OBSIDIAN_PROJECT_SKIP_POSTINSTALL === '1' || !isGlobalInstall || !fs.existsSync(cli)) {
  process.exit(0);
}

printPrerequisiteHeader();
const missing = checkInstallPrerequisites();
if (missing.length > 0) {
  process.stderr.write('\nobsidian-project was installed, but required CLIs are missing or not on PATH.\n');
  process.stderr.write('The global command is available; fix the items below before running start or doctor.\n\n');
  for (const item of missing) {
    process.stderr.write(`- ${item}\n`);
  }
  process.stderr.write('\nAfter installing, run: obsidian-project doctor\n\n');
}

process.exit(0);

function printPrerequisiteHeader() {
  process.stderr.write('\nobsidian-project install prerequisites\n');
  process.stderr.write('This package expects two external CLIs for full functionality:\n');
  process.stderr.write('- Obsidian CLI: the MCP server wraps the real "obsidian" command.\n');
  process.stderr.write('- GitHub CLI: common-note updates use "gh" to create PRs.\n\n');
}

function checkInstallPrerequisites() {
  const missing = [];
  const obsidian = run('obsidian', ['version']);
  if (obsidian.status !== 0) {
    missing.push(
      'Obsidian CLI was not found or is not enabled. Install Obsidian desktop 1.12.7+, enable Settings > General > Command line interface, then verify "obsidian version". See https://obsidian.md/cli'
    );
  }

  const gh = run('gh', ['--version']);
  if (gh.status !== 0) {
    missing.push(
      'GitHub CLI was not found. Install gh, then verify "gh --version". See https://cli.github.com/'
    );
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
