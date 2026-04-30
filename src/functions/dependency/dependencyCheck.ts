import { UserError } from '../errors.js';
import { missingExecutableMessage } from '../platform/missingExecutableHint.js';
import { envWithGithubHost, runCommand, runRequired } from '../platform/shell.js';

// --- GitHub CLI (gh) ---

export interface GitHubAccount {
  login: string;
  name?: string;
}

/** Verifies `gh` is installed, authenticated, and returns the logged-in GitHub user (respects Enterprise host via env). */
export async function assertGhReady(githubHostname?: string): Promise<GitHubAccount> {
  const env = envWithGithubHost(githubHostname);
  const version = await runCommand('gh', ['--version'], { timeoutMs: 10_000, env });
  if (version.code !== 0) {
    throw new UserError(missingExecutableMessage('gh'));
  }

  const auth = await runCommand('gh', ['auth', 'status'], { timeoutMs: 30_000, env });
  if (auth.code !== 0) {
    throw new UserError('GitHub CLI is installed but not logged in. Run "gh auth login" first.');
  }

  const user = await runRequired('gh', ['api', 'user', '--jq', '.login + "|" + (.name // "")'], {
    timeoutMs: 30_000,
    env
  });
  const [login, name] = user.stdout.trim().split('|');
  return { login, name: name || undefined };
}

/** Verifies the Obsidian CLI is available and returns its version string from stdout. */
export async function assertObsidianCliReady(): Promise<string> {
  const version = await runCommand('obsidian', ['version'], { timeoutMs: 30_000 });
  if (version.code !== 0) {
    throw new UserError(missingExecutableMessage('obsidian'));
  }

  return version.stdout.trim();
}
