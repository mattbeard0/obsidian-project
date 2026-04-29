import { UserError } from '../errors.js';
import { runCommand, runRequired } from '../platform/command.js';

export interface GitHubAccount {
  login: string;
  name?: string;
}

export async function assertGhReady(): Promise<GitHubAccount> {
  const version = await runCommand('gh', ['--version'], { timeoutMs: 10_000 });
  if (version.code !== 0) {
    throw new UserError('GitHub CLI (gh) is not installed or not in PATH.');
  }

  const auth = await runCommand('gh', ['auth', 'status'], { timeoutMs: 30_000 });
  if (auth.code !== 0) {
    throw new UserError('GitHub CLI is installed but not logged in. Run "gh auth login" first.');
  }

  const user = await runRequired('gh', ['api', 'user', '--jq', '.login + "|" + (.name // "")'], {
    timeoutMs: 30_000
  });
  const [login, name] = user.stdout.trim().split('|');
  return { login, name: name || undefined };
}

export async function createGitHubRepo(options: {
  owner?: string;
  repoName: string;
  cwd: string;
  visibility: 'private' | 'public' | 'internal';
}): Promise<void> {
  const fullName = options.owner ? `${options.owner}/${options.repoName}` : options.repoName;
  const existing = await runCommand('gh', ['repo', 'view', fullName, '--json', 'name'], { timeoutMs: 30_000 });
  if (existing.code === 0) {
    await ensureOrigin(options.cwd, fullName);
    return;
  }

  const visibilityFlag = options.visibility === 'public' ? '--public' : options.visibility === 'internal' ? '--internal' : '--private';
  await runRequired(
    'gh',
    ['repo', 'create', fullName, visibilityFlag, '--source', options.cwd, '--remote', 'origin', '--disable-wiki'],
    { timeoutMs: 120_000 }
  );
}

export async function ensureOrigin(cwd: string, fullName: string): Promise<void> {
  const desired = `https://github.com/${fullName}.git`;
  const current = await runCommand('git', ['remote', 'get-url', 'origin'], { cwd, timeoutMs: 10_000 });
  if (current.code === 0) {
    return;
  }

  await runRequired('git', ['remote', 'add', 'origin', desired], { cwd, timeoutMs: 10_000 });
}

export async function createPullRequest(cwd: string, title: string, body: string): Promise<string> {
  const result = await runRequired('gh', ['pr', 'create', '--title', title, '--body', body], {
    cwd,
    timeoutMs: 120_000
  });

  return result.stdout.trim();
}

export async function findPullRequestForBranch(cwd: string, branch: string): Promise<string | undefined> {
  const result = await runCommand('gh', ['pr', 'view', branch, '--json', 'url', '--jq', '.url'], {
    cwd,
    timeoutMs: 30_000
  });

  if (result.code !== 0) {
    return undefined;
  }

  return result.stdout.trim() || undefined;
}
